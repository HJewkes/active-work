import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BriefFrontmatterSchema } from '../schemas/brief.js';
import { getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readRawFrontmatter, writeFrontmatter } from '../utils/gray-matter-io.js';
import { today } from '../utils/today.js';
import { NotFoundError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
});

const ResultSchema = z.object({
  slug: z.string(),
  updated: z.string(),
});

export default defineCommand({
  name: 'touch',
  description: "Stamp `updated: today()` on an initiative's brief.md.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    usage: 'active-work touch <slug>',
  },
  async run(args, ctx) {
    const briefPath = path.join(ctx.activeRoot, args.slug, 'brief.md');
    try {
      await fs.access(briefPath);
    } catch {
      throw new NotFoundError(`Initiative not found: ${args.slug}`);
    }

    const updated = today();
    await withFileLock(getLockPath(args.slug), async () => {
      const { frontmatter, body } = await readRawFrontmatter(briefPath);
      frontmatter.updated = updated;
      await writeFrontmatter(briefPath, frontmatter, body, BriefFrontmatterSchema);
    });

    return { slug: args.slug, updated };
  },
});
