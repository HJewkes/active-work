import { checkEdges, readEdges, type EdgeError } from '@titan-design/pm';
import { ValidationError } from '../errors.js';
import { listInitiativeSlugs } from '../lint/index.js';
import type { Task } from '../schemas/task.js';
import { getActiveRoot } from '../utils/paths.js';
import { loadExistingTasks } from '../utils/task-seq.js';

/**
 * Every task under the active root, plus the initiatives each id is filed in. Ids resolve by
 * file presence, not by prefix, because prefixes collide across initiatives.
 */
export interface EdgeIndex {
  tasks: Task[];
  homes: Map<string, string[]>;
}

/** A proposed edge write on one task. An omitted field keeps the task's current edges. */
export interface EdgeWrite {
  slug: string;
  id: string;
  parent?: string;
  dep?: string[];
}

export function buildEdgeIndex(bySlug: ReadonlyMap<string, readonly Task[]>): EdgeIndex {
  const tasks: Task[] = [];
  const homes = new Map<string, string[]>();
  for (const [slug, slugTasks] of bySlug) {
    for (const task of slugTasks) {
      tasks.push(task);
      homes.set(task.id, [...(homes.get(task.id) ?? []), slug]);
    }
  }
  return { tasks, homes };
}

export async function loadEdgeIndex(): Promise<EdgeIndex> {
  const bySlug = new Map<string, Task[]>();
  for (const slug of await listInitiativeSlugs(getActiveRoot())) {
    bySlug.set(slug, await loadExistingTasks(slug));
  }
  return buildEdgeIndex(bySlug);
}

/** The ids the write adds: its parent and any dep the task does not already have. */
function namedIds(index: EdgeIndex, write: EdgeWrite): Set<string> {
  const current = index.tasks.find((task) => task.id === write.id);
  const currentDeps = new Set(current === undefined ? [] : readEdges(current).dep);
  const addedDeps = (write.dep ?? []).filter((ref) => !currentDeps.has(ref));
  return new Set([...(write.parent === undefined ? [] : [write.parent]), ...addedDeps]);
}

function placementErrors(index: EdgeIndex, write: EdgeWrite, named: Set<string>): string[] {
  const errors: string[] = [];
  for (const ref of named) {
    const homes = index.homes.get(ref) ?? [];
    if (homes.length < 2) continue;
    errors.push(`${ref} is filed in more than one initiative: ${homes.join(', ')}`);
  }
  const parentHomes = write.parent === undefined ? [] : (index.homes.get(write.parent) ?? []);
  if (parentHomes.length === 1 && parentHomes[0] !== write.slug) {
    errors.push(`parent ${write.parent} is in ${parentHomes[0]}, not ${write.slug}`);
  }
  return errors;
}

function describeEdgeError(error: EdgeError): string {
  if (error.kind === 'unknown-id') return `${error.field} ${error.ref} is not a known task id`;
  return `${error.field} cycle: ${[...error.ids, error.ids[0]].join(' -> ')}`;
}

/**
 * The reasons a write must be refused: a named id that is unknown or filed in two initiatives,
 * a parent outside the task's initiative, or a parent or dep cycle across all initiatives.
 * Unknown ids the write does not name (a stale edge already on disk) do not block it.
 */
export function edgeWriteErrors(index: EdgeIndex, write: EdgeWrite): string[] {
  const named = namedIds(index, write);
  const { errors } = checkEdges(index.tasks, {
    id: write.id,
    parent: write.parent,
    dep: write.dep,
  });
  const graphErrors = errors.filter((e) =>
    e.kind === 'unknown-id' ? named.has(e.ref) : named.size > 0,
  );
  return [...placementErrors(index, write, named), ...graphErrors.map(describeEdgeError)];
}

/** Throws a ValidationError naming every offending id when the write would break the edge graph. */
export async function assertEdgeWrite(write: EdgeWrite): Promise<void> {
  const errors = edgeWriteErrors(await loadEdgeIndex(), write);
  if (errors.length === 0) return;
  throw new ValidationError(`Refusing to write ${write.id}: ${errors.join('; ')}`);
}
