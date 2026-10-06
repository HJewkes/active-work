import { spawn } from 'node:child_process';
import { z } from 'zod';
import { WorkerFactsSchema, type WorkerFacts } from '@titan-design/agent-protocol/worker-facts';
import { defineCommand } from '../registry/index.js';
import { readStdinJson } from '../utils/read-stdin-json.js';
import { takeSpawnContext, type SpawnContext } from '../utils/agent-chat-hook-state.js';
import { nowIso } from '../utils/today.js';
import { closedTaskIds } from '../sessions/report-resolves.js';
import { NO_REPORT_OUTCOME, type WorkerRecord } from '../schemas/worker-record.js';

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
 *
 * A payload that also carries `facts` (agent-chat CC-763) is recorded as
 * `kind: worker` through `wrap --facts` (TP-1709): the body is the worker's
 * report, or for a worker that sent none, outcome exited-no-report plus the
 * payload's `lastAction`. The gate is the payload's shape, not a version, so an
 * older broker still gets the one-line record.
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

function exitText(exit: WorkerFacts['exit']): string {
  if (exit.inferred) return 'exit inferred';
  const codePart = exit.code === null ? 'no exit code' : `exit code ${exit.code}`;
  return exit.signal ? `${codePart}, signal ${exit.signal}` : codePart;
}

function workerRecordOf(
  facts: WorkerFacts,
  lastAction: string | null,
  context: SpawnContext,
): { body: string; record: WorkerRecord } {
  const text = facts.report?.text.trim();
  if (facts.report != null) {
    const resolves = closedTaskIds(facts.report.text);
    return {
      body: text || `Peer "${context.name}" sent an empty ${facts.report.kind} report.`,
      record: { facts, ...(resolves.length > 0 ? { resolves } : {}) },
    };
  }
  const who = `Peer "${context.name}"${descriptor(context)} sent no report (${exitText(facts.exit)}).`;
  return {
    body: lastAction ? `${who} Last action: ${lastAction}` : `${who} No last action recorded.`,
    record: {
      facts,
      outcome: NO_REPORT_OUTCOME,
      ...(lastAction ? { last_action: lastAction } : {}),
    },
  };
}

/**
 * The worker record when the payload carries valid `facts`; null for a payload
 * without them. Invalid facts fall back to the one-line record with a warning
 * rather than losing the session.
 */
function workerRecordFromPayload(
  payload: Record<string, unknown> | null,
  context: SpawnContext,
  warnings: string[],
): { body: string; record: WorkerRecord } | null {
  if (payload?.facts === undefined) return null;
  const parsed = WorkerFactsSchema.safeParse(payload.facts);
  if (!parsed.success) {
    warnings.push(
      `on_complete facts failed validation, recorded without them: ${parsed.error.message}`,
    );
    return null;
  }
  return workerRecordOf(parsed.data, str(payload, 'lastAction'), context);
}

/** The on_complete payload handler, separated from stdin-reading so it's unit-testable directly. */
export async function handleOnComplete(
  payload: Record<string, unknown> | null,
  warnings: string[] = [],
): Promise<Result> {
  const agentId = str(payload, 'agentId');
  if (!agentId) return { recorded: false, slug: null };

  const context = await takeSpawnContext(agentId);
  if (!context) return { recorded: false, slug: null };

  const worker = workerRecordFromPayload(payload, context, warnings);
  const body = worker?.body ?? summaryLine(payload, context);
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
    ...(worker ? ['--facts', JSON.stringify(worker.record)] : []),
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
    "agent-chat on_complete hook consumer (AW-99): record a spawned peer's run as a track:adhoc session via wrap, as kind: worker with its facts when the payload carries them (TP-1709).",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    usage:
      'active-work hooks agent-chat-complete   (reads the on_complete JSON payload from stdin)',
  },
  async run(_args, ctx) {
    const payload = await readStdinJson();
    return handleOnComplete(payload, ctx.warnings);
  },
});
