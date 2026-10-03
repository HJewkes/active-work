import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ResolvedTask, TaskResolution, TaskResolver } from '@titan-design/session-graph';

import { TaskSchema } from '../schemas/task.js';
import { getActiveRoot } from '../utils/paths.js';
import { readYaml } from '../utils/yaml-io.js';

/**
 * Resolve `task:<id>` refs against the active-work task store (AW-101).
 *
 * This is the one thing the index reads that is not a transcript, and it is a
 * deliberate exception rather than drift. A transcript states only the id a
 * command acted on — `aw task done active-work AW-104` — so a task's present
 * title, initiative, status and estimate exist nowhere in the corpus. The alternative was
 * to drop the columns; the call was to fill them.
 *
 * `@titan-design/session-graph` takes this as its `TaskResolver` (TP-22) and
 * calls it once per refresh pass with every task id in the graph. Two
 * consequences follow and are designed for rather than hidden:
 *
 * - These columns are NOT a pure function of the JSONL, so a rebuild has to
 *   re-read the store. That is why the resolver runs whole-table at the end of
 *   every pass rather than at line-handling time.
 * - They go stale when a task changes. Recomputing each pass bounds that to one
 *   refresh interval.
 */

/**
 * A task id is unique per initiative, not globally, and one collision is real:
 * two initiatives can both mint `H-<n>`, so `H-1`..`H-7` name two different
 * tasks. An ambiguous id resolves to nothing rather than to a coin flip — a
 * wrong title is worse than a null one, and no ambiguous id is actually cited
 * by any command in the corpus.
 */
const AMBIGUOUS = null;

type TaskStore = Map<string, ResolvedTask | typeof AMBIGUOUS>;

async function initiativeSlugs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

type TaskReader = typeof readYaml;

async function readInitiative(
  root: string,
  slug: string,
  read: TaskReader,
): Promise<[string, ResolvedTask][]> {
  const dir = path.join(root, slug, 'tasks');
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const found: [string, ResolvedTask][] = [];
  for (const file of files) {
    if (!file.endsWith('.yml')) continue;
    // A malformed task file must not fail the whole refresh: the index is a
    // read-only observer of this store and has no standing to reject it.
    try {
      const task = await read(path.join(dir, file), TaskSchema);
      found.push([
        task.id,
        {
          initiative: slug,
          title: task.title,
          status: task.status,
          estimate: task.estimate ?? null,
        },
      ]);
    } catch {
      continue;
    }
  }
  return found;
}

async function dirMtime(dir: string): Promise<string> {
  try {
    return String((await fs.stat(dir)).mtimeMs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '-';
    throw err;
  }
}

/**
 * Cheap change key for the whole store: the root's own mtime plus the mtime of
 * each `<slug>/tasks` and `<slug>/tasks/archive` dir. A task edit renames a file
 * into place, which moves its dir's mtime; a new initiative moves the root's.
 */
async function storeKey(root: string, slugs: string[]): Promise<string> {
  const parts = [await dirMtime(root)];
  for (const slug of slugs) {
    const tasksDir = path.join(root, slug, 'tasks');
    parts.push(slug, await dirMtime(tasksDir), await dirMtime(path.join(tasksDir, 'archive')));
  }
  return parts.join('|');
}

interface Memo<T> {
  key: string;
  value: T;
}

const storeMemo = new Map<string, Memo<TaskStore>>();
const knownIdsMemo = new Map<string, Memo<Set<string>>>();

async function memoized<T>(
  memo: Map<string, Memo<T>>,
  root: string,
  build: (slugs: string[]) => Promise<T>,
): Promise<T> {
  const slugs = await initiativeSlugs(root);
  const key = await storeKey(root, slugs);
  const hit = memo.get(root);
  if (hit?.key === key) return hit.value;
  const value = await build(slugs);
  memo.set(root, { key, value });
  return value;
}

/**
 * Every task in the store, keyed by bare id; ambiguous ids map to null.
 * Memoized per root until a task directory changes; callers must not mutate it.
 */
export async function loadTaskStore(
  root: string = getActiveRoot(),
  read: TaskReader = readYaml,
): Promise<TaskStore> {
  return memoized(storeMemo, root, async (slugs) => {
    const store: TaskStore = new Map();
    for (const slug of slugs) {
      for (const [id, task] of await readInitiative(root, slug, read)) {
        if (store.has(id)) store.set(id, AMBIGUOUS);
        else store.set(id, task);
      }
    }
    return store;
  });
}

async function ymlStems(dir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith('.yml')).map((f) => f.slice(0, -'.yml'.length));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Every task file id in the store, archived ones included (TP-407): a spawn
 * brief names the task it was given, and that task is often done by the time
 * the origin resolver reads the brief. Ambiguous ids count; the edge target
 * carries no initiative.
 */
export async function loadKnownTaskIds(root: string = getActiveRoot()): Promise<Set<string>> {
  return memoized(knownIdsMemo, root, async (slugs) => {
    const known = new Set<string>();
    for (const slug of slugs) {
      const tasksDir = path.join(root, slug, 'tasks');
      for (const dir of [tasksDir, path.join(tasksDir, 'archive')]) {
        for (const id of await ymlStems(dir)) known.add(id);
      }
    }
    return known;
  });
}

/**
 * Only the ids the graph asked about are answered, so the task table stays
 * "tasks the corpus mentions". The resolver contract allows returning ids no
 * transcript named, which would insert them; that would silently turn this
 * table into a mirror of the whole store, which is a different feature.
 */
export function taskResolver(root?: string): TaskResolver {
  return async (taskIds: readonly string[]): Promise<TaskResolution> => {
    const store = await loadTaskStore(root);
    const resolved = new Map<string, ResolvedTask | null>();
    for (const taskId of taskIds) {
      const task = store.get(taskId);
      if (task) resolved.set(taskId, task);
    }
    return resolved;
  };
}
