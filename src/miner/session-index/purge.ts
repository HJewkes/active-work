import type { SessionIndexDb } from './db.js';

/**
 * Remove everything one transcript contributed to the index.
 *
 * Needed because a rotated transcript (rewritten rather than appended to —
 * `extract.ts:resolveStartOffset` reports this as `restartedFromZero`) is
 * re-read from byte 0. The append-only tables are idempotent under a unique
 * index, but `sessions` and `session_model_usage` use *accumulating* upserts
 * (`turn_count = turn_count + excluded.turn_count`, token buckets, commit/push
 * counts): re-applying them without a purge silently doubles every counter.
 *
 * Scoping rules:
 *  - Fact-linked rows are deleted through `facts.transcript_id`, so they are
 *    removed exactly, whatever session they belong to.
 *  - `sessions` / `session_model_usage` are session-keyed, and a session can
 *    (rarely — resume/compact) span transcripts. Only sessions with no facts
 *    left in any *other* transcript are deleted; a genuinely shared session
 *    keeps its row and its counters, so its share of this transcript is
 *    double-counted until a `refresh --full`. Deleting it instead would throw
 *    away the sibling transcript's contribution, which is strictly worse.
 *  - Asset tables (`prs`/`branches`/`files`/`tasks`/`artifacts`) are NOT
 *    touched: they are insert-if-absent, shared across transcripts, and carry
 *    no counters, so a stale row is a harmless unreferenced asset. `--full`
 *    collects them.
 *  - `spans_fts` rows are left orphaned by design — a contentless FTS5 table
 *    cannot delete a row without its original text. Every query joins
 *    `searchable_spans` on `spans_fts.rowid = searchable_spans.span_id`, which
 *    makes orphans invisible; `refresh --full` clears them.
 *
 * Must run inside the caller's transaction so a crash cannot strand a
 * half-purged transcript.
 */
export function purgeTranscript(db: SessionIndexDb, transcriptId: number): void {
  // Delete order across self- and cross-referencing tables is fiddly and would
  // otherwise have to be re-derived every time the schema grows a table;
  // deferring FK checks to COMMIT makes the order irrelevant. Scoped to this
  // transaction by SQLite.
  db.pragma('defer_foreign_keys = ON');

  const exclusiveSessions = db
    .prepare<[number, number], { session_id: string }>(
      `SELECT DISTINCT session_id FROM facts WHERE transcript_id = ?
         AND session_id NOT IN (SELECT session_id FROM facts WHERE transcript_id != ?)`,
    )
    .all(transcriptId, transcriptId)
    .map((row) => row.session_id);

  const factIds = 'SELECT fact_id FROM facts WHERE transcript_id = ?';
  const sessionList = exclusiveSessions.map(() => '?').join(',');
  // `fact_id` is nullable on these tables (the writer only resolves one when
  // the extractor supplied a byte offset), so the session predicate is what
  // catches rows a fact join would miss.
  const byFactOrSession = (table: string, factColumn: string): string =>
    `DELETE FROM ${table} WHERE ${factColumn} IN (${factIds})` +
    (exclusiveSessions.length > 0 ? ` OR session_id IN (${sessionList})` : '');

  db.prepare('DELETE FROM searchable_spans WHERE transcript_id = ?').run(transcriptId);
  db.prepare(`DELETE FROM edges WHERE fact_id IN (${factIds})`).run(transcriptId);
  for (const [table, column] of [
    ['turns', 'fact_id_start'],
    ['permission_phases', 'fact_id'],
    ['human_edits', 'fact_id'],
    ['subagents', 'fact_id'],
  ] as const) {
    db.prepare(byFactOrSession(table, column)).run(transcriptId, ...exclusiveSessions);
  }
  db.prepare('DELETE FROM facts WHERE transcript_id = ?').run(transcriptId);

  if (exclusiveSessions.length === 0) return;
  db.prepare(`DELETE FROM session_model_usage WHERE session_id IN (${sessionList})`).run(
    ...exclusiveSessions,
  );
  db.prepare(`DELETE FROM sessions WHERE session_id IN (${sessionList})`).run(...exclusiveSessions);
}
