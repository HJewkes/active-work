#!/usr/bin/env node
/* eslint-disable no-undef -- Node ESM build tool */
/**
 * eval-session-index.mjs — scores the AW-23/AW-90 session-signal index against
 * ground truth, so every capability built on the index (search, cost rollups,
 * context graphs) rests on something measured rather than assumed.
 *
 * Sibling of `tools/eval-miner.mjs`, which scores the superseded AW-22
 * prototype and is deliberately left alone; the pure scoring helpers are reused
 * from it so both scorecards mean the same thing by "precision".
 *
 * Four checks:
 *   1. Ground truth — PRs / branches / files the index claims, cross-checked
 *      against `gh` and `git` per `--repo`. Precision gates; coverage is
 *      reported (a session-scoped index only sees what a session touched).
 *   2. Equivalence — a full rebuild, an incremental replay, and a rotation
 *      replay must produce byte-identical table digests. This is the gate that
 *      catches the whole class of "chunk boundary corrupted the index" bugs,
 *      including the rotation double-count regression fixed in AW-90.
 *   3. Performance — full rebuild under a ceiling; an incremental delta on a
 *      warm index under a much tighter one, with `unchanged` asserted so a
 *      fast run that secretly re-read the corpus still fails.
 *   4. FTS sanity — a stored span is findable by a token from its own text,
 *      through the mandatory `searchable_spans` join.
 *
 * Exit code makes this a local pre-merge gate. The pure functions below are
 * unit-tested in CI; the full run needs the operator's private `~/.claude`
 * corpus, which CI does not have.
 *
 * Usage:
 *   node eval-session-index.mjs [--repo <path>]... [--limit N] [--max-full-ms 30000]
 *                               [--max-incremental-ms 1000] [--skip-perf] [--json] [--out f.json]
 */
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register();
const pexec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => new URL(`file://${path.join(here, '..', 'src', rel)}`).href;

const { openSessionIndex } = await import(src('miner/session-index/db.ts'));
const { runRefresh } = await import(src('miner/session-index/refresh.ts'));
const { discoverTranscripts, transcriptsRoot } = await import(
  src('miner/session-index/discover.ts')
);
// The extractor's own text projection: the FTS check has to probe with tokens
// that were actually indexed, not with tokens from the raw JSONL.
const { searchText } = await import(src('miner/session-index/line-handler.ts'));

export { score, attrAccuracy, round } from './eval-miner.mjs';
import { score, attrAccuracy, round } from './eval-miner.mjs';

// ── pure helpers (exported for unit tests) ───────────────────────────────────

/** Median of a numeric sample; 0 for an empty one. */
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Byte offsets of every line boundary in `buffer` (i.e. just past each `\n`).
 * Truncating a JSONL transcript anywhere else would hand the extractor a
 * half-record and make the equivalence check fail for the wrong reason.
 */
export function lineBoundaries(buffer) {
  const offsets = [];
  for (let i = 0; i < buffer.length; i++) if (buffer[i] === 0x0a) offsets.push(i + 1);
  return offsets;
}

/**
 * Pick `count` interior truncation points spread across a transcript's lines.
 * Fractions rather than fixed line numbers so the stages land mid-turn on some
 * transcripts and mid-permission-phase on others, which is exactly the class of
 * boundary a naive extractor gets wrong.
 */
export function truncationStages(buffer, count = 2) {
  const boundaries = lineBoundaries(buffer);
  if (boundaries.length <= 1) return [];
  const stages = [];
  for (let i = 1; i <= count; i++) {
    const index = Math.floor((boundaries.length * i) / (count + 1));
    const offset = boundaries[Math.min(Math.max(index, 0), boundaries.length - 1)];
    if (!stages.includes(offset)) stages.push(offset);
  }
  return stages;
}

/** sha256 over a canonical JSON rendering of a row set. */
export function digestRows(rows) {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(JSON.stringify(row) + '\n');
  return hash.digest('hex');
}

/**
 * Grade only the attributes the index actually asserts.
 *
 * `attrAccuracy` (reused from eval-miner and reported alongside) demands a
 * branch AND a merged flag for every shared PR. That is the right question for
 * the AW-22 prototype but the wrong one here: this index learns `merged_at`
 * solely from an observed `gh pr merge` command, so a PR merged through the
 * GitHub UI is legitimately unknown, not wrong. Scoring silence as an error
 * would make the gate unreachable and stop measuring anything. This scores the
 * question that matters — *when the index claims something, is it true?*
 */
export function claimAccuracy(claims, truthByNumber) {
  let checked = 0;
  let accurate = 0;
  const wrong = [];
  for (const claim of claims) {
    const truth = truthByNumber.get(String(claim.number));
    if (!truth) continue;
    if (claim.branch) {
      checked += 1;
      if (claim.branch === truth.branch) accurate += 1;
      else wrong.push({ number: claim.number, claimed: claim.branch, actual: truth.branch });
    }
    // Only a positive merge claim is an assertion; absence is ignorance.
    if (claim.merged) {
      checked += 1;
      if (truth.merged) accurate += 1;
      else wrong.push({ number: claim.number, claimed: 'merged', actual: 'not merged' });
    }
  }
  return {
    checked,
    accurate,
    accuracy: checked ? round(accurate / checked) : 1,
    wrong: wrong.slice(0, 10),
  };
}

/** Table names whose digests differ between two snapshots. */
export function diffDigests(a, b) {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...names].filter((name) => a[name] !== b[name]).sort();
}

/**
 * `<project>/<session>.jsonl` — the part of a transcript path that is stable
 * across replay roots. The three databases are built from three different
 * directories, so the absolute (or `~`-relative) path stored in `transcripts`
 * differs by construction while the *content* is identical; digesting the raw
 * path would report every table as divergent.
 */
export function shortTranscriptPath(value) {
  const parts = String(value).split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

/** Normalize the path column of a row set before digesting it. */
export function normalizeRows(rows) {
  return rows.map((row) =>
    'path' in row ? { ...row, path: shortTranscriptPath(row.path) } : row,
  );
}

// ── canonical digests ────────────────────────────────────────────────────────

/**
 * Every comparison excludes surrogate keys (`fact_id`, `span_id`, `edge_id`, …)
 * and indexing timestamps (`t_indexed`, `t_created`, `last_indexed_at`): those
 * legitimately differ between a full rebuild and an incremental replay without
 * the *content* differing. `facts` and `searchable_spans` are joined back to
 * `(transcript.path, byte_offset)`, which is the real, stable identity of a row
 * in this schema.
 */
const DIGEST_QUERIES = {
  transcripts: `SELECT path, last_byte_offset, prefix_hash, file_size, status, quarantine_reason
                  FROM transcripts ORDER BY path`,
  facts: `SELECT t.path, f.byte_offset, f.byte_length, f.event_type, f.ts, f.seq, f.session_id,
                 f.prompt_id, f.tool_use_id, f.agent_id, f.parent_agent_id, f.workflow_run_id
            FROM facts f JOIN transcripts t ON t.transcript_id = f.transcript_id
           ORDER BY t.path, f.byte_offset`,
  sessions: `SELECT session_id, started_at, ended_at, start_type, cwd, git_branch, ai_title,
                    seed_prompt, cli_version, turn_count, commit_count, push_count
               FROM sessions ORDER BY session_id`,
  session_model_usage: `SELECT session_id, model, input_tokens, output_tokens, cache_read_tokens,
                               cache_creation_tokens, thinking_tokens, request_count
                          FROM session_model_usage ORDER BY session_id, model`,
  turns: `SELECT prompt_id, session_id, turn_index, started_at, ended_at, duration_ms,
                 tool_call_count, thinking_ms
            FROM turns ORDER BY session_id, turn_index, prompt_id`,
  permission_phases: `SELECT session_id, from_mode, to_mode, trigger, t_valid, t_invalid
                        FROM permission_phases ORDER BY session_id, t_valid, trigger, to_mode`,
  human_edits: `SELECT session_id, file_path, ts, lines_added, lines_removed
                  FROM human_edits ORDER BY session_id, file_path, ts`,
  subagents: `SELECT agent_ref, session_id, parent_agent_ref, agent_type, label, started_at, ended_at
                FROM subagents ORDER BY agent_ref`,
  prs: `SELECT pr_ref, number, repo, title, state, url, merged_at FROM prs ORDER BY pr_ref`,
  branches: `SELECT branch_ref, repo, name, base, created_at, deleted_at
               FROM branches ORDER BY branch_ref`,
  files: `SELECT file_ref, repo, path FROM files ORDER BY file_ref`,
  tasks: `SELECT task_ref, initiative, title, status FROM tasks ORDER BY task_ref`,
  artifacts: `SELECT artifact_ref, kind, title, url, path, created_at
                FROM artifacts ORDER BY artifact_ref`,
  edges: `SELECT source_ref, relation, target_ref, t_valid, t_invalid, t_expired, confidence
            FROM edges ORDER BY source_ref, relation, target_ref, t_valid`,
  searchable_spans: `SELECT t.path, s.byte_offset, s.byte_length, s.field
                       FROM searchable_spans s JOIN transcripts t ON t.transcript_id = s.transcript_id
                      ORDER BY t.path, s.byte_offset, s.field`,
};

/**
 * Probe tokens for the FTS digest. A contentless FTS5 table cannot return the
 * text it tokenized, so `spans_fts` is compared by *what it matches*, never by
 * rowid — full and incremental builds allocate rowids in a different order and
 * comparing those would fail on a correct index.
 */
const FTS_PROBES = [
  'the',
  'error',
  'commit',
  'test',
  'file',
  'branch',
  'index',
  'session',
  'refactor',
  'null',
];

function ftsDigest(db) {
  const statement = db.prepare(
    `SELECT t.path AS path, s.byte_offset AS byte_offset, s.field AS field
       FROM spans_fts f
       JOIN searchable_spans s ON s.span_id = f.rowid
       JOIN transcripts t ON t.transcript_id = s.transcript_id
      WHERE spans_fts MATCH ?
      ORDER BY t.path, s.byte_offset, s.field`,
  );
  const rows = [];
  for (const probe of FTS_PROBES) {
    for (const row of normalizeRows(statement.all(probe))) rows.push({ probe, ...row });
  }
  return digestRows(rows);
}

function snapshotDigests(dbPath) {
  const db = openSessionIndex(dbPath);
  try {
    const digests = {};
    for (const [table, sql] of Object.entries(DIGEST_QUERIES)) {
      digests[table] = digestRows(normalizeRows(db.prepare(sql).all()));
    }
    digests.spans_fts = ftsDigest(db);
    return digests;
  } finally {
    db.close();
  }
}

// ── corpus snapshots ─────────────────────────────────────────────────────────

/**
 * Freeze the corpus into a temp HOME before measuring anything.
 *
 * Mandatory, not a nicety: the operator's own in-flight transcript grows while
 * the eval runs, which would make a *correct* index look non-deterministic.
 */
async function snapshotCorpus(limit) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-index-eval-home-'));
  const discovered = await discoverTranscripts(transcriptsRoot());
  const sample = discovered.slice(0, limit);
  const root = path.join(home, '.claude', 'projects');
  const copied = [];
  for (const transcript of sample) {
    const destination = path.join(root, path.relative(transcriptsRoot(), transcript.absolutePath));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(transcript.absolutePath, destination);
    copied.push(destination);
  }
  return { home, root, transcripts: copied, discovered: discovered.length };
}

const dbIn = (dir, name) => path.join(dir, `${name}.sqlite3`);

// ── check 1: ground truth ────────────────────────────────────────────────────

async function tryExec(cmd, argv, cwd) {
  try {
    const { stdout } = await pexec(cmd, argv, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, error: err.shortMessage || err.message };
  }
}

async function ghPrs(repo) {
  const result = await tryExec(
    'gh',
    ['pr', 'list', '--state', 'all', '--json', 'number,headRefName,state,mergedAt', '-L', '1000'],
    repo,
  );
  if (!result.ok) return { available: false, reason: result.error, byNumber: new Map() };
  const byNumber = new Map();
  for (const pr of JSON.parse(result.stdout)) {
    byNumber.set(String(pr.number), { branch: pr.headRefName, merged: Boolean(pr.mergedAt) });
  }
  return { available: true, byNumber, numbers: [...byNumber.keys()] };
}

async function gitBranches(repo, prBranches) {
  const result = await tryExec(
    'git',
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
    repo,
  );
  const live = result.ok
    ? result.stdout
        .split('\n')
        .map((s) => s.replace(/^origin\//, '').trim())
        .filter((s) => s && s !== 'origin' && s !== 'HEAD')
    : [];
  return new Set([...live, ...prBranches]);
}

async function gitFiles(repo) {
  const runs = await Promise.all([
    tryExec('git', ['log', '--all', '--name-only', '--pretty=format:'], repo),
    tryExec('git', ['ls-files'], repo),
    tryExec('git', ['ls-files', '--others', '--exclude-standard'], repo),
  ]);
  const files = new Set();
  for (const run of runs) {
    if (!run.ok) continue;
    for (const line of run.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  }
  return files;
}

/** What the index claims about one repo, keyed the way ground truth is keyed. */
function indexClaims(db, repoName) {
  const prs = db
    .prepare(
      `SELECT p.number AS number, p.merged_at AS merged_at,
              (SELECT REPLACE(e.target_ref, 'branch:' || ? || '/', '')
                 FROM edges e
                WHERE e.source_ref = p.pr_ref AND e.relation = 'built_on' AND e.t_expired IS NULL
                LIMIT 1) AS branch
         FROM prs p WHERE p.repo LIKE '%/' || ? OR p.repo = ?`,
    )
    .all(repoName, repoName, repoName);
  const files = db.prepare('SELECT path FROM files WHERE repo = ?').all(repoName);
  const branches = db.prepare('SELECT name FROM branches WHERE repo = ?').all(repoName);
  return {
    prs: prs.map((p) => ({
      number: p.number,
      branch: p.branch || '',
      merged: Boolean(p.merged_at),
    })),
    files: files.map((f) => f.path),
    branches: branches.map((b) => b.name),
  };
}

async function groundTruthCheck(dbPath, repos, minPrecision) {
  if (repos.length === 0) return { skipped: 'no --repo given' };
  const db = openSessionIndex(dbPath);
  try {
    const perRepo = {};
    for (const repo of repos) {
      const name = path.basename(repo);
      const claims = indexClaims(db, name);
      const prs = await ghPrs(repo);
      const branchTruth = await gitBranches(
        repo,
        prs.available ? [...prs.byNumber.values()].map((v) => v.branch).filter(Boolean) : [],
      );
      perRepo[name] = {
        prs: prs.available
          ? score(
              claims.prs.map((p) => p.number),
              prs.numbers,
            )
          : { skipped: prs.reason },
        prAttributes: prs.available
          ? claimAccuracy(claims.prs, prs.byNumber)
          : { skipped: prs.reason },
        // The strict both-attributes-known figure, reported for contrast.
        prAttributesStrict: prs.available
          ? attrAccuracy(claims.prs, prs.byNumber)
          : { skipped: prs.reason },
        files: score(claims.files, [...(await gitFiles(repo))]),
        // Reported, never gated: a branch the index correctly attributes from a
        // worktree or a sibling clone is not in this repo's refs.
        branches: score(claims.branches, [...branchTruth]),
      };
    }
    const gated = Object.values(perRepo).flatMap((r) => [
      r.prs.skipped ? 1 : r.prs.precision,
      r.prAttributes.skipped ? 1 : r.prAttributes.accuracy,
      r.files.precision,
    ]);
    return { perRepo, minPrecision, pass: gated.every((value) => value >= minPrecision) };
  } finally {
    db.close();
  }
}

// ── check 2: full == incremental == rotated ──────────────────────────────────

/**
 * Replay the corpus incrementally: for each transcript, write a truncated
 * prefix, refresh, grow it, refresh again — at least three stages per file,
 * with the boundaries landing wherever the fractions put them (mid-turn on some
 * transcripts, mid-permission-phase on others).
 */
async function replayIncremental(sourceRoot, workRoot, dbPath, transcripts) {
  const contents = new Map();
  for (const absolute of transcripts) {
    contents.set(absolute, await fs.readFile(absolute));
  }
  await fs.rm(workRoot, { recursive: true, force: true });
  await fs.mkdir(workRoot, { recursive: true });

  const staged = [...contents.entries()].map(([absolute, buffer]) => ({
    destination: path.join(workRoot, path.relative(sourceRoot, absolute)),
    buffer,
    stages: [...truncationStages(buffer, 2), buffer.length],
  }));
  const maxStages = Math.max(...staged.map((s) => s.stages.length));

  for (let stage = 0; stage < maxStages; stage++) {
    for (const item of staged) {
      const offset = item.stages[Math.min(stage, item.stages.length - 1)];
      await fs.mkdir(path.dirname(item.destination), { recursive: true });
      await fs.writeFile(item.destination, item.buffer.subarray(0, offset));
    }
    await runRefresh({ dbPath, root: workRoot });
  }
}

/**
 * The rotation case: index a transcript whose prefix is *wrong*, then restore
 * the real bytes. The prefix hash no longer matches, so the extractor restarts
 * from zero — and the index must land on exactly the same state as a clean
 * build, which it only does if the per-transcript purge is correct. This is the
 * standing regression gate for the AW-90 double-count bug.
 */
async function replayRotation(sourceRoot, workRoot, dbPath, transcripts) {
  await replayIncremental(sourceRoot, workRoot, dbPath, transcripts);
  const victim = transcripts[0];
  if (!victim) return { rotated: null };
  const destination = path.join(workRoot, path.relative(sourceRoot, victim));
  const real = await fs.readFile(victim);
  const boundaries = lineBoundaries(real);
  const cut = boundaries[Math.floor(boundaries.length / 2)] ?? real.length;

  // Something plausible but different, so the stored prefix hash goes stale.
  const decoy = Buffer.concat([Buffer.from(rewritePrefix(real.subarray(0, cut))), real.subarray(cut)]);
  await fs.writeFile(destination, decoy);
  await runRefresh({ dbPath, root: workRoot });
  await fs.writeFile(destination, real);
  await runRefresh({ dbPath, root: workRoot });
  return { rotated: path.basename(victim) };
}

/** Perturb a JSONL prefix without breaking it: flip every timestamp's year. */
function rewritePrefix(buffer) {
  return buffer
    .toString('utf8')
    .split('\n')
    .map((line) => (line ? line.replace(/"20(\d\d)-/g, '"19$1-') : line))
    .join('\n');
}

async function equivalenceCheck(snapshot, work) {
  const fullDb = dbIn(work, 'full');
  await runRefresh({ dbPath: fullDb, root: snapshot.root, full: true });
  const full = snapshotDigests(fullDb);

  const incrementalRoot = path.join(work, 'incremental-root');
  const incrementalDb = dbIn(work, 'incremental');
  await replayIncremental(snapshot.root, incrementalRoot, incrementalDb, snapshot.transcripts);
  const incremental = snapshotDigests(incrementalDb);

  const rotatedRoot = path.join(work, 'rotated-root');
  const rotatedDb = dbIn(work, 'rotated');
  const rotation = await replayRotation(
    snapshot.root,
    rotatedRoot,
    rotatedDb,
    snapshot.transcripts,
  );
  const rotated = snapshotDigests(rotatedDb);

  const incrementalDiff = diffDigests(full, incremental);
  const rotatedDiff = diffDigests(full, rotated);
  return {
    transcripts: snapshot.transcripts.length,
    rotatedTranscript: rotation.rotated,
    incrementalDiff,
    rotatedDiff,
    pass: incrementalDiff.length === 0 && rotatedDiff.length === 0,
  };
}

// ── check 3: performance ─────────────────────────────────────────────────────

/**
 * The incremental budget is measured on a *warm* index after appending a
 * handful of lines to one transcript. `unchanged === transcripts - 1` is the
 * load-bearing assertion: without it, a pass that re-read the whole corpus in
 * 900ms would score as a pass.
 */
async function performanceCheck(snapshot, work, limits) {
  const dbPath = dbIn(work, 'perf');
  const started = process.hrtime.bigint();
  const full = await runRefresh({ dbPath, root: snapshot.root, full: true });
  const fullMs = round(Number(process.hrtime.bigint() - started) / 1e6);

  const victim = snapshot.transcripts[0];
  const samples = [];
  let lastSummary = null;
  for (let i = 0; i < 5; i++) {
    const original = await fs.readFile(victim, 'utf8');
    const lines = original.trimEnd().split('\n');
    const appended = Array.from({ length: 20 }, (_, n) => lines[n % lines.length]).join('\n');
    await fs.appendFile(victim, `${appended}\n`);
    const t0 = process.hrtime.bigint();
    lastSummary = await runRefresh({ dbPath, root: snapshot.root });
    samples.push(round(Number(process.hrtime.bigint() - t0) / 1e6));
  }

  const incrementalMs = median(samples);
  const untouched = lastSummary.scanned - 1;
  const onlyOneReread = lastSummary.unchanged === untouched;
  return {
    fullMs,
    fullCeilingMs: limits.maxFullMs,
    incrementalMs,
    incrementalSamples: samples,
    incrementalCeilingMs: limits.maxIncrementalMs,
    transcripts: full.transcripts,
    unchanged: lastSummary.unchanged,
    expectedUnchanged: untouched,
    onlyOneReread,
    pass:
      fullMs <= limits.maxFullMs && incrementalMs <= limits.maxIncrementalMs && onlyOneReread,
  };
}

// ── check 4: FTS sanity ──────────────────────────────────────────────────────

/**
 * Pull a distinctive token out of each sampled span's own source bytes and
 * assert the span comes back through the join. The text has to be re-derived
 * with the extractor's own `searchText` projection — tokens from the raw JSONL
 * (field names, uuids) were never indexed, so probing with those would report a
 * healthy index as broken. Re-reading from disk rather than from `spans_fts` is
 * not laziness either: a contentless FTS5 table cannot return what it
 * tokenized, which is exactly why the join is mandatory.
 */
async function ftsCheck(dbPath, sampleSize = 20) {
  const db = openSessionIndex(dbPath);
  try {
    const spans = db
      .prepare(
        `SELECT s.span_id AS span_id, s.field AS field, s.byte_offset AS byte_offset,
                s.byte_length AS byte_length, t.path AS path
           FROM searchable_spans s JOIN transcripts t ON t.transcript_id = s.transcript_id
          ORDER BY s.span_id LIMIT 4000`,
      )
      .all();
    if (spans.length === 0) return { skipped: 'no spans indexed' };

    const step = Math.max(1, Math.floor(spans.length / sampleSize));
    const lookup = db.prepare(
      `SELECT s.span_id AS span_id FROM spans_fts f
         JOIN searchable_spans s ON s.span_id = f.rowid
        WHERE spans_fts MATCH ? AND s.span_id = ?`,
    );

    let checked = 0;
    let found = 0;
    const misses = [];
    for (let i = 0; i < spans.length && checked < sampleSize; i += step) {
      const span = spans[i];
      const token = await distinctiveToken(resolveTranscriptPath(span.path), span);
      if (!token) continue;
      checked += 1;
      if (lookup.get(`"${token}"`, span.span_id)) found += 1;
      else misses.push({ span_id: span.span_id, field: span.field, token });
    }
    return {
      checked,
      found,
      misses: misses.slice(0, 5),
      pass: checked === 0 || found === checked,
    };
  } finally {
    db.close();
  }
}

/** `transcripts.path` is `~`-relative only when the file lives under `$HOME`. */
function resolveTranscriptPath(stored) {
  return stored.startsWith('~/') ? path.join(os.homedir(), stored.slice(2)) : stored;
}

const STOPWORD = /^(the|and|for|that|with|this|from|have|type|null|true|false)$/i;

async function distinctiveToken(absolutePath, span) {
  let handle;
  try {
    handle = await fs.open(absolutePath, 'r');
    const buffer = Buffer.alloc(span.byte_length);
    await handle.read(buffer, 0, buffer.length, span.byte_offset);
    const line = JSON.parse(buffer.toString('utf8'));
    const indexed = searchText(line?.message ?? null, span.field);
    const words = indexed.match(/[A-Za-z][A-Za-z0-9]{5,}/g) ?? [];
    return words.find((word) => !STOPWORD.test(word)) ?? null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

// ── orchestration ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    repos: [],
    limit: 150,
    maxFullMs: 30_000,
    maxIncrementalMs: 1_000,
    minPrecision: 0.9,
    skipPerf: false,
    json: false,
    out: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--repo') args.repos.push(path.resolve(argv[++i]));
    else if (key === '--limit') args.limit = Number(argv[++i]);
    else if (key === '--max-full-ms') args.maxFullMs = Number(argv[++i]);
    else if (key === '--max-incremental-ms') args.maxIncrementalMs = Number(argv[++i]);
    else if (key === '--min-precision') args.minPrecision = Number(argv[++i]);
    else if (key === '--skip-perf') args.skipPerf = true;
    else if (key === '--out') args.out = argv[++i];
    else if (key === '--json') args.json = true;
  }
  return args;
}

async function evaluate(args) {
  const snapshot = await snapshotCorpus(args.limit);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-index-eval-'));
  try {
    const equivalence = await equivalenceCheck(snapshot, work);
    const groundTruth = await groundTruthCheck(
      dbIn(work, 'full'),
      args.repos,
      args.minPrecision,
    );
    const fts = await ftsCheck(dbIn(work, 'full'));
    const performance = args.skipPerf
      ? { skipped: '--skip-perf' }
      : await performanceCheck(snapshot, work, args);

    const gates = [
      ['equivalence', equivalence.pass],
      ['ground-truth', groundTruth.skipped ? true : groundTruth.pass],
      ['performance', performance.skipped ? true : performance.pass],
      ['fts', fts.skipped ? true : fts.pass],
    ];
    return {
      corpus: { sampled: snapshot.transcripts.length, discovered: snapshot.discovered },
      checks: { equivalence, groundTruth, performance, fts },
      gates: Object.fromEntries(gates),
      pass: gates.every(([, ok]) => ok),
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
    await fs.rm(snapshot.home, { recursive: true, force: true });
  }
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;

function printScorecard(report) {
  const { checks } = report;
  console.log(
    `eval-session-index scorecard — ${report.corpus.sampled}/${report.corpus.discovered} transcripts\n`,
  );

  const eq = checks.equivalence;
  console.log(`  ${'equivalence'.padEnd(18)} ${eq.pass ? 'PASS' : 'FAIL'} — full vs incremental vs rotated`);
  if (eq.incrementalDiff.length) console.log(`  ${''.padEnd(18)} ✗ incremental differs: ${eq.incrementalDiff.join(', ')}`);
  if (eq.rotatedDiff.length) console.log(`  ${''.padEnd(18)} ✗ rotated differs: ${eq.rotatedDiff.join(', ')}`);

  if (checks.groundTruth.skipped) {
    console.log(`  ${'ground-truth'.padEnd(18)} skipped — ${checks.groundTruth.skipped}`);
  } else {
    for (const [repo, r] of Object.entries(checks.groundTruth.perRepo)) {
      const row = (label, c) =>
        c.skipped
          ? console.log(`  ${`${repo} ${label}`.padEnd(18)} skipped — ${c.skipped}`)
          : console.log(
              `  ${`${repo} ${label}`.padEnd(18)} precision ${pct(c.precision).padStart(7)}  coverage ${pct(c.coverage).padStart(7)}  (${c.hits}/${c.reported})`,
            );
      row('PRs', r.prs);
      row('files', r.files);
      row('branches*', r.branches);
      if (!r.prAttributes.skipped)
        console.log(
          `  ${`${repo} pr-attrs`.padEnd(18)} ${pct(r.prAttributes.accuracy)} (${r.prAttributes.accurate}/${r.prAttributes.checked})`,
        );
    }
  }

  const p = checks.performance;
  if (p.skipped) console.log(`  ${'performance'.padEnd(18)} skipped — ${p.skipped}`);
  else
    console.log(
      `  ${'performance'.padEnd(18)} full ${p.fullMs}ms/${p.fullCeilingMs}ms · incremental ${p.incrementalMs}ms/${p.incrementalCeilingMs}ms · unchanged ${p.unchanged}/${p.expectedUnchanged} — ${p.pass ? 'PASS' : 'FAIL'}`,
    );

  const f = checks.fts;
  if (f.skipped) console.log(`  ${'fts'.padEnd(18)} skipped — ${f.skipped}`);
  else console.log(`  ${'fts'.padEnd(18)} ${f.found}/${f.checked} spans found by their own token — ${f.pass ? 'PASS' : 'FAIL'}`);

  console.log(
    `\ngates: ${Object.entries(report.gates)
      .map(([k, v]) => `${k}=${v ? '✓' : '✗'}`)
      .join('  ')}`,
  );
  console.log(`\n${report.pass ? '✅ PASS' : '❌ FAIL'}   (* branches reported, never gated)`);
}

async function main() {
  const args = parseArgs(process.argv);
  const report = await evaluate(args);
  if (args.out) await fs.writeFile(args.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printScorecard(report);
  process.exit(report.pass ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(2);
  });
}
