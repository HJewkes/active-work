import type { SessionIndexDb } from './db.js';

/**
 * Recompute the per-turn aggregates that cannot be derived from a single JSONL
 * line.
 *
 * **Contract: recompute, never accumulate.** Every value here is written with
 * `SET x = <expression over the current facts table>`, never `x = x + delta`.
 * That is what makes an incremental refresh and a full rebuild converge: the
 * result is a pure function of the rows currently in `facts`, so it does not
 * matter how many chunks produced them or where the boundaries fell.
 *
 * Scoped to the sessions a refresh actually touched, and called once per
 * refresh pass rather than per transcript — a session split across transcripts
 * (resume/compact) is then rolled up from all of its facts at once.
 *
 * `turns.started_at` is deliberately untouched: it comes from the prompt line
 * itself and is already correct.
 */

/**
 * Sessions per statement. The id list crosses as a single JSON parameter (via
 * `json_each`) rather than N placeholders, so this bounds the JSON string and
 * the size of the window pass, not a variable count.
 */
const BATCH = 400;

/**
 * Attribute every fact to the turn it belongs to, then aggregate.
 *
 * Attribution can't use `MAX(prompt_id) OVER (...)` — prompt ids are uuids, so
 * "largest so far" is not "most recent". Counting the `user_prompt` facts seen
 * so far gives a monotonic turn ordinal instead, which joins back to the prompt
 * that opened it.
 *
 * `thinking_ms` is wall-clock: the gap between an assistant fact and the
 * `user_prompt` or `tool_result` immediately before it, summed within the turn.
 */
const ROLLUP = `
  WITH ordered AS (
    SELECT
      fact_id, session_id, event_type, ts, prompt_id,
      COUNT(CASE WHEN event_type = 'user_prompt' THEN 1 END) OVER (
        PARTITION BY session_id ORDER BY ts, transcript_id, seq
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS turn_no,
      LAG(event_type) OVER (
        PARTITION BY session_id ORDER BY ts, transcript_id, seq) AS prev_type,
      LAG(ts) OVER (
        PARTITION BY session_id ORDER BY ts, transcript_id, seq) AS prev_ts
    FROM facts
    WHERE session_id IN (SELECT value FROM json_each(@sessionIds))
  ),
  owners AS (
    SELECT session_id, turn_no, prompt_id FROM ordered WHERE event_type = 'user_prompt'
  ),
  agg AS (
    SELECT
      owners.prompt_id AS prompt_id,
      MAX(ordered.ts) AS ended_at,
      -- ROUND before CAST: julianday is a float, so a whole number of seconds
      -- lands a hair under the integer and CAST truncates it to n-1.
      CAST(ROUND((julianday(MAX(ordered.ts)) - julianday(MIN(ordered.ts))) * 86400000) AS INTEGER)
        AS duration_ms,
      SUM(CASE WHEN ordered.event_type = 'tool_decision' THEN 1 ELSE 0 END) AS tool_call_count,
      CAST(COALESCE(SUM(CASE
        WHEN ordered.event_type IN ('assistant_response', 'tool_decision')
         AND ordered.prev_type IN ('user_prompt', 'tool_result', 'tool_result_error')
        THEN ROUND((julianday(ordered.ts) - julianday(ordered.prev_ts)) * 86400000)
      END), 0) AS INTEGER) AS thinking_ms
    FROM ordered
    JOIN owners ON owners.session_id = ordered.session_id AND owners.turn_no = ordered.turn_no
    GROUP BY owners.prompt_id
  )
  UPDATE turns SET
    ended_at        = agg.ended_at,
    duration_ms     = COALESCE(agg.duration_ms, 0),
    tool_call_count = agg.tool_call_count,
    thinking_ms     = COALESCE(agg.thinking_ms, 0)
  FROM agg WHERE turns.prompt_id = agg.prompt_id`;

/**
 * Recompute turn aggregates for the given sessions. No-op on an empty list.
 * Runs in one transaction so a reader never sees half a pass.
 */
export function rollupSessions(db: SessionIndexDb, sessionIds: readonly string[]): number {
  const unique = [...new Set(sessionIds)];
  if (unique.length === 0) return 0;
  const statement = db.prepare(ROLLUP);
  return db.transaction(() => {
    let updated = 0;
    for (let i = 0; i < unique.length; i += BATCH) {
      const batch = unique.slice(i, i + BATCH);
      updated += statement.run({ sessionIds: JSON.stringify(batch) }).changes;
    }
    return updated;
  })();
}

/** Every session in the index — the scope a full rebuild rolls up. */
export function allSessionIds(db: SessionIndexDb): string[] {
  return db
    .prepare<[], { session_id: string }>('SELECT session_id FROM sessions')
    .all()
    .map((row) => row.session_id);
}
