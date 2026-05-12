import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { getActiveRoot, getInitiativeDir } from '../utils/paths.js';
import { readYaml } from '../utils/yaml-io.js';
import { UsageError } from '../errors.js';

const StatusFilter = z.enum(['open', 'done', 'all']).default('open');

const ArgsSchema = z.object({
  slug: z.string().min(1).optional(),
  all_initiatives: z.boolean().optional(),
  tag: z.string().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  status: StatusFilter.optional(),
});

type Args = z.infer<typeof ArgsSchema>;

type TaskWithSlug = Task & { slug: string };

const ResultSchema = z.object({
  tasks: z.array(TaskSchema.extend({ slug: z.string() })),
});

type Result = z.infer<typeof ResultSchema>;

async function listSlugs(): Promise<string[]> {
  const root = getActiveRoot();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function loadTasksForSlug(slug: string): Promise<TaskWithSlug[]> {
  const dir = path.join(getInitiativeDir(slug), 'tasks');
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const tasks: TaskWithSlug[] = [];
  for (const file of files) {
    if (!file.endsWith('.yml')) continue;
    const task = await readYaml(path.join(dir, file), TaskSchema);
    tasks.push({ ...task, slug });
  }
  return tasks;
}

export default defineCommand<Args, Result>({
  name: 'task.list',
  description: 'List tasks for an initiative or across all initiatives',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      all_initiatives: {
        long: '--all-initiatives',
        description: 'Scan every initiative under the active root',
      },
      tag: { long: '--tag', description: 'Filter by tag membership' },
      severity: {
        long: '--severity',
        description: 'Filter by severity (critical|high|medium|low)',
      },
      status: {
        long: '--status',
        description: 'open (default), done, or all',
      },
    },
  },
  async run(args) {
    const status = args.status ?? 'open';
    const slugs: string[] = args.all_initiatives
      ? await listSlugs()
      : (() => {
          if (!args.slug) {
            throw new UsageError(
              'task.list requires --all-initiatives or a slug',
            );
          }
          return [args.slug];
        })();

    let collected: TaskWithSlug[] = [];
    for (const slug of slugs) {
      const tasks = await loadTasksForSlug(slug);
      collected = collected.concat(tasks);
    }

    const filtered = collected.filter((t) => {
      if (status !== 'all' && t.status !== status) return false;
      if (args.tag && !(t.tags ?? []).includes(args.tag)) return false;
      if (args.severity && t.severity !== args.severity) return false;
      return true;
    });

    filtered.sort((a, b) => a.priority - b.priority);
    return { tasks: filtered };
  },
});
