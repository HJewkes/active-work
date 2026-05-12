import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { validateSlug } from '../utils/slug.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  old_slug: z.string().min(1),
  new_slug: z.string().min(1),
});

const ResultSchema = z.object({
  from: z.string(),
  to: z.string(),
});

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export default defineCommand({
  name: 'rename',
  description: 'Rename an initiative slug (moves the directory; task_prefix unchanged).',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['old_slug', 'new_slug'],
    usage: 'aw rename <old-slug> <new-slug>',
  },
  async run(args, ctx) {
    const check = validateSlug(args.new_slug);
    if (!check.ok) {
      throw new ValidationError(`Invalid new slug "${args.new_slug}": ${check.error}`);
    }

    const from = path.join(ctx.activeRoot, args.old_slug);
    const to = path.join(ctx.activeRoot, args.new_slug);

    if (!(await dirExists(from))) {
      throw new NotFoundError(`Initiative not found: ${args.old_slug}`);
    }
    if (await dirExists(to)) {
      throw new ValidationError(`Destination already exists: ${args.new_slug}`);
    }

    await fs.rename(from, to);
    return { from, to };
  },
});
