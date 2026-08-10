import { statSync } from 'node:fs';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import {
  defaultSessionIndexPath,
  openSessionIndexReadOnly,
  SCHEMA_VERSION,
  type SessionIndexDb,
} from '../miner/session-index/db.js';
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
 * Purges and resets strand rows in the contentless `spans_fts` (it cannot
 * delete a row without its original text). They are invisible to any query
 * that joins `searchable_spans`, so this is a housekeeping signal, not a
 * correctness one — past this ratio the wasted index space is worth a
 * `refresh --full`.
 */
const ORPHAN_WARN_RATIO = 0.2;

const scalar = (db: SessionIndexDb, sql: string): number =>
  (db.prepare<[], { n: number }>(sql).get() as { n: number } | undefined)?.n ?? 0;

function sizeOf(dbPath: string): number {
  try {
    return statSync(dbPath).size;
  } catch {
    return 0;
  }
}

function ftsState(db: SessionIndexDb): Result['fts'] {
  const rows = scalar(db, 'SELECT COUNT(*) AS n FROM spans_fts');
  const orphanRows = scalar(
    db,
    `SELECT COUNT(*) AS n FROM spans_fts f
       LEFT JOIN searchable_spans s ON s.span_id = f.rowid
      WHERE s.span_id IS NULL`,
  );
  return { rows, orphanRows, needsFullRebuild: rows > 0 && orphanRows / rows > ORPHAN_WARN_RATIO };
}

async function daemonState(): Promise<Result['daemon']> {
  const health = await probeHealth(resolveDaemonPort());
  return health?.index ?? null;
}

export default defineCommand<Args, Result>({
  name: 'miner.status',
  description: 'Report session-signal index size, freshness, and daemon indexing state.',
  args: ArgsSchema,
  result: ResultSchema,
  async run() {
    const dbPath = defaultSessionIndexPath();
    const db = openSessionIndexReadOnly(dbPath);
    try {
      const statusCount = (status: string): number =>
        (
          db
            .prepare<
              [string],
              { n: number }
            >('SELECT COUNT(*) AS n FROM transcripts WHERE status = ?')
            .get(status) as { n: number }
        ).n;
      return {
        dbPath,
        schemaVersion: SCHEMA_VERSION,
        sizeBytes: sizeOf(dbPath),
        counts: {
          transcripts: scalar(db, 'SELECT COUNT(*) AS n FROM transcripts'),
          sessions: scalar(db, 'SELECT COUNT(*) AS n FROM sessions'),
          facts: scalar(db, 'SELECT COUNT(*) AS n FROM facts'),
          turns: scalar(db, 'SELECT COUNT(*) AS n FROM turns'),
          edges: scalar(db, 'SELECT COUNT(*) AS n FROM edges'),
          spans: scalar(db, 'SELECT COUNT(*) AS n FROM searchable_spans'),
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
              >('SELECT MAX(last_indexed_at) AS at FROM transcripts')
              .get()?.at ?? null,
          behindBytes: scalar(
            db,
            `SELECT COALESCE(SUM(MAX(file_size - last_byte_offset, 0)), 0) AS n
               FROM transcripts WHERE file_size IS NOT NULL`,
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
