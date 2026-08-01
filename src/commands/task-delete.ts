import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { getActiveRoot, getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { writeFrontmatter } from '../utils/gray-matter-io.js';
import { BriefFrontmatterSchema } from '../schemas/brief.js';
import {
  loadBrief,
  maxOnDiskTaskNumberFromFilenames,
  readTaskSeq,
  taskNumber,
} from '../utils/task-seq.js';
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
      const file = path.join(getInitiativeDir(args.slug), 'tasks', `${args.id}.yml`);
      try {
        await fs.access(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new NotFoundError(`Task not found: ${args.id}`);
        }
        throw err;
      }

      // Deleting the current highest id would let task.add reissue it on the
      // next call, since its on-disk scan can no longer see this file (AW-94:
      // task_seq now moves here instead of on every task.add). Bump the
      // high-water mark *before* unlinking, so a crash between the two never
      // leaves it stale.
      const brief = await loadBrief(args.slug);
      const onDiskMax = await maxOnDiskTaskNumberFromFilenames(brief.prefix, args.slug);
      const n = taskNumber(brief.prefix, args.id);
      if (n !== null && n === onDiskMax) {
        const stored = readTaskSeq(brief, onDiskMax);
        if (stored < n) {
          const frontmatter: Record<string, unknown> = {
            ...brief.frontmatter,
            task_seq: n,
          };
          await writeFrontmatter(brief.path, frontmatter, brief.body, BriefFrontmatterSchema);
        }
      }

      await fs.unlink(file);
      return { id: args.id, deleted: true };
    });
  },
});
