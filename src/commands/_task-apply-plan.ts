/**
 * Planner for `task apply`: parses a JSONL plan into per-line entries and
 * groups them by initiative and task, so the applier touches each task once.
 * A bad line becomes a failure entry; it never stops the rest of the plan.
 */
import { TaskSchema } from '../schemas/task.js';
import { validateSlug } from '../utils/slug.js';

export type ApplyOp = { op: 'add_tag' | 'remove_tag' | 'append'; value: string } | { op: 'done' };

export interface PlanEntry {
  index: number;
  slug: string;
  id: string;
  ops: ApplyOp[];
  error?: string;
}

export interface ParsedPlan {
  entries: PlanEntry[];
  unknownKeys: string[];
}

/** slug -> task id -> the plan entries for that task, in plan order. */
export type GroupedPlan = Map<string, Map<string, PlanEntry[]>>;

const LINE_KEYS = new Set(['slug', 'id', 'ops']);

function parseTag(op: string, raw: unknown): ApplyOp {
  const tag = typeof raw === 'string' ? raw.trim() : '';
  if (tag === '') throw new Error(`${op} needs a non-empty tag`);
  if (tag.includes(',')) throw new Error(`${op} takes one tag: ${tag}`);
  return { op: op as 'add_tag' | 'remove_tag', value: tag };
}

function parseAppend(raw: unknown): ApplyOp {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('append needs non-empty text');
  if (/[\r\n]/.test(raw)) throw new Error('append takes one line, without newlines');
  return { op: 'append', value: raw };
}

function parseOp(raw: unknown): ApplyOp {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Each op must be an object: ${JSON.stringify(raw)}`);
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1) throw new Error(`Each op takes exactly one key: ${JSON.stringify(raw)}`);
  const key = keys[0]!;
  const value = (raw as Record<string, unknown>)[key];
  if (key === 'add_tag' || key === 'remove_tag') return parseTag(key, value);
  if (key === 'append') return parseAppend(value);
  if (key === 'done') {
    if (value !== true) throw new Error('done takes only true');
    return { op: 'done' };
  }
  throw new Error(`Unknown op: ${key}`);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function checkTarget(slug: string, id: string): void {
  const slugCheck = validateSlug(slug);
  if (!slugCheck.ok) throw new Error(`Invalid slug "${slug}": ${slugCheck.error}`);
  if (!TaskSchema.shape.id.safeParse(id).success) throw new Error(`Invalid task id "${id}"`);
}

function parseLine(text: string, index: number, unknownKeys: Set<string>): PlanEntry {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    return { index, slug: '', id: '', ops: [], error: `Invalid JSON: ${(err as Error).message}` };
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { index, slug: '', id: '', ops: [], error: 'Plan line must be a JSON object' };
  }
  const slug = stringField(record, 'slug');
  const id = stringField(record, 'id');
  for (const key of Object.keys(record)) if (!LINE_KEYS.has(key)) unknownKeys.add(key);
  try {
    checkTarget(slug, id);
    if (!Array.isArray(record.ops)) throw new Error('ops must be an array');
    return { index, slug, id, ops: record.ops.map(parseOp) };
  } catch (err) {
    return { index, slug, id, ops: [], error: (err as Error).message };
  }
}

export function parsePlan(text: string): ParsedPlan {
  const unknownKeys = new Set<string>();
  const entries = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => parseLine(line, index, unknownKeys));
  return { entries, unknownKeys: [...unknownKeys].sort() };
}

/** Group the valid entries by slug, then by task id; failed entries are left out. */
export function groupPlan(entries: PlanEntry[]): GroupedPlan {
  const grouped: GroupedPlan = new Map();
  for (const entry of entries) {
    if (entry.error !== undefined) continue;
    const tasks = grouped.get(entry.slug) ?? new Map<string, PlanEntry[]>();
    grouped.set(entry.slug, tasks);
    tasks.set(entry.id, [...(tasks.get(entry.id) ?? []), entry]);
  }
  return grouped;
}
