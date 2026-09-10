import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { RELATIONS, toAbsolutePath } from '@titan-design/session-read';

/**
 * "Which declared structures does nothing ever populate?"
 *
 * Every gap AW-26 turned up was an instance of one shape: a column, an enum
 * value, a relation or a directory level that the design declared and no
 * writer ever reached. Those stayed invisible for months because nothing
 * asked the question — and when someone finally noticed an empty column, the
 * natural reading was "bad idea, delete it" rather than "unfinished, wire it
 * up". Twice that reading was wrong.
 *
 * So this answers the question mechanically, and derives what to check from
 * the schema itself (`PRAGMA table_info`) and from the relation vocabulary
 * `@titan-design/session-read` declares. A hand-maintained checklist would rot
 * exactly the way the thing it is checking rotted — which is also why this
 * stayed in active-work when the graph moved into a package: it must read
 * whatever the schema currently is, including tables a later package version
 * adds without telling anyone.
 *
 * Read-only and cheap: one table scan per table, no transcript is opened.
 */

type Db = Database.Database;

export interface ColumnLiveness {
  table: string;
  column: string;
  rows: number;
  nonNull: number;
}

export interface RelationLiveness {
  relation: string;
  count: number;
  /** False for a relation observed in the data but absent from `RELATIONS`. */
  declared: boolean;
}

export interface RefNamespaceLiveness {
  /** The `<prefix>:` of an edge endpoint, e.g. `session`. */
  namespace: string;
  edges: number;
  /** Endpoints with no matching row in the entity table, or null if unmapped. */
  dangling: number | null;
}

export interface LivenessReport {
  /** Columns nothing writes and nothing explains — the headline finding. */
  emptyColumns: ColumnLiveness[];
  /** Empty, but declared so in `EXPECTED_EMPTY`; reported, not flagged. */
  expectedEmptyColumns: (ColumnLiveness & { reason: string })[];
  columns: ColumnLiveness[];
  relations: RelationLiveness[];
  refNamespaces: RefNamespaceLiveness[];
  /** Transcripts recorded `ok` whose file is gone; `status` never says so. */
  staleTranscripts: number;
  transcripts: number;
}

/** Bookkeeping tables that have no product meaning, and the contentless FTS index. */
const SKIP_TABLES = /^(sqlite_|_migration$|search_fts)/;

/**
 * Structures that are empty *on purpose*, with the reason.
 *
 * This is the difference between a diagnostic people act on and one they learn
 * to ignore. Some columns are legitimately never written, and reporting them
 * next to genuine unfinished work trains the reader to skim past both. An entry
 * here is a claim that emptiness is correct — so it carries its justification,
 * and `miner liveness` still prints it, just under a heading that says so.
 */
export const EXPECTED_EMPTY: Record<string, string> = {
  'edge.t_invalid':
    'NULL means current; the index is rebuilt from scratch, so no edge is ever superseded in place',
  'edge.t_expired':
    'NULL means current — idx_edge_current is defined WHERE t_expired IS NULL, so all-NULL is the designed steady state',
  'edge.attrs': 'kit column; the session graph writes no per-edge attributes',
};

/**
 * Where an edge endpoint's `<prefix>:` resolves. Deliberately explicit and
 * colocated with nothing else: an unmapped namespace is *reported* rather
 * than skipped, so adding a ref type without extending this shows up as a
 * finding instead of silently passing.
 */
const REF_TABLES: Record<string, { table: string; column: string; bare?: boolean }> = {
  // `session` is the odd one out: it stores the bare id, every other entity
  // table stores the prefixed ref. Comparing without allowing for that reports
  // every session endpoint as dangling — a false alarm, which in a diagnostic
  // is worse than no check at all.
  session: { table: 'session', column: 'session_id', bare: true },
  agent: { table: 'subagent', column: 'agent_ref' },
  file: { table: 'file', column: 'file_ref' },
  branch: { table: 'branch', column: 'branch_ref' },
  task: { table: 'task', column: 'task_ref' },
  artifact: { table: 'artifact', column: 'artifact_ref' },
  // `pr` is keyed by `pr_ref` like every other entity table. It was left
  // unmapped on the belief that it was keyed by `(number, repo)` — that is
  // `pr_merge_observation`, a different table (AW-107).
  pr: { table: 'pr', column: 'pr_ref' },
};

function tableNames(db: Db): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name).filter((name) => !SKIP_TABLES.test(name));
}

function columnNames(db: Db, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * One scan per table, not one per column: `COUNT(col)` skips NULLs, so every
 * column's population is answered by a single aggregate row. On a 280k-row
 * `fact` table the difference is seconds versus a minute.
 */
function scanTable(db: Db, table: string): ColumnLiveness[] {
  const columns = columnNames(db, table);
  if (columns.length === 0) return [];
  const selects = columns.map((column, index) => `COUNT("${column}") AS c${index}`).join(', ');
  const row = db.prepare(`SELECT COUNT(*) AS total, ${selects} FROM "${table}"`).get() as Record<
    string,
    number
  >;
  return columns.map((column, index) => ({
    table,
    column,
    rows: row.total,
    nonNull: row[`c${index}`] ?? 0,
  }));
}

function relationLiveness(db: Db): RelationLiveness[] {
  const observed = new Map(
    (
      db.prepare('SELECT relation, COUNT(*) AS n FROM edge GROUP BY relation').all() as {
        relation: string;
        n: number;
      }[]
    ).map((row) => [row.relation, row.n]),
  );
  const declared = Object.values(RELATIONS) as string[];
  const report: RelationLiveness[] = declared.map((relation) => ({
    relation,
    count: observed.get(relation) ?? 0,
    declared: true,
  }));
  for (const [relation, count] of observed) {
    if (!declared.includes(relation)) report.push({ relation, count, declared: false });
  }
  return report.sort((a, b) => a.relation.localeCompare(b.relation));
}

function refNamespaces(db: Db): RefNamespaceLiveness[] {
  const rows = db
    .prepare(
      `SELECT namespace, COUNT(*) AS n FROM (
         SELECT substr(source_ref, 1, instr(source_ref, ':') - 1) AS namespace FROM edge
         UNION ALL
         SELECT substr(target_ref, 1, instr(target_ref, ':') - 1) FROM edge
       ) WHERE namespace <> '' GROUP BY namespace ORDER BY namespace`,
    )
    .all() as { namespace: string; n: number }[];

  return rows.map(({ namespace, n }) => {
    const target = REF_TABLES[namespace];
    if (!target) return { namespace, edges: n, dangling: null };
    const lhs = target.bare ? `substr(e.ref, ${namespace.length + 2})` : 'e.ref';
    const { c } = db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT source_ref AS ref FROM edge UNION ALL SELECT target_ref FROM edge
         ) e
         WHERE e.ref LIKE @prefix
           AND NOT EXISTS (SELECT 1 FROM "${target.table}" t WHERE t."${target.column}" = ${lhs})`,
      )
      .get({ prefix: `${namespace}:%` }) as { c: number };
    return { namespace, edges: n, dangling: c };
  });
}

/**
 * Rows still claiming `ok` whose file is gone. `refreshCorpus` marks these at
 * the end of every pass, so a healthy index reports 0 here and a non-zero count
 * means the index is stale rather than that the status is unreachable — which
 * is what it meant when this check was written, and why it was written.
 */
function staleTranscripts(db: Db): number {
  const rows = db.prepare("SELECT source_key FROM transcript WHERE status = 'ok'").all() as {
    source_key: string;
  }[];
  return rows.filter((row) => !existsSync(toAbsolutePath(row.source_key))).length;
}

export function runLiveness(db: Db): LivenessReport {
  const columns = tableNames(db).flatMap((table) => scanTable(db, table));
  // A column in an empty table says nothing, so those are not findings.
  const empty = columns.filter((column) => column.nonNull === 0 && column.rows > 0);
  const reasonFor = (column: ColumnLiveness): string | undefined =>
    EXPECTED_EMPTY[`${column.table}.${column.column}`];
  return {
    emptyColumns: empty.filter((column) => reasonFor(column) === undefined),
    expectedEmptyColumns: empty
      .filter((column) => reasonFor(column) !== undefined)
      .map((column) => ({ ...column, reason: reasonFor(column) as string })),
    columns,
    relations: relationLiveness(db),
    refNamespaces: refNamespaces(db),
    staleTranscripts: staleTranscripts(db),
    transcripts: (db.prepare('SELECT COUNT(*) AS n FROM transcript').get() as { n: number }).n,
  };
}
