import type Database from 'better-sqlite3';
import { EPISODE_TABLE } from '@titan-design/session-graph';
import {
  classifySession,
  heuristicFor,
  writeEpisodes,
  type Heuristic,
  type SessionFacts,
} from '@titan-design/session-analytics';
import type { WorkspaceGraph } from './graph.js';

/**
 * The episode step of a refresh pass (TP-342): `writeEpisodes` has no caller
 * inside session-graph, so the pass decides here which sessions to segment.
 *
 * A session is stale when its class has a heuristic and its main-thread
 * requests run past the episodes stored for that heuristic, or none are stored.
 * Headless classes have no heuristic, so they never count as stale, and a
 * session with no main-thread request is never stale because segmenting it
 * would write nothing and leave it stale forever.
 */

export const DEFAULT_EPISODE_LIMIT = 200;

export interface EpisodePass {
  /** Sessions whose episodes this pass rewrote. */
  episodesWritten: number;
  /** Stale sessions left for a later pass. */
  episodeBacklog: number;
}

interface SessionRow {
  sessionId: string;
  lastRequestAt: string;
  startType: string | null;
  seedPrompt: string | null;
  hasOrigin: number;
  depth: number | null;
  parentName: string | null;
  originKind: string | null;
  profile: string | null;
  humanTurns: number | null;
}

// request_dedup, not request: a copied request belongs only to the session the view keeps it for.
const SESSIONS_WITH_REQUESTS = `
  WITH last_request AS (
    SELECT session_id, MAX(ts) AS last_ts FROM request_dedup
     WHERE is_sidechain = 0 GROUP BY session_id
  ), human_turns AS (
    SELECT session_id, SUM(delivery = 'turn_start') AS n FROM inbound
     WHERE cause = 'human_typed' GROUP BY session_id
  )
  SELECT r.session_id AS sessionId, r.last_ts AS lastRequestAt,
         s.start_type AS startType, s.seed_prompt AS seedPrompt,
         o.session_id IS NOT NULL AS hasOrigin, o.depth, o.parent_name AS parentName,
         o.origin_kind AS originKind, o.profile, h.n AS humanTurns
    FROM last_request r
    LEFT JOIN session s ON s.session_id = r.session_id
    LEFT JOIN session_origin o ON o.session_id = r.session_id
    LEFT JOIN human_turns h ON h.session_id = r.session_id
   ORDER BY r.last_ts DESC, r.session_id`;

const EPISODE_ENDS = `
  SELECT session_id AS sessionId, heuristic, MAX(ended_at) AS endedAt
    FROM "${EPISODE_TABLE}" GROUP BY session_id, heuristic`;

/** The same facts `writeEpisodes` classifies by, so both sides pick the same heuristic. */
function factsOf(row: SessionRow): SessionFacts {
  const origin = row.hasOrigin
    ? {
        depth: row.depth ?? 0,
        parentName: row.parentName,
        originKind: row.originKind,
        profile: row.profile,
      }
    : null;
  return {
    startType: row.startType,
    firstUserText: row.seedPrompt,
    humanTurnCount: row.humanTurns ?? 0,
    origin,
  };
}

function episodeEnds(db: Database.Database): Map<string, number> {
  const rows = db
    .prepare<[], { sessionId: string; heuristic: Heuristic; endedAt: string }>(EPISODE_ENDS)
    .all();
  return new Map(
    rows.map((row) => [endKey(row.sessionId, row.heuristic), Date.parse(row.endedAt)]),
  );
}

const endKey = (sessionId: string, heuristic: Heuristic): string =>
  `${sessionId}\u0000${heuristic}`;

/**
 * Stale session ids, most recently active first. Timestamps compare parsed,
 * because a worker episode can end on an inbound whose ISO form differs from
 * the request's.
 */
export function staleEpisodeSessions(db: Database.Database): string[] {
  const ends = episodeEnds(db);
  return db
    .prepare<[], SessionRow>(SESSIONS_WITH_REQUESTS)
    .all()
    .filter((row) => {
      const heuristic = heuristicFor(classifySession(factsOf(row)).sessionClass);
      if (!heuristic) return false;
      const endedAt = ends.get(endKey(row.sessionId, heuristic));
      return endedAt === undefined || Date.parse(row.lastRequestAt) > endedAt;
    })
    .map((row) => row.sessionId);
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
 * the backlog. `Infinity` clears it.
 */
export function refreshEpisodes(
  graph: WorkspaceGraph,
  before: Map<number, number>,
  limit: number = DEFAULT_EPISODE_LIMIT,
): EpisodePass {
  const stale = staleEpisodeSessions(graph.db);
  const changed = sessionsChangedSince(graph, before);
  const due = stale.filter((id) => changed.has(id));
  const batch = stale.filter((id) => !changed.has(id)).slice(0, limit);
  const written = writeEpisodes(graph, [...due, ...batch]);
  return {
    episodesWritten: written.length,
    episodeBacklog: stale.length - due.length - batch.length,
  };
}
