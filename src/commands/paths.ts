import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { NotFoundError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
});

const ResultSchema = z.object({
  brief: z.string(),
  handoff: z.string(),
  tasks_dir: z.string(),
  sessions_dir: z.string(),
  artifacts: z.string(),
  sources_dir: z.string(),
});

export default defineCommand({
  name: 'paths',
  description: 'Print all artifact paths for an initiative.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    usage: 'active-work paths <slug>',
  },
  async run(args, ctx) {
    const dir = path.join(ctx.activeRoot, args.slug);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) {
        throw new NotFoundError(`Initiative not found: ${args.slug}`);
      }
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      throw new NotFoundError(`Initiative not found: ${args.slug}`);
    }

    return {
      brief: path.join(dir, 'brief.md'),
      handoff: path.join(dir, 'handoff.md'),
      tasks_dir: path.join(dir, 'tasks'),
      sessions_dir: path.join(dir, 'sessions'),
      artifacts: path.join(dir, 'artifacts.yml'),
      sources_dir: path.join(dir, 'sources'),
    };
  },
});
