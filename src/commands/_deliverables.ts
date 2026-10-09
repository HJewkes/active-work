import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  BUILT_IN_STATUSES,
  DeliverableSchema,
  categoriesPath,
  deliverablePath,
  deliverablesDir,
  parseCategoryRegistry,
  parseDeliverableRegistry,
  type Deliverable,
  type DeliverableEntry,
} from '@titan-design/pm';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../errors.js';
import { loadEdgeIndex } from '../tasks/edge-index.js';
import type { Task } from '../schemas/task.js';
import { coerceDates } from '../utils/coerce-dates.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { writeYaml } from '../utils/yaml-io.js';

export { DeliverableSchema, type Deliverable };

export const DeliverableTaskCountsSchema = z.object({ open: z.number(), done: z.number() });

async function readEntry(dir: string, file: string): Promise<DeliverableEntry> {
  const raw = await fs.readFile(path.join(dir, file), 'utf8');
  return { file, parsed: coerceDates(YAML.parse(raw)) };
}

/** Every deliverable in the platform-wide registry; a missing directory is an empty registry. */
export async function loadDeliverables(activeRoot: string): Promise<Deliverable[]> {
  const dir = deliverablesDir(activeRoot);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((file) => file.endsWith('.yml')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const entries = await Promise.all(files.map((file) => readEntry(dir, file)));
  return parseDeliverableRegistry(entries);
}

export async function loadDeliverable(activeRoot: string, id: string): Promise<Deliverable> {
  const found = (await loadDeliverables(activeRoot)).find((d) => d.id === id);
  if (found === undefined) throw new NotFoundError(`Deliverable not found: ${id}`);
  return found;
}

export async function writeDeliverable(
  activeRoot: string,
  deliverable: Deliverable,
): Promise<void> {
  const parsed = DeliverableSchema.safeParse(deliverable);
  if (!parsed.success) {
    throw new ValidationError(`Invalid deliverable ${deliverable.id}: ${parsed.error.message}`);
  }
  await writeYaml(deliverablePath(activeRoot, deliverable.id), parsed.data, DeliverableSchema);
}

/** Serialises read-modify-write on the registry; the lock file sits beside the records. */
export function withDeliverablesLock<T>(activeRoot: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(path.join(deliverablesDir(activeRoot), '.lock'), fn);
}

/** Throws a ValidationError naming every id that is not in the registry. */
export async function assertKnownDeliverables(activeRoot: string, ids: string[]): Promise<void> {
  const known = new Set((await loadDeliverables(activeRoot)).map((d) => d.id));
  const unknown = [...new Set(ids)].filter((id) => !known.has(id));
  if (unknown.length === 0) return;
  throw new ValidationError(`Unknown deliverable id: ${unknown.join(', ')}`);
}

async function closedStatuses(activeRoot: string): Promise<Set<string>> {
  let parsed: unknown;
  try {
    parsed = YAML.parse(await fs.readFile(categoriesPath(activeRoot), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const statuses = parseCategoryRegistry(parsed)?.status ?? BUILT_IN_STATUSES;
  return new Set(statuses.filter((s) => s.closed).map((s) => s.id));
}

export interface JoinedTasks {
  open: Task[];
  done: Task[];
}

/** The tasks in every initiative that list each deliverable, split by whether their status is closed. */
export async function joinedTasks(activeRoot: string): Promise<Map<string, JoinedTasks>> {
  const closed = await closedStatuses(activeRoot);
  const joined = new Map<string, JoinedTasks>();
  for (const { task } of (await loadEdgeIndex()).entries) {
    for (const id of task.deliverables ?? []) {
      const bucket = joined.get(id) ?? { open: [], done: [] };
      (closed.has(task.status) ? bucket.done : bucket.open).push(task);
      joined.set(id, bucket);
    }
  }
  return joined;
}
