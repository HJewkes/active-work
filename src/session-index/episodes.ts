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
  /** Stale sessions left for a later pass; null when the pass did not sweep the backlog. */
  episodeBacklog: number | null;
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

/**
 * The dedup `request_dedup` applies, without the view: its window over the
 * whole `request` table blocks any session filter from pushing down (TP-343).
 * A copied request belongs only to its earliest `(ts, transcript_id)` copy.
 * `ts` and `request_id` are NOT NULL and a transcript cannot repeat a request id,
 * so the tie-break is total.
 */
const FIRST_COPY = `NOT EXISTS (
    SELECT 1 FROM request e
     WHERE e.request_id = r.request_id
       AND (e.ts < r.ts OR (e.ts = r.ts AND e.transcript_id < r.transcript_id)))`;

const IN_SCOPE = 'session_id IN (SELECT value FROM json_each(@ids))';

function sessionsWithRequests(scoped: boolean): string {
  const scope = (column: string) => (scoped ? `AND ${column}${IN_SCOPE}` : '');
  return `
  WITH last_request AS (
    SELECT r.session_id, MAX(r.ts) AS last_ts FROM request r
     WHERE r.is_sidechain = 0 AND ${FIRST_COPY} ${scope('r.')} GROUP BY r.session_id
  ), human_turns AS (
    SELECT session_id, SUM(delivery = 'turn_start') AS n FROM inbound
     WHERE cause = 'human_typed' ${scope('')} GROUP BY session_id
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
}

const ALL_SESSIONS = sessionsWithRequests(false);
const SCOPED_SESSIONS = sessionsWithRequests(true);

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

function sessionRows(db: Database.Database, ids: readonly string[] | undefined): SessionRow[] {
  if (ids === undefined) return db.prepare<[], SessionRow>(ALL_SESSIONS).all();
  return db
    .prepare<[{ ids: string }], SessionRow>(SCOPED_SESSIONS)
    .all({ ids: JSON.stringify(ids) });
}

/**
 * Stale session ids, most recently active first: every session, or only `ids`.
 * Timestamps compare parsed, because a worker episode can end on an inbound
 * whose ISO form differs from the request's.
 */
export function staleEpisodeSessions(db: Database.Database, ids?: readonly string[]): string[] {
  const ends = episodeEnds(db);
  return sessionRows(db, ids)
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
 * the backlog when `sweep` is set. `Infinity` clears it. Without `sweep` the
 * pass reads only the touched sessions, since the full check costs about a
 * second of main thread on the live graph (TP-343).
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
