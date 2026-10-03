import { rollupSessions } from '@titan-design/session-graph';
import type { WorkspaceGraph } from './graph.js';

/**
 * Both owners: a turn's row keeps the lower session id on a prompt-id clash,
 * while the rollup aggregates by the session its facts carry.
 */
const UNFINISHED_SESSIONS = `
  SELECT session_id FROM turn WHERE ended_at IS NULL
  UNION
  SELECT session_id FROM fact
  WHERE prompt_id IN (SELECT prompt_id FROM turn WHERE ended_at IS NULL)`;

/**
 * Roll up every session that still has a turn with no `ended_at`.
 *
 * A pass advances each transcript's watermark as it indexes it and rolls up
 * only after the loop, so a pass killed or thrown in between leaves turns no
 * later pass would revisit (TP-875). The rollup sets `ended_at` on every turn
 * it reaches, so in steady state this finds nothing: one scan of the narrow
 * `turn` table, about 16k rows on the live graph as of 2026-10-03.
 */
export function rollupUnfinishedTurns(graph: WorkspaceGraph): number {
  const rows = graph.db.prepare<[], { session_id: string }>(UNFINISHED_SESSIONS).all();
  return rollupSessions(
    graph,
    rows.map((row) => row.session_id),
  );
}
