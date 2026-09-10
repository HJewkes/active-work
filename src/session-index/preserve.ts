import type { WorkspaceGraph } from './graph.js';

/**
 * The one table in `graph.sqlite3` that is not rebuildable, and the replay that
 * puts it back after a reset.
 *
 * Everything else in this database is derived: drop it and a refresh rebuilds
 * it, which is the invariant the whole indexing design rests on. But the index
 * has acquired rows nothing on disk can produce. TP-23 rebuilt the session
 * index from the transcripts and silently lost 19 sessions — 7,279 facts, 90
 * turns, one of them 882 turns long — because Claude Code had pruned their
 * transcripts. They were recovered from the retired index by hand, and
 * `resetIndex` would erase them again on the next `miner refresh --full`.
 *
 * Two mechanisms were possible and this is the second one:
 *
 * A `derived` flag on the row does not work without forking the package.
 * `resetIndex` runs `DELETE FROM session` over a table list the package owns,
 * so a flagged row is deleted like any other, and teaching it otherwise means
 * reimplementing `resetIndex` in active-work — a copy of somebody else's reset
 * logic, drifting from it.
 *
 * A separate table is invisible to that reset by construction, and it says the
 * truer thing. A preserved row is not a derived row wearing an attribute; it is
 * original data from a second source, with a provenance. That framing yields a
 * sentence worth having: `preserved_row` is the only table here that needs
 * backing up.
 *
 * It also generalises, which was the point. `note.hits` has exactly this
 * property — the owner accepted on 2026-09-10 that a full reindex resets
 * promotion candidates to zero — and a `merge` row over `note.hits` would make
 * that decision revisitable instead of permanent. Nothing writes one yet; TP-27
 * owns the promotion machinery.
 */

/**
 * `insert` re-creates a row the corpus can no longer produce, and yields to a
 * derived row of the same key if one exists — a pruned transcript that comes
 * back always wins. `merge` writes named columns onto a row derivation already
 * produced, for a value that is about the row rather than in it.
 */
export type PreserveMode = 'insert' | 'merge';

export interface PreservedRow {
  table: string;
  keyColumn: string;
  key: string;
  payload: Record<string, string | number | null>;
  /** Where the data came from, in words. Read by whoever finds it years later. */
  origin: string;
  mode: PreserveMode;
}

const UPSERT = `
  INSERT INTO preserved_row (table_name, key_column, row_key, payload, origin, mode)
  VALUES (@table, @keyColumn, @key, @payload, @origin, @mode)
  ON CONFLICT (table_name, row_key) DO UPDATE SET
    key_column = excluded.key_column, payload = excluded.payload,
    origin = excluded.origin, mode = excluded.mode
`;

/** Declare that a row is not derivable, so a rebuild restores it. */
export function preserveRow(graph: WorkspaceGraph, row: PreservedRow): void {
  graph.db.prepare(UPSERT).run({ ...row, payload: JSON.stringify(row.payload) });
}

export function listPreserved(graph: WorkspaceGraph): PreservedRow[] {
  const rows = graph.db
    .prepare('SELECT * FROM preserved_row ORDER BY table_name, row_key')
    .all() as {
    table_name: string;
    key_column: string;
    row_key: string;
    payload: string;
    origin: string;
    mode: PreserveMode;
  }[];
  return rows.map((row) => ({
    table: row.table_name,
    keyColumn: row.key_column,
    key: row.row_key,
    payload: JSON.parse(row.payload) as Record<string, string | number | null>,
    origin: row.origin,
    mode: row.mode,
  }));
}

/** Stop preserving a row — for one recovered by mistake, or superseded by a real source. */
export function forgetPreserved(graph: WorkspaceGraph, table: string, key: string): boolean {
  return (
    graph.db
      .prepare('DELETE FROM preserved_row WHERE table_name = ? AND row_key = ?')
      .run(table, key).changes > 0
  );
}

/**
 * Sessions no transcript on disk can produce any more.
 *
 * Derived from the graph itself rather than from the retired index: a session
 * is unreachable when none of the transcripts its facts name still has status
 * `ok`. That matters, because it means the answer does not depend on having
 * kept an old database around — the live graph knows which of its own rows it
 * could not rebuild.
 *
 * Measured on the live graph, 2026-09-10: 33 sessions, and all 33 are present
 * today. The manual recovery restored 19 of them, so a `miner refresh --full`
 * would have destroyed 14 that nobody had counted.
 */
const UNREACHABLE_SESSIONS = `
  SELECT s.session_id FROM session s
   WHERE NOT EXISTS (
     SELECT 1 FROM fact f JOIN transcript t ON t.source_id = f.transcript_id
      WHERE f.session_id = s.session_id AND t.status = 'ok'
   )
   ORDER BY s.session_id
`;

/** Tables whose rows belong to a session, and the column that identifies one row. */
const SESSION_OWNED: { table: string; keyColumn: string; key: (row: Row) => string }[] = [
  { table: 'session', keyColumn: 'session_id', key: (r) => String(r.session_id) },
  { table: 'turn', keyColumn: 'prompt_id', key: (r) => String(r.prompt_id) },
  {
    table: 'session_model_usage',
    keyColumn: 'session_id',
    key: (r) => `${r.session_id}:${r.model}`,
  },
  { table: 'fact', keyColumn: 'fact_id', key: (r) => `${r.transcript_id}:${r.byte_offset}` },
  {
    table: 'permission_phase',
    keyColumn: 'phase_id',
    key: (r) => `${r.session_id}:${r.t_valid}:${r.to_mode}`,
  },
  {
    table: 'human_edit',
    keyColumn: 'edit_id',
    key: (r) => `${r.session_id}:${r.file_path}:${r.ts}`,
  },
];

type Row = Record<string, string | number | null>;

/** Auto-assigned ids mean nothing after a rebuild, so they are not carried. */
const SYNTHETIC_KEYS = new Set(['fact_id', 'phase_id', 'edit_id', 'checkpoint_id']);

function payloadOf(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([column]) => !SYNTHETIC_KEYS.has(column)));
}

/**
 * Declare every row a rebuild could not reproduce, before one runs.
 *
 * Without this, `preserved_row` is a mechanism waiting for somebody to remember
 * to use it, and `miner refresh --full` still destroys history — which is the
 * failure it exists to prevent, not a smaller version of it.
 */
export function preserveUnreachable(graph: WorkspaceGraph, origin: string): number {
  const ids = (graph.db.prepare(UNREACHABLE_SESSIONS).all() as { session_id: string }[]).map(
    (row) => row.session_id,
  );
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  let preserved = 0;
  graph.db.transaction(() => {
    for (const spec of SESSION_OWNED) {
      const rows = graph.db
        .prepare(`SELECT * FROM "${spec.table}" WHERE session_id IN (${placeholders})`)
        .all(...ids) as Row[];
      for (const row of rows) {
        const payload = payloadOf(row);
        preserveRow(graph, {
          table: spec.table,
          keyColumn: spec.keyColumn,
          key: spec.key(row),
          payload,
          origin,
          mode: 'insert',
        });
        preserved++;
      }
    }
  })();
  return preserved;
}

export interface ReplaySummary {
  /** Rows re-created because nothing derived them. */
  restored: number;
  /** Rows whose named columns were written onto a derived row. */
  merged: number;
  /** Rows left alone because derivation already produced them. */
  skipped: number;
}

function restore(graph: WorkspaceGraph, row: PreservedRow): boolean {
  const columns = Object.keys(row.payload);
  const names = columns.map((c) => `"${c}"`).join(', ');
  const values = columns.map((c) => `@${c}`).join(', ');
  const info = graph.db
    .prepare(`INSERT OR IGNORE INTO "${row.table}" (${names}) VALUES (${values})`)
    .run(row.payload);
  return info.changes > 0;
}

function merge(graph: WorkspaceGraph, row: PreservedRow): boolean {
  const assignments = Object.keys(row.payload)
    .map((c) => `"${c}" = @${c}`)
    .join(', ');
  const info = graph.db
    .prepare(`UPDATE "${row.table}" SET ${assignments} WHERE "${row.keyColumn}" = @__key`)
    .run({ ...row.payload, __key: row.key });
  return info.changes > 0;
}

/**
 * Put every preserved row back, after a reset or after any pass.
 *
 * Run unconditionally rather than only behind `--full`: it is idempotent, it
 * costs one statement per preserved row, and running it every pass means a
 * partial or accidental delete heals itself rather than waiting for someone to
 * notice.
 */
export function replayPreserved(graph: WorkspaceGraph): ReplaySummary {
  const summary: ReplaySummary = { restored: 0, merged: 0, skipped: 0 };
  graph.db.transaction(() => {
    for (const row of listPreserved(graph)) {
      if (row.mode === 'merge') {
        if (merge(graph, row)) summary.merged++;
        else summary.skipped++;
        continue;
      }
      if (restore(graph, row)) summary.restored++;
      else summary.skipped++;
    }
  })();
  return summary;
}
