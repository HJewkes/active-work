import { staleEpisodeSessions, writeEpisodes } from '@titan-design/session-analytics';
import { EPISODE_TABLE } from '@titan-design/session-graph';
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

const CANDIDATES = `
  SELECT r.session_id AS sessionId, MAX(r.ts) AS lastRequestAt,
         (SELECT MIN(ended) FROM (SELECT MAX(e.ended_at) AS ended FROM "${EPISODE_TABLE}" e
            WHERE e.session_id = r.session_id GROUP BY e.heuristic)) AS endedAt
    FROM request r
   WHERE r.is_sidechain = 0 AND r.session_id IN (SELECT value FROM json_each(?))
   GROUP BY r.session_id ORDER BY lastRequestAt DESC, r.session_id`;

/**
 * The changed sessions that may be stale: a main-thread request past the
 * earliest of their per-heuristic episode ends, or no episodes. Raw `request`
 * rows never end earlier than `request_dedup`'s, so this is a superset of
 * `staleEpisodeSessions`, read through `idx_request_session_ts` instead of the
 * view (TP-343). `writeEpisodes` still picks the heuristic, or none.
 */
function episodeCandidates(graph: WorkspaceGraph, changed: Set<string>): string[] {
  if (changed.size === 0) return [];
  const rows = graph.db
    .prepare<[string], { sessionId: string; lastRequestAt: string; endedAt: string | null }>(
      CANDIDATES,
    )
    .all(JSON.stringify([...changed]));
  return rows
    .filter((row) => row.endedAt === null || Date.parse(row.lastRequestAt) > Date.parse(row.endedAt))
    .map((row) => row.sessionId);
}

/**
 * Every changed session that may be stale, plus up to `limit` more from the
 * backlog when `sweep` is set. `Infinity` clears it.
 *
 * Only the sweep calls `staleEpisodeSessions`: it reads session-analytics'
 * `request_dedup` view, a window over the whole `request` table that a session
 * scope cannot narrow, so it costs about a second of main thread on the live
 * graph whatever its scope (TP-343). A pass that does not sweep never runs it.
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
  const due = episodeCandidates(graph, changed);
  const stale = sweep ? staleEpisodeSessions(graph.db).filter((id) => !changed.has(id)) : [];
  const batch = stale.slice(0, limit);
  let written = 0;
  for (const sessionId of [...due, ...batch]) {
    written += writeEpisodes(graph, [sessionId]).length;
    await yieldPoint();
  }
  return {
    episodesWritten: written,
    episodeBacklog: sweep ? stale.length - batch.length : null,
  };
}
