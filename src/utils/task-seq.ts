import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TaskSchema, type Task } from '../schemas/task.js';
import { TaskSeqSchema } from '../schemas/brief.js';
import { getInitiativeDir } from './paths.js';
import { readRawFrontmatter } from './gray-matter-io.js';
import { readYaml } from './yaml-io.js';
import { NotFoundError, ValidationError } from '../errors.js';

const PREFIX_RE = /^[A-Z][A-Z0-9]*$/;

export interface Brief {
  slug: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  prefix: string;
}

export async function loadBrief(slug: string): Promise<Brief> {
  const briefPath = path.join(getInitiativeDir(slug), 'brief.md');
  let raw: { frontmatter: Record<string, unknown>; body: string };
  try {
    raw = await readRawFrontmatter(briefPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NotFoundError(`Initiative not found: ${slug}`);
    }
    throw err;
  }
  const prefix = raw.frontmatter.task_prefix;
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) {
    throw new ValidationError(`Brief at ${briefPath} is missing a valid task_prefix`);
  }
  return {
    slug,
    path: briefPath,
    frontmatter: raw.frontmatter,
    body: raw.body,
    prefix,
  };
}

export async function loadExistingTasks(slug: string): Promise<Task[]> {
  const dir = path.join(getInitiativeDir(slug), 'tasks');
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((e) => e.endsWith('.yml'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const tasks: Task[] = [];
  for (const file of entries) {
    tasks.push(await readYaml(path.join(dir, file), TaskSchema));
  }
  return tasks;
}

// Scans task filenames directly rather than parsing every task file's YAML.
// Used by task.delete, which must not fail to delete a task just because some
// unrelated task file in the same directory happens to be malformed.
export async function maxOnDiskTaskNumberFromFilenames(
  prefix: string,
  slug: string,
): Promise<number> {
  const dir = path.join(getInitiativeDir(slug), 'tasks');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  const re = new RegExp(`^${prefix}-(\\d+)\\.yml$`);
  let max = 0;
  for (const entry of entries) {
    const m = re.exec(entry);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  return max;
}

export function maxOnDiskTaskNumber(prefix: string, existing: Task[]): number {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const t of existing) {
    const m = re.exec(t.id);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  return max;
}

// Extracts the numeric suffix from an id matching this initiative's
// task_prefix, or null if the id doesn't match (e.g. wrong prefix, malformed).
export function taskNumber(prefix: string, id: string): number | null {
  const m = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

// `Infinity` and `NaN` both stringify to `null` through JSON, which would hide
// the very value the operator has to find in the file.
function describeValue(value: unknown): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

function taskSeqRepair(brief: Brief, value: unknown, onDisk: number): string {
  return (
    `Invalid task_seq (${describeValue(value)}) in ${brief.path}. ` +
    'task_seq is the high-water mark for task ids and must be a positive whole ' +
    'number no larger than Number.MAX_SAFE_INTEGER. Task ids cannot be allocated ' +
    `until it is repaired: the highest id on disk is ${brief.prefix}-${onDisk}, so run ` +
    `\`active-work set ${brief.slug} task_seq <n>\` with n at least ${Math.max(onDisk, 1)} ` +
    '— higher if ids above that were issued and their tasks later deleted.'
  );
}

/**
 * ABSENT is a legitimate back-compat path: briefs written before the field
 * existed allocate from the on-disk max. Any other invalid value is corruption,
 * and silently falling back would "repair" it *downward* — below an id that has
 * already been issued — so it is reported instead of guessed at.
 */
export function readTaskSeq(brief: Brief, onDisk: number): number {
  const raw = brief.frontmatter.task_seq;
  if (raw === undefined) return 0;
  const parsed = TaskSeqSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(taskSeqRepair(brief, raw, onDisk));
  }
  return parsed.data;
}
