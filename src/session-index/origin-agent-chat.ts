import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ExternalEvent,
  OriginResolution,
  OriginResolver,
  ResolvedOrigin,
} from '@titan-design/session-graph';

/**
 * Who launched a session, read from agent-chat's own record (TP-274).
 *
 * A `claude -p` worker and a headless miner look the same from inside their
 * transcripts; only the launcher knows which one spawned which. The human
 * allowed reading `events.db` directly, read-only, as a temporary coupling
 * until agent-chat exports the same rows itself (decision Q2). Everything that
 * touches agent-chat's files sits behind `SpawnSource`, so that swap replaces
 * one implementation and none of the mapping.
 */

export const ORIGIN_SYSTEM = 'agent-chat';
export const BRIEF_EXCERPT_CHARS = 400;

const LIFECYCLE_KINDS = [
  'agent_spawned',
  'agent_attached',
  'agent_resumed',
  'agent_handoff',
  'agent_retired',
  'agent_exited',
] as const;

/** One `events` row, with `ts` in epoch milliseconds and `meta` parsed. */
export interface LifecycleEvent {
  ts: number;
  kind: string;
  actor: string;
  target: string | null;
  ref: string | null;
  meta: Record<string, unknown>;
}

export interface LaunchPlan {
  path: string;
  brief: string;
}

/** What the resolver needs from a launcher: its lifecycle rows and each agent's brief. */
export interface SpawnSource {
  /** Agent lifecycle rows, oldest first; empty when the launcher has no record. */
  events(): LifecycleEvent[];
  plan(agentId: string): LaunchPlan | null;
}

export type OpenDatabase = (file: string, options: Database.Options) => Database.Database;

const openBetterSqlite: OpenDatabase = (file, options) => new Database(file, options);

export function agentChatHome(): string {
  return process.env.AGENT_CHAT_HOME ?? path.join(os.homedir(), '.agent-chat');
}

/** agent-chat's `events.db` and `agents/<id>/plan.json`, never opened for writing. */
export function eventsDbSource(
  home: string = agentChatHome(),
  open: OpenDatabase = openBetterSqlite,
): SpawnSource {
  return {
    events: () => readLifecycleEvents(path.join(home, 'events.db'), open),
    plan: (agentId) => readPlan(path.join(home, 'agents', agentId, 'plan.json')),
  };
}

function readLifecycleEvents(file: string, open: OpenDatabase): LifecycleEvent[] {
  if (!existsSync(file)) return [];
  const db = open(file, { readonly: true, fileMustExist: true });
  try {
    const kinds = LIFECYCLE_KINDS.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT ts, kind, actor, target, ref, meta FROM events WHERE kind IN (${kinds}) ORDER BY id`,
      )
      .all(...LIFECYCLE_KINDS) as (Omit<LifecycleEvent, 'meta'> & { meta: string | null })[];
    return rows.map((row) => ({ ...row, meta: parseMeta(row.meta) }));
  } finally {
    db.close();
  }
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Headless launches pipe the brief on `stdin`; pane launches pass it as the
 * positional prompt after `--`, which is 1,134 of 1,278 plans as of 2026-09-23.
 */
function readPlan(file: string): LaunchPlan | null {
  let plan: { stdin?: unknown; args?: unknown };
  try {
    plan = JSON.parse(readFileSync(file, 'utf8')) as typeof plan;
  } catch {
    return null;
  }
  const brief = typeof plan.stdin === 'string' ? plan.stdin : promptArg(plan.args);
  return brief === null ? null : { path: file, brief };
}

function promptArg(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  const prompt: unknown = args[args.lastIndexOf('--') + 1];
  return args.includes('--') && typeof prompt === 'string' ? prompt : null;
}

export function agentChatOriginResolver(source: SpawnSource = eventsDbSource()): OriginResolver {
  return (sessionIds) => resolveFromSource(source, sessionIds);
}

export function resolveFromSource(
  source: SpawnSource,
  sessionIds: readonly string[],
): OriginResolution {
  const wanted = new Set(sessionIds);
  const index = buildIndex(source.events());
  const origins: Record<string, ResolvedOrigin> = {};
  for (const spawn of index.spawns) {
    if (wanted.has(spawn.sessionId)) origins[spawn.sessionId] = toOrigin(spawn, index, source);
  }
  const externalEvents = index.events
    .map((event) => toExternalEvent(event, index))
    .filter((event): event is ExternalEvent => event !== null && wanted.has(event.sessionId));
  return { origins, externalEvents };
}

interface Spawn {
  ts: number;
  actor: string;
  name: string;
  sessionId: string;
  agentId: string | null;
  meta: Record<string, unknown>;
}

interface SessionSighting {
  ts: number;
  sessionId: string;
}

interface SpawnIndex {
  spawns: Spawn[];
  spawnsByName: Map<string, Spawn[]>;
  sessionsByAgent: Map<string, SessionSighting[]>;
  events: LifecycleEvent[];
}

function buildIndex(events: LifecycleEvent[]): SpawnIndex {
  const attaches = events.filter((e) => e.kind === 'agent_attached' && e.ref);
  const spawns = events
    .filter((e) => e.kind === 'agent_spawned')
    .map((e) => toSpawn(e, attaches))
    .filter((spawn): spawn is Spawn => spawn !== null);
  return {
    spawns,
    spawnsByName: groupBy(spawns, (spawn) => spawn.name),
    sessionsByAgent: sessionSightings(spawns, events),
    events,
  };
}

/**
 * A spawn row names the child but not its agent id; the child's first attach
 * under that name does. Names are unique among live agents, so the first
 * attach at or after the spawn is the same agent.
 */
function toSpawn(event: LifecycleEvent, attaches: LifecycleEvent[]): Spawn | null {
  const name = text(event.meta.name) ?? event.target;
  const sessionId = text(event.meta.session_id);
  if (!name || !sessionId) return null;
  const attach = attaches.find((a) => a.actor === name && a.ts >= event.ts);
  return {
    ts: event.ts,
    actor: event.actor,
    name,
    sessionId,
    agentId: attach?.ref ?? null,
    meta: event.meta,
  };
}

function sessionSightings(
  spawns: Spawn[],
  events: LifecycleEvent[],
): Map<string, SessionSighting[]> {
  const sightings: [string, SessionSighting][] = spawns
    .filter((spawn) => spawn.agentId !== null)
    .map((spawn) => [spawn.agentId as string, { ts: spawn.ts, sessionId: spawn.sessionId }]);
  for (const event of events) {
    const sessionId = text(event.meta.session_id);
    if (event.kind !== 'agent_spawned' && event.ref && sessionId) {
      sightings.push([event.ref, { ts: event.ts, sessionId }]);
    }
  }
  const byAgent = new Map<string, SessionSighting[]>();
  for (const [agentId, sighting] of sightings) {
    byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), sighting]);
  }
  for (const list of byAgent.values()) list.sort((a, b) => a.ts - b.ts);
  return byAgent;
}

function toOrigin(spawn: Spawn, index: SpawnIndex, source: SpawnSource): ResolvedOrigin {
  const { meta } = spawn;
  const plan = spawn.agentId ? source.plan(spawn.agentId) : null;
  return {
    originSystem: ORIGIN_SYSTEM,
    agentId: spawn.agentId,
    agentName: spawn.name,
    parentName: spawn.actor,
    parentSessionId: parentSessionId(spawn, index),
    profile: text(meta.profile),
    modelAlias: text(meta.model),
    surface: text(meta.surface),
    isolation: text(meta.isolation),
    depth: integer(meta.depth),
    originKind: text(meta.origin) ?? 'spawned',
    configDir: text(meta.config_dir),
    spawnCwd: text(meta.cwd),
    spawnedAt: new Date(spawn.ts).toISOString(),
    briefChars: plan ? plan.brief.length : null,
    briefExcerpt: plan ? plan.brief.slice(0, BRIEF_EXCERPT_CHARS) : null,
    briefPath: plan?.path ?? null,
  };
}

/**
 * By the parent's agent id first: a coordinator that renamed itself after
 * adoption spawns under a name no spawn row carries. The name rule from the
 * design is the fallback for rows that predate `meta.parent`. A depth-0 row is
 * an adopted human session, often adopted under its own name again after a
 * restart, so the name rule would call its previous session its parent.
 */
function parentSessionId(spawn: Spawn, index: SpawnIndex): string | null {
  if (integer(spawn.meta.depth) === 0) return null;
  const parentId = text(spawn.meta.parent);
  const byAgent = parentId ? sessionAt(index.sessionsByAgent.get(parentId), spawn.ts) : null;
  if (byAgent && byAgent !== spawn.sessionId) return byAgent;
  const byName = (index.spawnsByName.get(spawn.actor) ?? []).filter(
    (candidate) => candidate.ts < spawn.ts && candidate.sessionId !== spawn.sessionId,
  );
  return byName.at(-1)?.sessionId ?? null;
}

function sessionAt(sightings: SessionSighting[] | undefined, ts: number): string | null {
  const before = (sightings ?? []).filter((sighting) => sighting.ts <= ts);
  return before.at(-1)?.sessionId ?? null;
}

function toExternalEvent(event: LifecycleEvent, index: SpawnIndex): ExternalEvent | null {
  const mapped = externalKind(event);
  if (!mapped) return null;
  const sessionId =
    text(event.meta.session_id) ??
    (event.ref ? sessionAt(index.sessionsByAgent.get(event.ref), event.ts) : null);
  if (!sessionId) return null;
  return {
    sessionId,
    ts: new Date(event.ts).toISOString(),
    kind: mapped.kind,
    detail: mapped.detail,
    originSystem: ORIGIN_SYSTEM,
  };
}

function externalKind(event: LifecycleEvent): { kind: string; detail: string | null } | null {
  const { meta } = event;
  switch (event.kind) {
    case 'agent_resumed': {
      const from = text(meta.from_surface);
      return from ? { kind: 'teleport', detail: `${from} to ${text(meta.surface) ?? '?'}` } : null;
    }
    case 'agent_handoff':
      return { kind: 'handoff', detail: labelled('successor', meta.successor) };
    case 'agent_retired':
      return { kind: 'retired', detail: meta.reaped === 'true' ? 'reaped' : null };
    case 'agent_exited':
      return { kind: 'exited', detail: labelled('code', meta.code) };
    default:
      return null;
  }
}

function labelled(label: string, value: unknown): string | null {
  const shown = text(value);
  return shown === null ? null : `${label} ${shown}`;
}

function text(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value !== '' ? value : null;
}

function integer(value: unknown): number | null {
  const parsed = Number(text(value) ?? Number.NaN);
  return Number.isInteger(parsed) ? parsed : null;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
