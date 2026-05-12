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
});

type Args = z.infer<typeof ArgsSchema>;

export default defineCommand<Args, Task>({
  name: 'task.done',
  description: 'Mark a task as done',
  args: ArgsSchema,
  result: TaskSchema,
  cli: {
    positional: ['slug', 'id'],
  },
  async run(args) {
    getActiveRoot();
    return withFileLock(getLockPath(args.slug), async () => {
      const file = path.join(
        getInitiativeDir(args.slug),
        'tasks',
        `${args.id}.yml`,
      );
      let task: Task;
      try {
        task = await readYaml(file, TaskSchema);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new NotFoundError(`Task not found: ${args.id}`);
        }
        throw err;
      }
      const date = today();
      const updated: Task = {
        ...task,
        status: 'done',
        done_at: date,
        updated: date,
      };
      await writeYaml(file, updated, TaskSchema);
      return updated;
    });
  },
});
