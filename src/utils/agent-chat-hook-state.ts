import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite } from './fs-atomic.js';
import { getStateRoot } from './paths.js';

/**
 * AW-99: on_spawn (CC-71) knows the spawn context but not yet how the peer
 * exits; on_complete knows the exit but nothing else. This is the bridge
 * between them — one small JSON file per live agent, deleted on read.
 * Ephemeral by design: a peer that never completes (or whose on_spawn never
 * matched an initiative) just leaves an orphaned file here, not a growing
 * durable record.
 */
const SpawnContextSchema = z.object({
  slug: z.string().min(1),
  sessionId: z.string().min(1),
  name: z.string(),
  started: z.string(),
  /**
   * The spawning session, already resolved from the payload's `parent`
   * agentId to a session id. Resolved at spawn time on purpose: `parent` names
   * an agent, and the only thing that can map an agent to its session is
   * another live entry in this same directory — which is gone by the time
   * on_complete runs, because reading one deletes it.
   */
  parentSessionId: z.string().min(1).nullable().default(null),
  /** agent-chat profile and briefing slug, for the recorded session's prose. */
  profile: z.string().nullable().default(null),
  briefing: z.string().nullable().default(null),
});

export type SpawnContext = z.infer<typeof SpawnContextSchema>;

function stateDir(): string {
  return path.join(getStateRoot(), 'agent-chat-hooks');
}

function stateFile(agentId: string): string {
  return path.join(stateDir(), `${agentId}.json`);
}

export async function stashSpawnContext(agentId: string, context: SpawnContext): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true });
  await atomicWrite(stateFile(agentId), JSON.stringify(context));
}

async function readSpawnContext(agentId: string): Promise<SpawnContext | null> {
  let raw: string;
  try {
    raw = await fs.readFile(stateFile(agentId), 'utf8');
  } catch {
    return null;
  }
  const parsed = SpawnContextSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

/** Reads and deletes the stashed context, or null if none was ever stashed. */
export async function takeSpawnContext(agentId: string): Promise<SpawnContext | null> {
  const context = await readSpawnContext(agentId);
  await fs.rm(stateFile(agentId), { force: true });
  return context;
}

/**
 * Reads without deleting — for resolving a *parent* agent, which is still
 * running and whose own on_complete has yet to claim its entry. A parent that
 * is not an agent-chat agent at all (the common case: a human-started session
 * spawning its first peer) simply has no entry, and that is not an error.
 */
export async function peekSpawnContext(agentId: string): Promise<SpawnContext | null> {
  return readSpawnContext(agentId);
}
