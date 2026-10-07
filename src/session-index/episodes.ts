import { staleEpisodeSessions, writeEpisodes } from '@titan-design/session-analytics';
import type { WorkspaceGraph } from './graph.js';

/**
 * The episode step of a refresh pass (TP-342): `writeEpisodes` has no caller
 * inside session-graph, so the pass decides here which sessions to segment.
 *
 * A session is stale when its class has a heuristic and its main-thread
 * requests run past the episodes stored for that heuristic, or none are stored.
 * Headless classes have no heuristic, so they never count as stale, and a
 * session with no main-thread request is never stale because segmenting it
 * would write nothing and leave it stale forever. session-analytics owns that
 * check, so it classifies with the same session facts as `writeEpisodes`.
 */

export { staleEpisodeSessions };

export const DEFAULT_EPISODE_LIMIT = 200;

export interface EpisodePass {
  /** Sessions whose episodes this pass rewrote. */
  episodesWritten: number;
  /** Stale sessions left for a later pass; null when the pass did not sweep the backlog. */
  episodeBacklog: number | null;
}

/** Transcript id to watermark offset, taken before the pass reads anything. */
export function snapshotOffsets(graph: WorkspaceGraph): Map<number, number> {
  return new Map(graph.transcripts.list().map((row) => [row.sourceId, row.lastOffset]));
}

/** Sessions with a request in a transcript whose watermark moved since `before`. */
function sessionsChangedSince(graph: WorkspaceGraph, before: Map<number, number>): Set<string> {
  const moved = graph.transcripts
    .list()
    .filter((row) => before.get(row.sourceId) !== row.lastOffset)
    .map((row) => row.sourceId);
  const rows = graph.db
    .prepare<[string], { sessionId: string }>(
      `SELECT DISTINCT session_id AS sessionId FROM request
        WHERE transcript_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(moved));
  return new Set(rows.map((row) => row.sessionId));
}

/**
 * Every stale session a moved transcript touched, plus up to `limit` more from
 * the backlog when `sweep` is set. `Infinity` clears it.
 *
 * The stale check reads session-analytics' `request_dedup` view, a window over
 * the whole `request` table that a session scope cannot narrow, so even a
 * scoped check costs about a second of main thread on the live graph (TP-343).
 * A pass that does not sweep therefore skips it when no transcript moved.
 *
 * One session per `writeEpisodes` call, yielding after each: a session costs
 * about 450 ms on the live graph, so one batched call held the daemon's event
 * loop for seconds and starved `context.related` (TP-343).
 */
export async function refreshEpisodes(
  graph: WorkspaceGraph,
  before: Map<number, number>,
  limit: number = DEFAULT_EPISODE_LIMIT,
  yieldPoint: () => Promise<void>,
  sweep = true,
): Promise<EpisodePass> {
  const changed = sessionsChangedSince(graph, before);
  if (!sweep && changed.size === 0) return { episodesWritten: 0, episodeBacklog: null };
  const stale = staleEpisodeSessions(graph.db, sweep ? undefined : [...changed]);
  const due = stale.filter((id) => changed.has(id));
  const batch = sweep ? stale.filter((id) => !changed.has(id)).slice(0, limit) : [];
  let written = 0;
  for (const sessionId of [...due, ...batch]) {
    written += writeEpisodes(graph, [sessionId]).length;
    await yieldPoint();
  }
  return {
    episodesWritten: written,
    episodeBacklog: sweep ? stale.length - due.length - batch.length : null,
  };
}
