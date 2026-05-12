import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { getActiveRoot, getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { NotFoundError } from '../errors.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  id: z.string().min(1),
});

type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});

type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'task.delete',
  description: 'Hard delete a task file (prefer task.done in normal use)',
  args: ArgsSchema,
  result: ResultSchema,
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
      try {
        await fs.unlink(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new NotFoundError(`Task not found: ${args.id}`);
        }
        throw err;
      }
      return { id: args.id, deleted: true };
    });
  },
});
