import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { getActiveRoot, getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { today } from '../utils/today.js';
import { NotFoundError } from '../errors.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  id: z.string().min(1),
  new_priority: z.number().int().positive(),
});

type Args = z.infer<typeof ArgsSchema>;

const ShiftedSchema = z.object({
  id: z.string(),
  from: z.number().int(),
  to: z.number().int(),
});

const ResultSchema = z.object({
  id: z.string(),
  from: z.number().int(),
  to: z.number().int(),
  shifted: z.array(ShiftedSchema),
});

type Result = z.infer<typeof ResultSchema>;

async function loadAllTasks(
  slug: string,
): Promise<Array<{ task: Task; file: string }>> {
  const dir = path.join(getInitiativeDir(slug), 'tasks');
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Array<{ task: Task; file: string }> = [];
  for (const file of files) {
    if (!file.endsWith('.yml')) continue;
    const full = path.join(dir, file);
    out.push({ task: await readYaml(full, TaskSchema), file: full });
  }
  return out;
}

export default defineCommand<Args, Result>({
  name: 'task.reorder',
  description: 'Move a task to a new priority and shift siblings down',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug', 'id', 'new_priority'],
  },
  async run(args) {
    getActiveRoot();
    return withFileLock(getLockPath(args.slug), async () => {
      const entries = await loadAllTasks(args.slug);
      const target = entries.find((e) => e.task.id === args.id);
      if (!target) {
        throw new NotFoundError(`Task not found: ${args.id}`);
      }
      const oldPriority = target.task.priority;
      const newPriority = args.new_priority;
      const shifted: Array<{ id: string; from: number; to: number }> = [];
      const date = today();

      if (oldPriority === newPriority) {
        return { id: args.id, from: oldPriority, to: newPriority, shifted };
      }

      const writes: Array<{ task: Task; file: string }> = [];

      for (const entry of entries) {
        if (entry.task.id === args.id) continue;
        if (entry.task.priority >= newPriority) {
          const before = entry.task.priority;
          const after = before + 1;
          const next: Task = {
            ...entry.task,
            priority: after,
            updated: date,
          };
          writes.push({ task: next, file: entry.file });
          shifted.push({ id: entry.task.id, from: before, to: after });
        }
      }

      const targetNext: Task = {
        ...target.task,
        priority: newPriority,
        updated: date,
      };
      writes.push({ task: targetNext, file: target.file });

      for (const w of writes) {
        await writeYaml(w.file, w.task, TaskSchema);
      }

      return { id: args.id, from: oldPriority, to: newPriority, shifted };
    });
  },
});
