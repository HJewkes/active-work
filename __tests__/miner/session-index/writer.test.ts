import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSessionIndex, type SessionIndexDb } from '../../../src/miner/session-index/db.js';
import { extractTranscript } from '../../../src/miner/session-index/extract.js';
import { reconcilePrMerges } from '../../../src/miner/session-index/rollup.js';
import { ensureTranscript } from '../../../src/miner/session-index/watermark.js';
import { applyExtractResult, resetIndex } from '../../../src/miner/session-index/writer.js';
import { FIXTURE_LINES, SESSION, offsetAfterLine, renderTranscript } from './fixture.js';

let dir: string;
let transcript: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-writer-'));
  // Named after the session id, matching real transcripts — `file-history-*`
  // lines have no `sessionId` field and fall back to this filename.
  transcript = path.join(dir, `${SESSION}.jsonl`);
  writeFileSync(transcript, renderTranscript(FIXTURE_LINES), 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function freshDb(name: string): { db: SessionIndexDb; transcriptId: number } {
  const db = openSessionIndex(path.join(dir, `${name}.sqlite3`));
  return { db, transcriptId: ensureTranscript(db, '~/projects/demo/session.jsonl').transcriptId };
}

/** Every derived table, minus the DB-assigned ids that cannot match by design. */
function snapshot(db: SessionIndexDb): Record<string, unknown[]> {
  const query = (sql: string) => db.prepare(sql).all();
  return {
    facts: query(
      'SELECT byte_offset, byte_length, event_type, ts, seq, session_id, prompt_id, tool_use_id' +
        ' FROM facts ORDER BY byte_offset',
    ),
    sessions: query(
      'SELECT session_id, started_at, ended_at, cwd, git_branch, ai_title, seed_prompt,' +
        ' turn_count, commit_count, push_count FROM sessions ORDER BY session_id',
    ),
    usage: query('SELECT * FROM session_model_usage ORDER BY session_id, model'),
    turns: query(
      'SELECT prompt_id, session_id, turn_index, started_at FROM turns ORDER BY turn_index',
    ),
    phases: query(
      'SELECT session_id, from_mode, to_mode, trigger, t_valid, t_invalid FROM permission_phases' +
        ' ORDER BY phase_id',
    ),
    humanEdits: query('SELECT session_id, file_path, ts FROM human_edits ORDER BY edit_id'),
    fileCheckpoints: query(
      'SELECT session_id, file_path, backup_file_name, version, backup_time FROM file_checkpoints' +
        ' ORDER BY checkpoint_id',
    ),
    prs: query('SELECT * FROM prs ORDER BY pr_ref'),
    branches: query('SELECT * FROM branches ORDER BY branch_ref'),
    files: query('SELECT * FROM files ORDER BY file_ref'),
    tasks: query('SELECT * FROM tasks ORDER BY task_ref'),
    subagents: query(
      'SELECT agent_ref, session_id, agent_type, label FROM subagents ORDER BY agent_ref',
    ),
    artifacts: query('SELECT * FROM artifacts ORDER BY artifact_ref'),
    edges: query(
      'SELECT source_ref, relation, target_ref, t_valid, t_expired FROM edges' +
        ' ORDER BY source_ref, relation, target_ref',
    ),
    spans: query(
      'SELECT field, byte_offset, byte_length FROM searchable_spans ORDER BY byte_offset, field',
    ),
  };
}

describe('applyExtractResult', () => {
  it('produces the same database from two chunked applies as from one', async () => {
    const split = offsetAfterLine(FIXTURE_LINES, 8);
    const whole = freshDb('whole');
    applyExtractResult(whole.db, whole.transcriptId, await extractTranscript(transcript));

    const chunked = freshDb('chunked');
    const first = await extractTranscript(transcript, { untilByteOffset: split });
    applyExtractResult(chunked.db, chunked.transcriptId, first);
    const second = await extractTranscript(transcript, {
      fromByteOffset: first.lastByteOffset,
      priorPrefixHash: first.prefixHash,
    });
    applyExtractResult(chunked.db, chunked.transcriptId, second);

    expect(snapshot(chunked.db)).toEqual(snapshot(whole.db));
    whole.db.close();
    chunked.db.close();
  });

  it('is idempotent when the same batch is applied twice', async () => {
    const { db, transcriptId } = freshDb('idempotent');
    const result = await extractTranscript(transcript);

    applyExtractResult(db, transcriptId, result);
    const afterFirst = snapshot(db);
    applyExtractResult(db, transcriptId, result);

    expect(snapshot(db).facts).toEqual(afterFirst.facts);
    expect(snapshot(db).edges).toEqual(afterFirst.edges);
    expect(snapshot(db).phases).toEqual(afterFirst.phases);
    expect(snapshot(db).spans).toEqual(afterFirst.spans);
    db.close();
  });

  it('accumulates token deltas rather than overwriting the bucket', async () => {
    const { db, transcriptId } = freshDb('usage');
    const result = await extractTranscript(transcript);

    applyExtractResult(db, transcriptId, result);
    applyExtractResult(db, transcriptId, result);

    const usage = db
      .prepare<
        [],
        { input_tokens: number; request_count: number }
      >('SELECT input_tokens, request_count FROM session_model_usage')
      .get();
    expect(usage).toEqual({ input_tokens: 180, request_count: 18 });
    db.close();
  });

  it('collapses repeated mode candidates and closes the superseded phase', async () => {
    const { db, transcriptId } = freshDb('phases');
    const lines = [
      ...FIXTURE_LINES,
      { sessionId: 'sess-1', cwd: '/repo/demo', type: 'mode', mode: 'plan', timestamp: 'T1' },
      { sessionId: 'sess-1', cwd: '/repo/demo', type: 'mode', mode: 'build', timestamp: 'T2' },
    ];
    writeFileSync(transcript, renderTranscript(lines), 'utf8');

    applyExtractResult(db, transcriptId, await extractTranscript(transcript));

    const phases = db
      .prepare<
        [],
        { to_mode: string; from_mode: string | null; t_invalid: string | null }
      >("SELECT to_mode, from_mode, t_invalid FROM permission_phases WHERE trigger = 'mode' ORDER BY phase_id")
      .all();
    expect(phases).toEqual([
      { to_mode: 'plan', from_mode: null, t_invalid: 'T2' },
      { to_mode: 'build', from_mode: 'plan', t_invalid: null },
    ]);
    db.close();
  });

  it('rebuilds to identical state after resetIndex, without doubling counters', async () => {
    const { db, transcriptId } = freshDb('rebuild');
    const result = await extractTranscript(transcript);
    applyExtractResult(db, transcriptId, result);
    const before = snapshot(db);

    resetIndex(db);
    applyExtractResult(db, transcriptId, result);

    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  it('records a `gh pr merge` observation instead of applying it at write time', async () => {
    const { db, transcriptId } = freshDb('merge');

    applyExtractResult(db, transcriptId, await extractTranscript(transcript));

    // The sighting is only a number: the `pr_ref` it belongs to may not be
    // indexed yet, so the writer stores the observation and stays out of `prs`.
    expect(db.prepare('SELECT state, merged_at FROM prs').get()).toEqual({
      state: null,
      merged_at: null,
    });
    expect(
      db.prepare('SELECT number, repo_hint, merged_at FROM pr_merge_observations').get(),
    ).toEqual({ number: 42, repo_hint: 'demo', merged_at: '2026-07-01T00:00:16Z' });
    db.close();
  });

  it('folds merge observations into prs regardless of which was indexed first', async () => {
    const { db, transcriptId } = freshDb('reconcile');
    applyExtractResult(db, transcriptId, await extractTranscript(transcript));

    expect(reconcilePrMerges(db)).toBe(1);

    expect(db.prepare('SELECT state, merged_at FROM prs').get()).toEqual({
      state: 'merged',
      merged_at: '2026-07-01T00:00:16Z',
    });
    // Recompute, not accumulate: re-running changes nothing.
    reconcilePrMerges(db);
    expect(db.prepare('SELECT state, merged_at FROM prs').get()).toEqual({
      state: 'merged',
      merged_at: '2026-07-01T00:00:16Z',
    });
    db.close();
  });
});
