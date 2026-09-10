import { existsSync, statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { defaultGraphPath, openGraphReadOnly, SCHEMA_VERSION } from '../session-index/graph.js';
import { probeHealth, resolveDaemonPort } from '../server/lifecycle.js';

/**
 * `active-work miner status` — a read-only picture of the session-signal
 * index.
 *
 * Everything here is answered from SQLite plus one optional `/health` probe:
 * no transcript is opened, so this stays instant on a multi-gigabyte corpus.
 * `behindBytes` is the honest "how stale am I" number — the bytes on disk past
 * each transcript's watermark, summed.
 */

const ArgsSchema = z.object({});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  dbPath: z.string(),
  schemaVersion: z.number(),
  sizeBytes: z.number(),
  counts: z.object({
    transcripts: z.number(),
    sessions: z.number(),
    facts: z.number(),
    turns: z.number(),
    edges: z.number(),
    spans: z.number(),
  }),
  transcripts: z.object({
    ok: z.number(),
    quarantined: z.number(),
    missing: z.number(),
  }),
  watermark: z.object({
    lastIndexedAt: z.string().nullable(),
    behindBytes: z.number(),
  }),
  fts: z.object({
    rows: z.number(),
    orphanRows: z.number(),
    needsFullRebuild: z.boolean(),
  }),
  daemon: z
    .object({
      indexing: z.boolean(),
      pending: z.boolean(),
      lastRunAt: z.string().nullable(),
      lastDurationMs: z.number().nullable(),
      consecutiveErrors: z.number(),
    })
    .nullable(),
});
type Result = z.infer<typeof ResultSchema>;

/**
 * Purges and resets strand rows in the contentless `search_fts` (it cannot
 * delete a row without its original text). They are invisible to any query
 * that joins `search_span`, so this is a housekeeping signal, not a
 * correctness one — past this ratio the wasted index space is worth a
 * `refresh --full`.
 */
const ORPHAN_WARN_RATIO = 0.2;

const scalar = (db: Database.Database, sql: string): number =>
  (db.prepare<[], { n: number }>(sql).get() as { n: number } | undefined)?.n ?? 0;

function sizeOf(dbPath: string): number {
  try {
    return statSync(dbPath).size;
  } catch {
    return 0;
  }
}

function ftsState(db: Database.Database): Result['fts'] {
  const rows = scalar(db, 'SELECT COUNT(*) AS n FROM search_fts');
  const orphanRows = scalar(
    db,
    `SELECT COUNT(*) AS n FROM search_fts f
       LEFT JOIN search_span s ON s.span_id = f.rowid
      WHERE s.span_id IS NULL`,
  );
  return { rows, orphanRows, needsFullRebuild: rows > 0 && orphanRows / rows > ORPHAN_WARN_RATIO };
}

async function daemonState(): Promise<Result['daemon']> {
  const health = await probeHealth(resolveDaemonPort());
  return health?.index ?? null;
}

/**
 * "Nothing indexed yet" is a state, not a failure. A read-only open of a file
 * that does not exist throws `unable to open database file`, which is what a
 * user sees on a machine that has never run a refresh — including every machine
 * for the first pass after the graph moved to its own path.
 */
async function emptyStatus(dbPath: string): Promise<Result> {
  return {
    dbPath,
    schemaVersion: SCHEMA_VERSION,
    sizeBytes: 0,
    counts: { transcripts: 0, sessions: 0, facts: 0, turns: 0, edges: 0, spans: 0 },
    transcripts: { ok: 0, quarantined: 0, missing: 0 },
    watermark: { lastIndexedAt: null, behindBytes: 0 },
    fts: { rows: 0, orphanRows: 0, needsFullRebuild: false },
    daemon: await daemonState(),
  };
}

export default defineCommand<Args, Result>({
  name: 'miner.status',
  description: 'Report session-signal index size, freshness, and daemon indexing state.',
  args: ArgsSchema,
  result: ResultSchema,
  async run() {
    const dbPath = defaultGraphPath();
    if (!existsSync(dbPath)) return emptyStatus(dbPath);
    const db = openGraphReadOnly(dbPath);
    try {
      const statusCount = (status: string): number =>
        (
          db
            .prepare<
              [string],
              { n: number }
            >('SELECT COUNT(*) AS n FROM transcript WHERE status = ?')
            .get(status) as { n: number }
        ).n;
      return {
        dbPath,
        schemaVersion: SCHEMA_VERSION,
        sizeBytes: sizeOf(dbPath),
        counts: {
          transcripts: scalar(db, 'SELECT COUNT(*) AS n FROM transcript'),
          sessions: scalar(db, 'SELECT COUNT(*) AS n FROM session'),
          facts: scalar(db, 'SELECT COUNT(*) AS n FROM fact'),
          turns: scalar(db, 'SELECT COUNT(*) AS n FROM turn'),
          edges: scalar(db, 'SELECT COUNT(*) AS n FROM edge'),
          spans: scalar(db, 'SELECT COUNT(*) AS n FROM search_span'),
        },
        transcripts: {
          ok: statusCount('ok'),
          quarantined: statusCount('quarantined'),
          missing: statusCount('missing'),
        },
        watermark: {
          lastIndexedAt:
            db
              .prepare<
                [],
                { at: string | null }
              >('SELECT MAX(last_indexed_at) AS at FROM transcript')
              .get()?.at ?? null,
          behindBytes: scalar(
            db,
            `SELECT COALESCE(SUM(MAX(file_size - last_offset, 0)), 0) AS n
               FROM transcript WHERE file_size IS NOT NULL`,
          ),
        },
        fts: ftsState(db),
        daemon: await daemonState(),
      };
    } finally {
      db.close();
    }
  },
});
