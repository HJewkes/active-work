/**
 * Applier for `task apply`: one lock per initiative, one read and at most one
 * write per task. Tag and note ops reuse `task edit`'s patch semantics; `done`
 * reuses the `task done` transition. A line that sets a parent or adds a dep is
 * checked against the whole-root edge index, which each applied line updates in
 * memory, so a later line sees the edges an earlier one wrote.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readEdges } from '@titan-design/pm';
import { TaskSchema, type Task } from '../schemas/task.js';
import { edgeWriteErrors, type EdgeIndex } from '../tasks/edge-index.js';
import { getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { patchChange, type PatchEdit } from './task-edit.js';
import { isEdgeOp, type ApplyOp, type EdgeOp, type PlanEntry } from './_task-apply-plan.js';

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

function patchFor(op: Exclude<ApplyOp, EdgeOp | { op: 'done' }>): PatchEdit {
  if (op.op === 'add_tag') return { kind: 'patch', addTag: op.value };
  if (op.op === 'remove_tag') return { kind: 'patch', removeTag: op.value };
  return { kind: 'patch', append: op.value };
}

/**
 * Writes the edge as a field. Unlike `task edit --dep`, a dep that only a tag supplies still
 * counts as missing, because writing the field is the point of the tag-to-field migration.
 * The new list starts from readEdges, so the task's other tag-only deps are carried over.
 */
function applyEdgeOp(task: Task, op: EdgeOp): Stepped {
  if (op.op === 'set_parent') {
    if (task.parent === op.value) return { task, changed: false };
    return { task: { ...task, parent: op.value }, changed: true };
  }
  if ((task.dep ?? []).includes(op.value)) return { task, changed: false };
  const dep = [...new Set([...readEdges(task).dep, op.value])];
  return { task: { ...task, dep }, changed: true };
}

function applyOp(task: Task, op: ApplyOp, date: string): Stepped {
  if (op.op === 'done') {
    if (task.status === 'done') return { task, changed: false };
    return { task: { ...task, status: 'done', done_at: date }, changed: true };
  }
  if (isEdgeOp(op)) return applyEdgeOp(task, op);
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

const sameDeps = (a: readonly string[] = [], b: readonly string[] = []): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** The TP-2005 edge check for the edges this line changed, or [] when it changed none. */
function edgeErrors(
  edges: EdgeIndex | undefined,
  slug: string,
  before: Task,
  after: Task,
): string[] {
  const parent = after.parent === before.parent ? undefined : after.parent;
  const dep = sameDeps(after.dep, before.dep) ? undefined : after.dep;
  if (parent === undefined && dep === undefined) return [];
  if (edges === undefined) throw new Error('Edge ops need the edge index, which was not loaded');
  return edgeWriteErrors(edges, { slug, id: after.id, parent, dep });
}

/** Keep the index current, so the next line's edge check sees what this line wrote. */
function recordTask(edges: EdgeIndex | undefined, slug: string, task: Task): void {
  const entry = edges?.entries.find((e) => e.slug === slug && e.task.id === task.id);
  if (entry !== undefined) entry.task = task;
}

/**
 * Apply one plan line to the in-memory task. On a schema failure or a refused edge the task
 * is left as it was, so the line fails alone and the rest of the plan still applies.
 */
function applyEntry(
  task: Task,
  entry: PlanEntry,
  date: string,
  edges: EdgeIndex | undefined,
): { task: Task; line: LineResult } {
  let next = task;
  const changes: string[] = [];
  for (const op of entry.ops) {
    const step = applyOp(next, op, date);
    next = step.task;
    if (step.changed) changes.push(describeOp(op));
  }
  if (changes.length === 0) return { task, line: result(entry, 'unchanged') };
  const refused = edgeErrors(edges, entry.slug, task, next);
  if (refused.length > 0) {
    return { task, line: failed(entry, `Refusing to write ${task.id}: ${refused.join('; ')}`) };
  }
  const parsed = TaskSchema.safeParse({ ...next, updated: date });
  if (!parsed.success) return { task, line: failed(entry, parsed.error.message) };
  recordTask(edges, entry.slug, parsed.data);
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

/** What every line of one `task apply` run shares; `edges` is loaded only when a line needs it. */
export interface ApplyContext {
  date: string;
  dryRun: boolean;
  edges?: EdgeIndex;
}

async function applyTask(
  file: string,
  entries: PlanEntry[],
  run: ApplyContext,
): Promise<LineResult[]> {
  let task = await loadTask(file);
  if (task === undefined) return entries.map((entry) => result(entry, 'missing'));
  const lines: LineResult[] = [];
  for (const entry of entries) {
    const step = applyEntry(task, entry, run.date, run.edges);
    task = step.task;
    lines.push(step.line);
  }
  const dirty = lines.some((line) => line.result === 'applied');
  if (dirty && !run.dryRun) await writeYaml(file, task, TaskSchema);
  return lines;
}

async function applyTaskSafely(
  file: string,
  entries: PlanEntry[],
  run: ApplyContext,
): Promise<LineResult[]> {
  try {
    return await applyTask(file, entries, run);
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
  run: ApplyContext,
): Promise<LineResult[]> {
  const dir = getInitiativeDir(slug);
  if (!existsSync(dir)) return [...tasks.values()].flat().map((e) => result(e, 'missing'));
  return withFileLock(getLockPath(slug), async () => {
    const lines: LineResult[] = [];
    for (const [id, entries] of tasks) {
      const file = path.join(dir, 'tasks', `${id}.yml`);
      lines.push(...(await applyTaskSafely(file, entries, run)));
    }
    return lines;
  });
}
