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
  entries: { slug: string; task: Task }[];
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
  const entries: EdgeIndex['entries'] = [];
  const homes = new Map<string, string[]>();
  for (const [slug, slugTasks] of bySlug) {
    for (const task of slugTasks) {
      entries.push({ slug, task });
      homes.set(task.id, [...(homes.get(task.id) ?? []), slug]);
    }
  }
  return { entries, homes };
}

async function loadInitiativeTasks(slug: string): Promise<Task[]> {
  try {
    return await loadExistingTasks(slug);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ValidationError(
      `The edge check reads every task under the active root, and a task file in ${slug} ` +
        `cannot be read. Fix that file and retry. ${reason}`,
    );
  }
}

export async function loadEdgeIndex(): Promise<EdgeIndex> {
  const bySlug = new Map<string, Task[]>();
  for (const slug of await listInitiativeSlugs(getActiveRoot())) {
    bySlug.set(slug, await loadInitiativeTasks(slug));
  }
  return buildEdgeIndex(bySlug);
}

/**
 * The tasks checkEdges sees. checkEdges keys its graph by id, so another initiative's task with
 * the edited task's id is left out: the edited task is the copy filed under `write.slug`.
 */
function graphFor(index: EdgeIndex, write: EdgeWrite): Task[] {
  return index.entries
    .filter(({ slug, task }) => task.id !== write.id || slug === write.slug)
    .map(({ task }) => task);
}

/** The ids the write adds: its parent and any dep the task does not already have. */
function namedIds(graph: readonly Task[], write: EdgeWrite): Set<string> {
  const current = graph.find((task) => task.id === write.id);
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

const cycleKey = (error: EdgeError): string =>
  error.kind === 'cycle' ? `${error.field}:${error.ids.join(',')}` : '';

/** Graph errors the write is responsible for: an unknown id it names, or a cycle it closes. */
function writeGraphErrors(
  graph: readonly Task[],
  write: EdgeWrite,
  named: Set<string>,
): EdgeError[] {
  if (named.size === 0) return [];
  const before = new Set(checkEdges(graph, { id: write.id }).errors.map(cycleKey));
  const { errors } = checkEdges(graph, { id: write.id, parent: write.parent, dep: write.dep });
  return errors.filter((e) =>
    e.kind === 'unknown-id' ? named.has(e.ref) : !before.has(cycleKey(e)),
  );
}

function describeEdgeError(error: EdgeError): string {
  if (error.kind === 'unknown-id') return `${error.field} ${error.ref} is not a known task id`;
  return `${error.field} cycle: ${[...error.ids, error.ids[0]].join(' -> ')}`;
}

/**
 * The reasons a write must be refused: a named id that is unknown or filed in two initiatives,
 * a parent outside the task's initiative, or a parent or dep cycle across all initiatives.
 * A stale unknown edge or a cycle already on disk does not block a write that leaves it alone.
 */
export function edgeWriteErrors(index: EdgeIndex, write: EdgeWrite): string[] {
  const graph = graphFor(index, write);
  const named = namedIds(graph, write);
  const graphErrors = writeGraphErrors(graph, write, named);
  return [...placementErrors(index, write, named), ...graphErrors.map(describeEdgeError)];
}

/** Throws a ValidationError naming every offending id when the write would break the edge graph. */
export async function assertEdgeWrite(write: EdgeWrite): Promise<void> {
  const errors = edgeWriteErrors(await loadEdgeIndex(), write);
  if (errors.length === 0) return;
  throw new ValidationError(`Refusing to write ${write.id}: ${errors.join('; ')}`);
}
