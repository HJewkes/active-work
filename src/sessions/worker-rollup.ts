import { z } from 'zod';

/**
 * Worker-session roll-up (TP-1710). `active-work hooks agent-chat-complete`
 * writes one stub record per finished peer, so a busy initiative accrues
 * hundreds of near-identical one-liners. This groups them per spawner with
 * counts by outcome; `session list` returns the result as data and the
 * bootstrap renders the same value.
 *
 * Today's records carry no facts block, so every stub counts as "no report".
 * Records that hold a report (merged / open PR / concerns) are counted into
 * those buckets once the facts schema lands; the counts are already part of
 * the result shape so consumers need not change.
 */

export const SESSION_KINDS = ['worker', 'adhoc', 'sidecar', 'canonical'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const UNATTRIBUTED = 'unattributed';
const MAX_EXCEPTION_SUMMARY = 100;

const STUB_PATTERN = /^Peer "([^"]*)"[^\n]*?(?:exited with|exit inferred)/;
const SPAWNER_PATTERN = /^([A-Za-z0-9]+)-/;

export const WorkerOutcomeSchema = z.enum(['merged', 'open_pr', 'no_report', 'concerns']);
export type WorkerOutcome = z.infer<typeof WorkerOutcomeSchema>;

export const WorkerExceptionSchema = z.object({
  session_id: z.string(),
  ended: z.string(),
  agent: z.string().nullable(),
  outcome: z.enum(['no_report', 'concerns']),
  summary: z.string(),
});

export const SpawnerRollupSchema = z.object({
  spawner: z.string(),
  total: z.number().int(),
  merged: z.number().int(),
  open_pr: z.number().int(),
  no_report: z.number().int(),
  concerns: z.number().int(),
  exceptions: z.array(WorkerExceptionSchema),
});

export const WorkerRollupSchema = z.object({
  spawners: z.array(SpawnerRollupSchema),
});

export type WorkerException = z.infer<typeof WorkerExceptionSchema>;
export type SpawnerRollup = z.infer<typeof SpawnerRollupSchema>;
export type WorkerRollup = z.infer<typeof WorkerRollupSchema>;

/** The slice of a session record the roll-up reads. */
export interface RollupInput {
  sessionId: string;
  ended: string;
  track: 'canonical' | 'sidecar' | 'adhoc';
  body: string;
}

function firstLineOf(body: string): string {
  const line =
    body
      .split(/\r?\n/)
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';
  return line.length > MAX_EXCEPTION_SUMMARY ? `${line.slice(0, MAX_EXCEPTION_SUMMARY)}…` : line;
}

/** The agent name inside a stub record's `Peer "<name>" ...` line, if it is one. */
export function stubAgentName(body: string): string | null {
  const match = STUB_PATTERN.exec(body.trimStart());
  return match ? (match[1] ?? '') : null;
}

export function isWorkerRecord(input: RollupInput): boolean {
  return stubAgentName(input.body) !== null;
}

/** A stub record is a worker; everything else is classified by its track. */
export function sessionKindOf(input: RollupInput): SessionKind {
  return isWorkerRecord(input) ? 'worker' : input.track;
}

/**
 * Agent names start with the spawner's seat prefix (`tc-` for titan-coord),
 * so the spawner is the name's leading token before its first `-`. A name
 * without that shape cannot be attributed.
 */
export function spawnerOf(agent: string | null): string {
  const match = agent ? SPAWNER_PATTERN.exec(agent) : null;
  return match ? (match[1] ?? UNATTRIBUTED) : UNATTRIBUTED;
}

function emptyRollup(spawner: string): SpawnerRollup {
  return {
    spawner,
    total: 0,
    merged: 0,
    open_pr: 0,
    no_report: 0,
    concerns: 0,
    exceptions: [],
  };
}

/** Newest first within a spawner; busiest spawner first, "unattributed" last. */
function compareSpawners(a: SpawnerRollup, b: SpawnerRollup): number {
  if ((a.spawner === UNATTRIBUTED) !== (b.spawner === UNATTRIBUTED)) {
    return a.spawner === UNATTRIBUTED ? 1 : -1;
  }
  return b.total - a.total || a.spawner.localeCompare(b.spawner);
}

export function buildWorkerRollup(inputs: RollupInput[]): WorkerRollup {
  const bySpawner = new Map<string, SpawnerRollup>();
  const newestFirst = [...inputs].sort((a, b) => Date.parse(b.ended) - Date.parse(a.ended));
  for (const input of newestFirst) {
    const agent = stubAgentName(input.body);
    if (agent === null) continue;
    const spawner = spawnerOf(agent);
    const entry = bySpawner.get(spawner) ?? emptyRollup(spawner);
    entry.total += 1;
    entry.no_report += 1;
    entry.exceptions.push({
      session_id: input.sessionId,
      ended: input.ended,
      agent: agent || null,
      outcome: 'no_report',
      summary: firstLineOf(input.body),
    });
    bySpawner.set(spawner, entry);
  }
  return { spawners: [...bySpawner.values()].sort(compareSpawners) };
}

function countsText(entry: SpawnerRollup): string {
  return [
    `${entry.merged} merged`,
    `${entry.open_pr} open PR`,
    `${entry.no_report} no report`,
    `${entry.concerns} concerns`,
  ].join(', ');
}

function rollupLine(entry: SpawnerRollup): string {
  const noun = entry.total === 1 ? 'worker' : 'workers';
  return `- ${entry.spawner}: ${entry.total} ${noun} — ${countsText(entry)}`;
}

function exceptionLine(entry: WorkerException): string {
  const label = entry.outcome === 'concerns' ? 'concerns' : 'no report';
  return `  - ${entry.ended.slice(0, 10)} ${entry.agent ?? entry.session_id} — ${label}`;
}

/**
 * Render the roll-up in at most `lineBudget` lines: one line per spawner, then
 * the exceptions that still fit, the last slot summarising any it dropped.
 */
export function renderWorkerRollup(rollup: WorkerRollup, lineBudget: number): string[] {
  const { spawners } = rollup;
  if (spawners.length === 0 || lineBudget < 1) return [];
  if (spawners.length > lineBudget) {
    const shown = spawners.slice(0, lineBudget - 1).map(rollupLine);
    const hidden = spawners.length - shown.length;
    return [...shown, `- +${hidden} more spawners`];
  }
  const lines = spawners.map(rollupLine);
  const exceptions = spawners.flatMap((s) => s.exceptions);
  const room = lineBudget - lines.length;
  if (exceptions.length <= room) return [...lines, ...exceptions.map(exceptionLine)];
  if (room < 1) return lines;
  const shown = exceptions.slice(0, room - 1).map(exceptionLine);
  return [...lines, ...shown, `  - +${exceptions.length - shown.length} more exceptions`];
}
