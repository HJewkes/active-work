import { spawn } from 'node:child_process';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { readStdinJson } from '../utils/read-stdin-json.js';
import { takeSpawnContext, type SpawnContext } from '../utils/agent-chat-hook-state.js';
import { nowIso } from '../utils/today.js';

/**
 * `active-work hooks agent-chat-complete` (AW-99) — the `on_complete`
 * consumer registered into agent-chat's generic lifecycle hooks (CC-71).
 *
 * Reads the on_complete JSON payload from stdin
 * (`{agentId, code, signal, inferred}`), looks up the context stashed by the
 * matching `hooks agent-chat-spawn` call, and — when one exists — records the
 * peer as a `track: adhoc` session via the real `wrap` command, exactly as a
 * human-run `active-work wrap --track adhoc` would. No new schema or storage:
 * bootstrap's existing "Parallel sessions since then" section picks this up
 * automatically. An agentId with no stashed context (its spawn never matched
 * an initiative, or on_spawn never fired) is a silent no-op.
 */
const ArgsSchema = z.object({});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  recorded: z.boolean(),
  slug: z.string().nullable(),
});
type Result = z.infer<typeof ResultSchema>;

function str(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' ? value : null;
}

/** Injectable so tests never spawn a real `active-work wrap` subprocess. */
export type WrapRunner = (args: string[]) => Promise<{ code: number | null; stderr: string }>;

const defaultWrapRunner: WrapRunner = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('active-work', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code, stderr: Buffer.concat(stderrChunks).toString('utf8') }),
    );
  });

let wrapRunner: WrapRunner = defaultWrapRunner;
export function setWrapRunner(next: WrapRunner): void {
  wrapRunner = next;
}
export function resetWrapRunner(): void {
  wrapRunner = defaultWrapRunner;
}

function descriptor(context: SpawnContext): string {
  const parts = [
    context.profile ? `profile ${context.profile}` : null,
    context.briefing ? `briefed on ${context.briefing}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function summaryLine(payload: Record<string, unknown> | null, context: SpawnContext): string {
  const who = `Peer "${context.name}"${descriptor(context)} (spawned via agent-chat)`;
  if (str(payload, 'inferred') === 'true' || payload?.inferred === true) {
    return `${who} exit inferred; no exit code available.`;
  }
  const code = payload?.code;
  const signal = str(payload, 'signal');
  const codePart = typeof code === 'number' ? `code ${code}` : 'no exit code';
  const signalPart = signal ? `, signal ${signal}` : '';
  return `${who} exited with ${codePart}${signalPart}.`;
}

/** The on_complete payload handler, separated from stdin-reading so it's unit-testable directly. */
export async function handleOnComplete(payload: Record<string, unknown> | null): Promise<Result> {
  const agentId = str(payload, 'agentId');
  if (!agentId) return { recorded: false, slug: null };

  const context = await takeSpawnContext(agentId);
  if (!context) return { recorded: false, slug: null };

  const body = summaryLine(payload, context);
  const { code, stderr } = await wrapRunner([
    'wrap',
    context.slug,
    '--session-id',
    context.sessionId,
    '--started',
    context.started,
    '--ended',
    nowIso(),
    '--track',
    'adhoc',
    ...(context.parentSessionId ? ['--parent-session', context.parentSessionId] : []),
    '--body',
    body,
    '--no-loops',
    '--no-notes',
    '--no-tasks',
  ]);
  if (code !== 0) {
    throw new Error(`active-work wrap failed for agentId ${agentId} (exit ${code}): ${stderr}`);
  }
  return { recorded: true, slug: context.slug };
}

export default defineCommand<Args, Result>({
  name: 'hooks.agent-chat-complete',
  description:
    "agent-chat on_complete hook consumer (AW-99): record a spawned peer's run as a track:adhoc session via wrap.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    usage:
      'active-work hooks agent-chat-complete   (reads the on_complete JSON payload from stdin)',
  },
  async run() {
    const payload = await readStdinJson();
    return handleOnComplete(payload);
  },
});
