import { promises as fs } from 'node:fs';
import path from 'node:path';

import { TaskSchema } from '../../schemas/task.js';
import { getActiveRoot } from '../../utils/paths.js';
import { readYaml } from '../../utils/yaml-io.js';

/**
 * Resolve `task:<id>` refs against the active-work task store (AW-101).
 *
 * This is the one place the index reads something other than a transcript, and
 * it is a deliberate exception rather than drift. A transcript states only the
 * id a command acted on — `aw task done active-work AW-104` — so title, status
 * and dates exist nowhere in the corpus. The alternative was to drop the
 * columns; the call was to fill them.
 *
 * Two consequences follow and are designed for rather than hidden:
 *
 * - These columns are NOT a pure function of the JSONL, so a rebuild has to
 *   re-read the store. That is why this runs as a whole-table reconcile at the
 *   end of every pass, the same shape as `reconcilePrCreates`, instead of at
 *   line-handling time.
 * - They go stale when a task changes. Recomputing the whole table each pass is
 *   what bounds that to one refresh interval.
 */

export interface StoreTask {
  initiative: string;
  title: string;
  status: string;
  createdAt: string | null;
  completedAt: string | null;
}

/**
 * A task id is unique per initiative, not globally, and one collision is real:
 * `health` and `herald` both mint `H-<n>`, so `H-1`..`H-7` name two different
 * tasks. An ambiguous id resolves to nothing rather than to a coin flip — a
 * wrong title is worse than a null one, and no ambiguous id is actually cited
 * by any command in the corpus.
 */
const AMBIGUOUS = null;

export type TaskStore = Map<string, StoreTask | typeof AMBIGUOUS>;

async function initiativeSlugs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readInitiative(root: string, slug: string): Promise<[string, StoreTask][]> {
  const dir = path.join(root, slug, 'tasks');
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const found: [string, StoreTask][] = [];
  for (const file of files) {
    if (!file.endsWith('.yml')) continue;
    // A malformed task file must not fail the whole refresh: the index is a
    // read-only observer of this store and has no standing to reject it.
    try {
      const task = await readYaml(path.join(dir, file), TaskSchema);
      found.push([
        task.id,
        {
          initiative: slug,
          title: task.title,
          status: task.status,
          createdAt: task.created ?? null,
          completedAt: task.done_at ?? null,
        },
      ]);
    } catch {
      continue;
    }
  }
  return found;
}

/** Every task in the store, keyed by bare id; ambiguous ids map to null. */
export async function loadTaskStore(root: string = getActiveRoot()): Promise<TaskStore> {
  const store: TaskStore = new Map();
  for (const slug of await initiativeSlugs(root)) {
    for (const [id, task] of await readInitiative(root, slug)) {
      if (store.has(id)) store.set(id, AMBIGUOUS);
      else store.set(id, task);
    }
  }
  return store;
}
