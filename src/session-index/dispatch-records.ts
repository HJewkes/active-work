import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Assignment } from '@titan-design/session-analytics';

/**
 * Seat dispatch logs (`<logsDir>/<seat>/dispatch.jsonl`) folded into
 * session-analytics `Assignment`s (TP-513). The naming and outcome rules port
 * claude-channels' retro tool `daily.py` so the two agree on what a merge is.
 */

export interface DispatchWindow {
  /** Inclusive lower bound, any `Date.parse` form; null is unbounded. */
  since: string | null;
  /** Exclusive upper bound; null is unbounded. */
  until: string | null;
}

export interface DispatchSkipped {
  /** Lines that are not a JSON object or carry no parseable `ts`. */
  badLines: number;
  noAgent: number;
}

export interface DispatchRecords {
  assignments: Assignment[];
  skipped: DispatchSkipped;
}

/** The outcome a `+fixN` agent gets: its spend counts toward the group, never a second merge. */
export const FIX_ROUND_OUTCOME = 'fix-round';

const TERMINAL = new Set(['merged', 'done', 'parked', 'abandoned', 'stalled']);
const TERMINAL_WORDS = ['merged', 'parked', 'abandoned', 'stalled'] as const;

/**
 * Splits `stem-a-b-slug+fix1` into full agent names, the first carrying the row.
 * Unlike daily.py, the first piece is always kept verbatim: daily.py turns a
 * dashless name such as `a` into `a-a`.
 */
export function expandAgentNames(field: string): string[] {
  const [first, ...rest] = field.split('+');
  const stem = first!.split('-').slice(0, 3).join('-');
  const names = [first!, ...rest.map((p) => (p.includes('-') ? p : `${stem}-${p}`))];
  return [...new Set(names)];
}

/**
 * A row's outcome as a terminal class, or null for lifecycle words
 * (`dispatched`, broker `retired`) and free text. A queued `MERGE x` is not a merge.
 */
export function outcomeClass(outcome: string | null | undefined): string | null {
  if (!outcome) return null;
  if (outcome === 'done' || outcome === 'done-no-pr') return 'done';
  const low = outcome.toLowerCase();
  return TERMINAL_WORDS.find((word) => low.includes(word)) ?? null;
}

interface Row {
  seat: string;
  agent: string;
  task: string | null;
  kind: string | null;
  initiative: string | null;
  value: string | null;
  pr: string | null;
  outcome: string | null;
  at: number;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

type Parsed = { row: Row } | { skip: keyof DispatchSkipped };

function parseLine(seat: string, line: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { skip: 'badLines' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { skip: 'badLines' };
  const rec = raw as Record<string, unknown>;
  const at = typeof rec.ts === 'string' ? Date.parse(rec.ts) : NaN;
  if (Number.isNaN(at)) return { skip: 'badLines' };
  const agent = text(rec.agent);
  if (!agent) return { skip: 'noAgent' };
  return {
    row: {
      seat,
      agent,
      at,
      task: text(rec.task),
      kind: text(rec.kind),
      initiative: text(rec.initiative),
      value: text(rec.value),
      pr: text(rec.pr),
      outcome: text(rec.outcome),
    },
  };
}

function bound(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid dispatch window bound: ${value}`);
  return ms;
}

function readSeatRows(logsDir: string, seat: string, skipped: DispatchSkipped): Row[] {
  const file = path.join(logsDir, seat, 'dispatch.jsonl');
  if (!existsSync(file)) return [];
  const rows: Row[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseLine(seat, line);
    if ('skip' in parsed) skipped[parsed.skip] += 1;
    else rows.push(parsed.row);
  }
  return rows;
}

/** One row becomes one entry per expanded name; only the first name carries the row's outcome. */
function entries(row: Row): Array<{ agent: string; outcome: string | null }> {
  return expandAgentNames(row.agent).map((agent, i) => ({
    agent,
    outcome: i === 0 ? outcomeClass(row.outcome) : FIX_ROUND_OUTCOME,
  }));
}

/** A terminal class replaces anything; a non-terminal one only fills an empty outcome. */
function foldOutcome(current: string | null, next: string | null): string | null {
  if (next !== null && TERMINAL.has(next)) return next;
  return current ?? next;
}

/** Rows arrive in time order, so the row being folded is always the latest so far. */
function foldInto(acc: Map<string, Assignment>, row: Row): void {
  for (const { agent, outcome } of entries(row)) {
    const key = JSON.stringify([row.seat, agent, row.task]);
    const prev = acc.get(key);
    acc.set(key, {
      seat: row.seat,
      agent,
      task: row.task,
      kind: row.kind ?? prev?.kind ?? null,
      initiative: row.initiative ?? prev?.initiative ?? null,
      value: row.value ?? prev?.value ?? null,
      pr: row.pr ?? prev?.pr ?? null,
      outcome: foldOutcome(prev?.outcome ?? null, outcome),
      ts: new Date(row.at).toISOString(),
    });
  }
}

function compareAssignments(a: Assignment, b: Assignment): number {
  return (
    a.seat.localeCompare(b.seat) ||
    a.agent.localeCompare(b.agent) ||
    (a.task ?? '').localeCompare(b.task ?? '')
  );
}

/** Reads every seat's dispatch log under `logsDir`, keeping rows with `since <= ts < until`. */
export function readDispatchRecords(logsDir: string, window: DispatchWindow): DispatchRecords {
  const lo = bound(window.since, -Infinity);
  const hi = bound(window.until, Infinity);
  const skipped: DispatchSkipped = { badLines: 0, noAgent: 0 };
  const seats = existsSync(logsDir)
    ? readdirSync(logsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];
  const rows = seats
    .flatMap((seat) => readSeatRows(logsDir, seat, skipped))
    .filter((row) => row.at >= lo && row.at < hi)
    .sort((a, b) => a.at - b.at);
  const acc = new Map<string, Assignment>();
  for (const row of rows) foldInto(acc, row);
  return { assignments: [...acc.values()].sort(compareAssignments), skipped };
}
