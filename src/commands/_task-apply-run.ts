/**
 * Applier for `task apply`: one lock per initiative, one read and at most one
 * write per task. Tag and note ops reuse `task edit`'s patch semantics; `done`
 * reuses the `task done` transition.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { TaskSchema, type Task } from '../schemas/task.js';
import { getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { patchChange, type PatchEdit } from './task-edit.js';
import type { ApplyOp, PlanEntry } from './_task-apply-plan.js';

export type ApplyOutcome = 'applied' | 'unchanged' | 'missing' | 'failed';

export interface LineResult {
  index: number;
  slug: string;
  id: string;
  result: ApplyOutcome;
  changes: string[];
  error?: string;
}

interface Stepped {
  task: Task;
  changed: boolean;
}

function hasLine(notes: string | undefined, line: string): boolean {
  return (notes ?? '').split('\n').includes(line);
}

function patchFor(op: Exclude<ApplyOp, { op: 'done' }>): PatchEdit {
  if (op.op === 'add_tag') return { kind: 'patch', addTag: op.value };
  if (op.op === 'remove_tag') return { kind: 'patch', removeTag: op.value };
  return { kind: 'patch', append: op.value };
}

function applyOp(task: Task, op: ApplyOp, date: string): Stepped {
  if (op.op === 'done') {
    if (task.status === 'done') return { task, changed: false };
    return { task: { ...task, status: 'done', done_at: date }, changed: true };
  }
  if (op.op === 'append' && hasLine(task.notes, op.value)) return { task, changed: false };
  const { changes } = patchChange(task, patchFor(op));
  return { task: { ...task, ...changes }, changed: Object.keys(changes).length > 0 };
}

function describeOp(op: ApplyOp): string {
  return op.op === 'done' ? 'done' : `${op.op}: ${op.value}`;
}

function result(entry: PlanEntry, outcome: ApplyOutcome, changes: string[] = []): LineResult {
  return { index: entry.index, slug: entry.slug, id: entry.id, result: outcome, changes };
}

function failed(entry: PlanEntry, error: string): LineResult {
  return { ...result(entry, 'failed'), error };
}

/** Apply one plan line to the in-memory task; on a schema failure the task is left as it was. */
function applyEntry(task: Task, entry: PlanEntry, date: string): { task: Task; line: LineResult } {
  let next = task;
  const changes: string[] = [];
  for (const op of entry.ops) {
    const step = applyOp(next, op, date);
    next = step.task;
    if (step.changed) changes.push(describeOp(op));
  }
  if (changes.length === 0) return { task, line: result(entry, 'unchanged') };
  const parsed = TaskSchema.safeParse({ ...next, updated: date });
  if (!parsed.success) return { task, line: failed(entry, parsed.error.message) };
  return { task: parsed.data, line: result(entry, 'applied', changes) };
}

async function loadTask(file: string): Promise<Task | undefined> {
  try {
    return await readYaml(file, TaskSchema);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function applyTask(
  file: string,
  entries: PlanEntry[],
  date: string,
  dryRun: boolean,
): Promise<LineResult[]> {
  let task = await loadTask(file);
  if (task === undefined) return entries.map((entry) => result(entry, 'missing'));
  const lines: LineResult[] = [];
  for (const entry of entries) {
    const step = applyEntry(task, entry, date);
    task = step.task;
    lines.push(step.line);
  }
  const dirty = lines.some((line) => line.result === 'applied');
  if (dirty && !dryRun) await writeYaml(file, task, TaskSchema);
  return lines;
}

async function applyTaskSafely(
  file: string,
  entries: PlanEntry[],
  date: string,
  dryRun: boolean,
): Promise<LineResult[]> {
  try {
    return await applyTask(file, entries, date, dryRun);
  } catch (err) {
    return entries.map((entry) => failed(entry, (err as Error).message));
  }
}

/**
 * Apply every task of one initiative under a single lock. A slug with no
 * initiative directory reports its lines missing without taking the lock,
 * which would otherwise create the directory.
 */
export async function applySlug(
  slug: string,
  tasks: Map<string, PlanEntry[]>,
  date: string,
  dryRun: boolean,
): Promise<LineResult[]> {
  const dir = getInitiativeDir(slug);
  if (!existsSync(dir)) return [...tasks.values()].flat().map((e) => result(e, 'missing'));
  return withFileLock(getLockPath(slug), async () => {
    const lines: LineResult[] = [];
    for (const [id, entries] of tasks) {
      const file = path.join(dir, 'tasks', `${id}.yml`);
      lines.push(...(await applyTaskSafely(file, entries, date, dryRun)));
    }
    return lines;
  });
}
