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
import { readRawFrontmatter } from '../utils/gray-matter-io.js';
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

async function readBriefPrefix(slug: string): Promise<string> {
  const briefPath = path.join(getInitiativeDir(slug), 'brief.md');
  let raw: { frontmatter: Record<string, unknown> };
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
  return prefix;
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

function nextTaskNumber(prefix: string, existing: Task[]): number {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const t of existing) {
    const m = re.exec(t.id);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
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
      const prefix = await readBriefPrefix(args.slug);
      const existing = await loadExistingTasks(args.slug);
      const n = nextTaskNumber(prefix, existing);
      const id = `${prefix}-${n}`;
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
