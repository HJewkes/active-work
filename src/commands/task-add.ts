import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import {
  getActiveRoot,
  getInitiativeDir,
  getLockPath,
} from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readRawFrontmatter, writeFrontmatter } from '../utils/gray-matter-io.js';
import { BriefFrontmatterSchema } from '../schemas/brief.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { today } from '../utils/today.js';
import { NotFoundError, ValidationError } from '../errors.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  priority: z.number().int().positive().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  estimate: z.number().positive().optional(),
  done_when: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const PREFIX_RE = /^[A-Z][A-Z0-9]*$/;

interface Brief {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  prefix: string;
}

async function loadBrief(slug: string): Promise<Brief> {
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
    throw new ValidationError(
      `Brief at ${briefPath} is missing a valid task_prefix`,
    );
  }
  return { path: briefPath, frontmatter: raw.frontmatter, body: raw.body, prefix };
}

async function listTaskFiles(slug: string): Promise<string[]> {
  const dir = path.join(getInitiativeDir(slug), 'tasks');
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((e) => e.endsWith('.yml'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function loadExistingTasks(slug: string): Promise<Task[]> {
  const files = await listTaskFiles(slug);
  const dir = path.join(getInitiativeDir(slug), 'tasks');
  const tasks: Task[] = [];
  for (const file of files) {
    const task = await readYaml(path.join(dir, file), TaskSchema);
    tasks.push(task);
  }
  return tasks;
}

function maxOnDiskTaskNumber(prefix: string, existing: Task[]): number {
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

// Ids must never be reissued, even after `task delete` removes the file
// that used the highest number. Allocate from the persisted `task_seq`
// high-water mark (falling back to the on-disk max for briefs written
// before the field existed) and persist the new mark before returning.
async function allocateTaskNumber(
  brief: Brief,
  existing: Task[],
): Promise<number> {
  const persisted =
    typeof brief.frontmatter.task_seq === 'number'
      ? brief.frontmatter.task_seq
      : 0;
  const onDisk = maxOnDiskTaskNumber(brief.prefix, existing);
  const next = Math.max(persisted, onDisk) + 1;
  const frontmatter: Record<string, unknown> = {
    ...brief.frontmatter,
    task_seq: next,
  };
  await writeFrontmatter(
    brief.path,
    frontmatter,
    brief.body,
    BriefFrontmatterSchema,
  );
  return next;
}

function nextPriority(existing: Task[]): number {
  let max = 0;
  for (const t of existing) {
    if (t.priority > max) max = t.priority;
  }
  return max + 1;
}

export default defineCommand<Args, Task>({
  name: 'task.add',
  description: 'Create a new task in an initiative',
  args: ArgsSchema,
  result: TaskSchema,
  cli: {
    positional: ['slug'],
    options: {
      title: { long: '--title', description: 'Task title', required: true },
      priority: { long: '--priority', description: 'Priority (positive int)' },
      severity: {
        long: '--severity',
        description: 'critical|high|medium|low',
      },
      estimate: { long: '--estimate', description: 'Estimate (hours)' },
      done_when: {
        long: '--done-when',
        description: 'Definition of done',
      },
      tags: { long: '--tags', description: 'Comma-separated tag list' },
      notes: { long: '--notes', description: 'Free-form notes' },
    },
  },
  async run(args) {
    // Touch activeRoot so it's resolved before locking.
    getActiveRoot();
    return withFileLock(getLockPath(args.slug), async () => {
      const brief = await loadBrief(args.slug);
      const existing = await loadExistingTasks(args.slug);
      const n = await allocateTaskNumber(brief, existing);
      const id = `${brief.prefix}-${n}`;
      const priority = args.priority ?? nextPriority(existing);
      const date = today();
      const task: Task = {
        id,
        title: args.title,
        priority,
        severity: args.severity,
        estimate: args.estimate,
        done_when: args.done_when,
        status: 'open',
        tags: args.tags,
        notes: args.notes,
        created: date,
        updated: date,
        done_at: null,
      };
      const taskDir = path.join(getInitiativeDir(args.slug), 'tasks');
      await fs.mkdir(taskDir, { recursive: true });
      await writeYaml(path.join(taskDir, `${id}.yml`), task, TaskSchema);
      return task;
    });
  },
});
