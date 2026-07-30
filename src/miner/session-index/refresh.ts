import path from 'node:path';
import { promises as fs } from 'node:fs';
import lockfile from 'proper-lockfile';
import { getMinerRoot } from '../../utils/paths.js';
import { defaultSessionIndexPath, openSessionIndex, type SessionIndexDb } from './db.js';
import { discoverTranscripts, transcriptsRoot } from './discover.js';
import { indexTranscript, type IndexOutcome } from './quarantine.js';
import { rollupSessions } from './rollup.js';
import { resetIndex } from './writer.js';

/**
 * One refresh pass over the transcript corpus: discover -> index each changed
 * transcript -> roll up the sessions that changed.
 *
 * This is the single code path behind `tools/build-session-index.mjs`, the
 * `miner refresh` command and the daemon's watcher, so a bug can only be fixed
 * (or introduced) once.
 */

export interface RefreshOptions {
  /** Reuse an open handle (the daemon holds one); otherwise one is opened. */
  db?: SessionIndexDb;
  dbPath?: string;
  /** Wipe every derived row and re-read every transcript from byte 0. */
  full?: boolean;
  /** Visit at most this many transcripts (debugging aid). */
  limit?: number;
  /** Stream a whole-file sha256 per transcript; defaults to `full`. */
  verifyHashes?: boolean;
  /** Transcript corpus root; overridable for tests. */
  root?: string;
}

export interface RefreshSummary {
  startedAt: string;
  durationMs: number;
  /** Transcripts discovered in the corpus. */
  transcripts: number;
  /** Transcripts this pass actually visited (differs under `--limit`). */
  scanned: number;
  indexed: number;
  unchanged: number;
  quarantined: number;
  missing: number;
  factsAdded: number;
  sessionsRolledUp: number;
  errors: string[];
}

export const LOCK_STALE_MS = 60_000;

/** `<minerRoot>/index.sqlite3.lock` — the cross-process refresh mutex. */
export function refreshLockPath(): string {
  return `${path.join(getMinerRoot(), 'index.sqlite3')}.lock`;
}

/**
 * Run `fn` holding the refresh lock, *blocking* until the current holder
 * releases rather than failing fast: a user typing `miner refresh` while the
 * daemon happens to be mid-pass wants their refresh to happen, not an error.
 * A crashed holder's lock goes stale after `LOCK_STALE_MS`.
 */
export async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const target = refreshLockPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '', { flag: 'a' });
  const release = await lockfile.lock(target, {
    realpath: false,
    stale: LOCK_STALE_MS,
    retries: { retries: 120, factor: 1.5, minTimeout: 200, maxTimeout: 2_000 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * `verifyHashes` defaults to `full` on purpose. The whole-file sha256 is the
 * only O(corpus) step left in a pass, and making incremental passes sample it
 * randomly would make two runs over identical inputs produce different
 * `content_hash` state — which the equivalence eval reads as a real divergence.
 * Drift detection therefore rides on `--full`.
 */
export async function runRefresh(options: RefreshOptions = {}): Promise<RefreshSummary> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const db = options.db ?? openSessionIndex(options.dbPath ?? defaultSessionIndexPath());
  const owned = options.db === undefined;

  try {
    if (options.full) resetIndex(db);
    const discovered = await discoverTranscripts(options.root ?? transcriptsRoot());
    const visiting = discovered.slice(0, options.limit ?? discovered.length);
    const verifyContentHash = options.verifyHashes ?? options.full ?? false;

    const outcomes: IndexOutcome[] = [];
    const touched = new Set<string>();
    for (const transcript of visiting) {
      const outcome = await indexTranscript(db, transcript, { verifyContentHash });
      outcomes.push(outcome);
      for (const sessionId of outcome.sessionIds) touched.add(sessionId);
    }

    // Once per pass, not per transcript: cheaper, and a session split across
    // transcripts by a resume or compact is then rolled up from all its facts.
    const sessionsRolledUp = rollupSessions(db, [...touched]);
    return summarize(
      startedAt,
      Date.now() - started,
      discovered.length,
      outcomes,
      sessionsRolledUp,
    );
  } finally {
    if (owned) db.close();
  }
}

function summarize(
  startedAt: string,
  durationMs: number,
  transcripts: number,
  outcomes: IndexOutcome[],
  sessionsRolledUp: number,
): RefreshSummary {
  const counts = { indexed: 0, unchanged: 0, quarantined: 0, missing: 0 };
  let factsAdded = 0;
  const errors: string[] = [];
  for (const outcome of outcomes) {
    counts[outcome.status] += 1;
    factsAdded += outcome.factsAdded;
    if (outcome.reason) errors.push(`${outcome.status}: ${outcome.path} — ${outcome.reason}`);
  }
  return {
    startedAt,
    durationMs,
    transcripts,
    scanned: outcomes.length,
    ...counts,
    factsAdded,
    sessionsRolledUp,
    errors,
  };
}
