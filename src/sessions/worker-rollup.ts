import { z } from 'zod';
import type { WorkerRecord } from '../schemas/worker-record.js';

/**
 * Worker-session roll-up (TP-1710). `active-work hooks agent-chat-complete`
 * writes one stub record per finished peer, so a busy initiative accrues
 * hundreds of near-identical one-liners. This groups them per spawner with
 * counts by outcome; `session list` returns the result as data and the
 * bootstrap renders the same value.
 *
 * A stub record carries no facts, so it counts as "no report". A record with
 * a `worker` block (TP-1709) is attributed to `facts.spawner` and counted by
 * its report: a concerning Status is "concerns", a PR the report does not call
 * merged is "open PR", and any other report is "merged" (landed, nothing left
 * open).
 */

export const SESSION_KINDS = ['worker', 'adhoc', 'sidecar', 'canonical'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const UNATTRIBUTED = 'unattributed';
const MAX_EXCEPTION_SUMMARY = 100;

const STUB_PATTERN = /^Peer "([^"]*)"[^\n]*?(?:exited with|exit inferred)/;
const SPAWNER_PATTERN = /^([A-Za-z]+)[\d-]/;
const MAX_EXCEPTIONS_PER_SPAWNER = 3;
const CONCERNS_STATUS = /^Status:\s*(?:DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT)\b/m;
const MERGED_WORD = /\bmerged\b/i;

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
  exceptions_omitted: z.number().int(),
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
  kind?: 'worker';
  worker?: WorkerRecord;
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
  return input.kind === 'worker' || stubAgentName(input.body) !== null;
}

/** An explicit `kind` wins; else a stub record is a worker and the rest go by track. */
export function sessionKindOf(input: RollupInput): SessionKind {
  return isWorkerRecord(input) ? 'worker' : input.track;
}

/**
 * Agent names start with the spawner's seat prefix (`tc-` for titan-coord),
 * so the spawner is the name's leading letters when a digit or `-` follows
 * (`vw385` and `vw467` are both `vw`). A name
 * without that shape cannot be attributed.
 */
export function spawnerOf(agent: string | null): string {
  const match = agent ? SPAWNER_PATTERN.exec(agent) : null;
  return match ? (match[1] ?? UNATTRIBUTED) : UNATTRIBUTED;
}

interface WorkerView {
  agent: string;
  spawner: string;
  outcome: WorkerOutcome;
  summary: string;
}

function factsOutcome(worker: WorkerRecord): WorkerOutcome {
  const text = worker.facts.report?.text;
  if (text === undefined) return 'no_report';
  if (CONCERNS_STATUS.test(text)) return 'concerns';
  const merged = MERGED_WORD.test(text) || (worker.resolves?.length ?? 0) > 0;
  return worker.facts.pr != null && !merged ? 'open_pr' : 'merged';
}

/** What the roll-up needs from one worker record: its facts if it has them, else the stub line. */
function workerView(input: RollupInput): WorkerView | null {
  const { worker } = input;
  if (worker !== undefined) {
    return {
      agent: worker.facts.agent,
      spawner: worker.facts.spawner,
      outcome: factsOutcome(worker),
      summary: worker.last_action ?? firstLineOf(input.body),
    };
  }
  const agent = stubAgentName(input.body);
  if (agent === null) return null;
  return {
    agent,
    spawner: spawnerOf(agent),
    outcome: 'no_report',
    summary: firstLineOf(input.body),
  };
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
    exceptions_omitted: 0,
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
    const view = workerView(input);
    if (view === null) continue;
    const entry = bySpawner.get(view.spawner) ?? emptyRollup(view.spawner);
    entry.total += 1;
    entry[view.outcome] += 1;
    bySpawner.set(view.spawner, entry);
    const { outcome } = view;
    if (outcome !== 'no_report' && outcome !== 'concerns') continue;
    if (entry.exceptions.length < MAX_EXCEPTIONS_PER_SPAWNER) {
      entry.exceptions.push({
        session_id: input.sessionId,
        ended: input.ended,
        agent: view.agent || null,
        outcome,
        summary: view.summary,
      });
    } else {
      entry.exceptions_omitted += 1;
    }
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
 * Render the roll-up in at most `lineBudget` lines: one line per spawner, each
 * followed by its own exceptions while room remains.
 */
export function renderWorkerRollup(rollup: WorkerRollup, lineBudget: number): string[] {
  const { spawners } = rollup;
  if (spawners.length === 0 || lineBudget < 1) return [];
  if (spawners.length > lineBudget) {
    const shown = spawners.slice(0, lineBudget - 1).map(rollupLine);
    return [...shown, `- +${spawners.length - shown.length} more spawners`];
  }
  let room = lineBudget - spawners.length;
  return spawners.flatMap((entry) => {
    const shown = entry.exceptions.slice(0, room);
    room -= shown.length;
    return [rollupLine(entry), ...shown.map(exceptionLine)];
  });
}
