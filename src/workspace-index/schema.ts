import { kitDdl, type Migration } from '@titan-design/store-sqlite';
import { MIGRATIONS as SESSION_GRAPH_MIGRATIONS } from '@titan-design/session-graph';

/**
 * The workspace half of `.miner/graph.sqlite3`, added as one more migration on
 * the chain `@titan-design/session-graph` owns.
 *
 * Not a second database file, and the reason is the whole point of the index:
 * a note that mentions a task that appears in a session is a *join*, so it must
 * not cross a file boundary, let alone a process one. The kit is a set of table
 * factories rather than a shared schema, so a second file would also duplicate
 * the edge table, the FTS tables and the watermark table for nothing.
 */

/** Kit table names the workspace pass uses. `edge` and `search` are shared with the session graph. */
export const WORKSPACE_KIT = {
  watermark: 'workspace_file',
  edge: 'edge',
  spanFts: 'search',
} as const;

/**
 * Workspace spans are stored at `WORKSPACE_SPAN_SOURCE_BASE + workspace_file.source_id`.
 *
 * One contentless FTS table serves both halves of this database — that is what
 * makes cross-class retrieval a single query — but `search_span.source_id` is a
 * bare integer, and the two watermark tables number their rows independently.
 * Without an offset, transcript 5 and workspace file 5 are the same locator,
 * and purging one file's spans would silently take a transcript's with it.
 *
 * So the id space is tagged rather than merely conventional: a span whose
 * `source_id` is at or above this base belongs to a workspace file, and
 * subtracting the base gives its `workspace_file` row. Below it, the span
 * belongs to a transcript. A reader can tell which with a comparison instead of
 * by knowing the field vocabulary.
 */
export const WORKSPACE_SPAN_SOURCE_BASE = 1_000_000_000;

/**
 * Why the workspace watermarks get their own table rather than joining the
 * transcripts in `transcript`: `runLiveness` reads every `transcript` row whose
 * status is `ok` and resolves its `source_key` with `session-read`'s
 * `toAbsolutePath`, which expands a leading `~`. A workspace key is relative to
 * the active root, so every one of them would resolve to nonsense and be
 * reported as a stale transcript. One table, two meanings, one broken
 * diagnostic.
 */

/**
 * Every table is keyed by the file that produced it, and carries its ref as a
 * separate column.
 *
 * The spec keyed each table by its ref. On the live corpus that silently drops
 * rows: 464 session files carry 377 distinct `session_id`s, and
 * `handoff-migration` alone appears in 17 files across 17 initiatives, so
 * neither `session_ref` nor `initiative` has a single true value. Two of 920
 * task files collide the same way, a live `tasks/A-2.yml` against its own
 * `tasks/archive/A-2.yml`. Keyed by ref, which file wins depends on scan order,
 * which is exactly the convergence property this index has to guarantee.
 *
 * Keyed by path, one file owns exactly one row: deletion is exact, no writer
 * can clobber another's row (finding F5 at row granularity), and the ref stays
 * an indexed column so the cross-class join is unchanged — many-to-one instead
 * of one-to-one.
 */
const DOMAIN_DDL = `
  CREATE TABLE IF NOT EXISTS initiative (
    path            TEXT PRIMARY KEY,
    initiative_ref  TEXT NOT NULL UNIQUE,
    slug            TEXT NOT NULL,
    title           TEXT,
    state           TEXT,
    rank            INTEGER,
    ship_target     TEXT,
    owner           TEXT,
    task_prefix     TEXT,
    updated         TEXT
  );

  CREATE TABLE IF NOT EXISTS note (
    path        TEXT PRIMARY KEY,
    note_ref    TEXT NOT NULL UNIQUE,
    initiative  TEXT NOT NULL,
    filename    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    created     TEXT,
    tags        TEXT,
    hits        INTEGER NOT NULL DEFAULT 0,
    promoted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_note_initiative ON note(initiative);

  CREATE TABLE IF NOT EXISTS workspace_task (
    path        TEXT PRIMARY KEY,
    task_ref    TEXT NOT NULL,
    initiative  TEXT NOT NULL,
    task_id     TEXT NOT NULL,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL,
    priority    INTEGER,
    severity    TEXT,
    estimate    REAL,
    tags        TEXT,
    created     TEXT,
    updated     TEXT,
    done_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_task_ref ON workspace_task(task_ref);

  CREATE TABLE IF NOT EXISTS session_record (
    path              TEXT PRIMARY KEY,
    session_ref       TEXT NOT NULL,
    initiative        TEXT NOT NULL,
    session_id        TEXT NOT NULL,
    started           TEXT,
    ended             TEXT,
    track             TEXT,
    parent_session_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_session_record_ref ON session_record(session_ref);

  CREATE TABLE IF NOT EXISTS source (
    path        TEXT PRIMARY KEY,
    source_ref  TEXT NOT NULL UNIQUE,
    initiative  TEXT NOT NULL,
    title       TEXT,
    kind        TEXT,
    added       TEXT
  );
`;

/**
 * Every workspace table, in an order safe to clear. The watermark table is not
 * derived, so it is rewound rather than emptied — same rule the session graph
 * states for `transcript`.
 */
export const WORKSPACE_TABLES = [
  'note',
  'workspace_task',
  'session_record',
  'source',
  'initiative',
] as const;

/** TP-35: the version is derived from the chain it extends, never hand-declared. */
function nextVersion(chain: readonly Migration[]): number {
  return (chain[chain.length - 1]?.version ?? 0) + 1;
}

/**
 * The kit indexes `search_span` on `owner_ref` alone, and its UNIQUE index
 * leads with `owner_ref` too, so nothing can serve `WHERE source_id = ?`.
 *
 * The workspace pass purges a file's spans by `source_id` — it has to, because
 * `session:` owners are shared with the transcript side — and without this
 * index each purge scans the whole table. Measured on the live graph: 2,162
 * files against 89,533 existing spans took 5.4 seconds, and 0.4 with the index.
 */
const SPAN_SOURCE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_search_span_source ON search_span(source_id);
`;

export const WORKSPACE_MIGRATIONS: Migration[] = [
  {
    version: nextVersion(SESSION_GRAPH_MIGRATIONS),
    name: 'workspace index tables',
    up: (db) => {
      db.exec(kitDdl({ watermark: WORKSPACE_KIT.watermark }));
      db.exec(DOMAIN_DDL);
      db.exec(SPAN_SOURCE_INDEX);
    },
  },
];

/** The full chain the graph file is migrated to: the package's, then the workspace's. */
export const MIGRATIONS: Migration[] = [...SESSION_GRAPH_MIGRATIONS, ...WORKSPACE_MIGRATIONS];
