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

/** Reads and deletes the stashed context, or null if none was ever stashed. */
export async function takeSpawnContext(agentId: string): Promise<SpawnContext | null> {
  let raw: string;
  try {
    raw = await fs.readFile(stateFile(agentId), 'utf8');
  } catch {
    return null;
  }
  await fs.rm(stateFile(agentId), { force: true });
  const parsed = SpawnContextSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}
