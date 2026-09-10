#!/usr/bin/env node
/**
 * Recover sessions stranded in the retired index (TP-41).
 *
 * TP-23 rebuilt the session index at a new path by re-deriving from the
 * transcripts on disk. That is correct for everything Claude Code still has,
 * and it silently drops everything it has pruned: 19 sessions whose transcript
 * files no longer exist and which therefore cannot be re-derived from anything.
 *
 * This copies those sessions, and only those, from the old database into the
 * new one. It is idempotent and re-runnable.
 *
 * It also declares every row it writes in `preserved_row`, so a later
 * `miner refresh --full` puts them back rather than erasing them. That table is
 * outside both resets and `replayPreserved` runs at the end of every pass, so
 * this script no longer has to be re-run after a rebuild — which is what its
 * first version had to say here (TP-24).
 *
 * What it cannot recover: FTS text. Both span tables are contentless — the
 * file is normally the only copy of its own content — and these files are
 * gone. So these sessions are readable and countable but not searchable, and
 * no amount of preservation changes that.
 *
 * Usage: node backfill-pruned-sessions.mjs [--apply]   (dry run by default)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';

const MINER = path.join(os.homedir(), 'Library/Application Support/active-work/.miner');
const OLD = path.join(MINER, 'index.sqlite3');
const NEW = path.join(MINER, 'graph.sqlite3');
const apply = process.argv.includes('--apply');

const old = new Database(OLD, { readonly: true });
const graph = new Database(NEW, { readonly: !apply });

/**
 * Sessions the rebuild cannot reach, because every transcript that produced
 * them is gone from disk.
 *
 * Defined by what is *derivable*, not by what the new index happens to hold
 * today. The two agree on a fresh graph and diverge after a manual recovery:
 * the rows are already present but not yet declared non-derivable, and an
 * "is it missing from the new index" test would skip precisely the rows that
 * most need declaring. Every write below is insert-if-absent, so running this
 * over rows that are already there costs nothing and registers them.
 */
function strandedSessionIds() {
  const rows = old
    .prepare(
      `SELECT f.session_id AS session_id, t.path AS path
         FROM facts f JOIN transcripts t ON t.transcript_id = f.transcript_id
        GROUP BY f.session_id, t.path`,
    )
    .all();
  const derivable = new Set();
  const seen = new Set();
  for (const row of rows) {
    seen.add(row.session_id);
    if (existsSync(row.path.replace(/^~/, os.homedir()))) derivable.add(row.session_id);
  }
  return [...seen].filter((id) => !derivable.has(id)).sort();
}

const ids = strandedSessionIds();
if (ids.length === 0) {
  console.log('nothing stranded; every session in the old index is still derivable from disk');
  process.exit(0);
}
const q = ids.map(() => '?').join(',');

/**
 * Old transcript ids for the stranded sessions, mapped to rows in the new
 * `transcript` table. Marked `missing`, because that is what they are: the
 * watermark table's whole purpose is to remember a source that has gone.
 */
function remapTranscripts() {
  const rows = old
    .prepare(`SELECT DISTINCT t.transcript_id, t.path, t.last_byte_offset, t.prefix_hash, t.file_size, t.file_mtime, t.content_hash
              FROM transcripts t JOIN facts f ON f.transcript_id = t.transcript_id WHERE f.session_id IN (${q})`)
    .all(...ids);
  const map = new Map();
  const find = graph.prepare('SELECT source_id FROM transcript WHERE source_key = ?');
  const insert = apply
    ? graph.prepare(`INSERT INTO transcript (source_key, last_offset, prefix_hash, file_size, file_mtime, content_hash, status, status_reason)
                     VALUES (@path, @lastOffset, @prefixHash, @fileSize, @fileMtime, @contentHash, 'missing', 'pruned before TP-23 rebuilt the index (TP-41)')`)
    : null;
  for (const r of rows) {
    const existing = find.get(r.path);
    if (existing) {
      map.set(r.transcript_id, existing.source_id);
      continue;
    }
    if (!apply) {
      map.set(r.transcript_id, -1);
      continue;
    }
    const info = insert.run({
      path: r.path,
      lastOffset: r.last_byte_offset,
      prefixHash: r.prefix_hash,
      fileSize: r.file_size,
      fileMtime: r.file_mtime,
      contentHash: r.content_hash,
    });
    map.set(r.transcript_id, Number(info.lastInsertRowid));
  }
  return { map, transcripts: rows.length };
}

const ORIGIN = 'recovered from the retired index.sqlite3; transcript pruned by Claude Code (TP-41)';

/**
 * Declare a row non-derivable, so `replayPreserved` puts it back after a reset.
 *
 * `row_key` only has to be unique within its table, so a synthetic key from the
 * natural one is enough. `identity` is a different thing: the replay matches
 * those columns against the live table to decide whether derivation already
 * produced the row, so they must be columns a rebuild would reproduce.
 */
const preserveStmt = apply
  ? graph.prepare(`INSERT INTO preserved_row (table_name, identity, row_key, payload, origin, mode)
                   VALUES (@table, @identity, @key, @payload, '${ORIGIN}', 'insert')
                   ON CONFLICT (table_name, row_key) DO UPDATE SET payload = excluded.payload`)
  : null;

function preserve(table, identity, key, payload) {
  if (!apply) return;
  preserveStmt.run({
    table,
    identity: JSON.stringify(identity),
    key: String(key),
    payload: JSON.stringify(payload),
  });
}

/** Copy rows whose columns are identical between the two schemas. */
function copyBySession(fromTable, toTable, columns, identity, keyOf) {
  const cols = columns.join(', ');
  const rows = old.prepare(`SELECT ${cols} FROM ${fromTable} WHERE session_id IN (${q})`).all(...ids);
  if (!apply || rows.length === 0) return rows.length;
  const placeholders = columns.map((c) => `@${c}`).join(', ');
  const insert = graph.prepare(`INSERT OR IGNORE INTO ${toTable} (${cols}) VALUES (${placeholders})`);
  for (const row of rows) {
    insert.run(row);
    preserve(toTable, identity, keyOf(row), row);
  }
  return rows.length;
}

function run() {
  const { map, transcripts } = remapTranscripts();

  const facts = old.prepare(`SELECT transcript_id, byte_offset, byte_length, event_type, ts, seq, session_id, prompt_id, tool_use_id
                             FROM facts WHERE session_id IN (${q})`).all(...ids);
  if (apply) {
    const insert = graph.prepare(`INSERT OR IGNORE INTO fact (transcript_id, byte_offset, byte_length, event_type, ts, seq, session_id, prompt_id, tool_use_id)
                                  VALUES (@transcript_id, @byte_offset, @byte_length, @event_type, @ts, @seq, @session_id, @prompt_id, @tool_use_id)`);
    for (const f of facts) {
      const row = { ...f, transcript_id: map.get(f.transcript_id) };
      insert.run(row);
      preserve('fact', ['transcript_id', 'byte_offset'], `${row.transcript_id}:${row.byte_offset}`, row);
    }
  }

  const sessions = old.prepare(`SELECT * FROM sessions WHERE session_id IN (${q})`).all(...ids);
  if (apply) {
    const insert = graph.prepare(`INSERT OR IGNORE INTO session (session_id, transcript_id, started_at, ended_at, start_type, cwd, git_branch, ai_title, seed_prompt, cli_version, turn_count, commit_count, push_count)
                                  VALUES (@session_id, @transcript_id, @started_at, @ended_at, @start_type, @cwd, @git_branch, @ai_title, @seed_prompt, @cli_version, @turn_count, @commit_count, @push_count)`);
    for (const s of sessions) {
      const row = { ...s, transcript_id: map.get(s.transcript_id) ?? null };
      insert.run(row);
      preserve('session', ['session_id'], row.session_id, row);
    }
  }

  const turns = copyBySession('turns', 'turn', ['prompt_id', 'session_id', 'turn_index', 'started_at', 'ended_at', 'duration_ms', 'tool_call_count', 'thinking_ms'], ['prompt_id'], (r) => r.prompt_id);
  // cost_usd is dropped on purpose: the new schema has no column for it (TP-23).
  const usage = copyBySession('session_model_usage', 'session_model_usage', ['session_id', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'thinking_tokens', 'request_count'], ['session_id', 'model'], (r) => `${r.session_id}:${r.model}`);
  const phases = copyBySession('permission_phases', 'permission_phase', ['session_id', 'from_mode', 'to_mode', 'trigger', 't_valid', 't_invalid'], ['session_id', 't_valid', 'to_mode'], (r) => `${r.session_id}:${r.t_valid}:${r.to_mode}`);
  const edits = copyBySession('human_edits', 'human_edit', ['session_id', 'file_path', 'ts'], ['session_id', 'file_path', 'ts'], (r) => `${r.session_id}:${r.file_path}:${r.ts}`);

  return { transcripts, facts: facts.length, sessions: sessions.length, turns, usage, phases, edits };
}

const counts = apply ? graph.transaction(run)() : run();
console.log(apply ? 'APPLIED' : 'DRY RUN (pass --apply to write)');
console.log(`stranded sessions: ${ids.length}`);
console.table(counts);
if (apply) {
  const total = graph.prepare('SELECT count(*) c FROM session').get().c;
  const kept = graph.prepare('SELECT count(*) c FROM preserved_row').get().c;
  console.log(`sessions in graph.sqlite3 now: ${total}`);
  console.log(`rows declared non-derivable: ${kept} — \`miner refresh --full\` will replay them`);
}
