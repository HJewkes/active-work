import { z } from 'zod';
import {
  BriefFrontmatterSchema,
  type BriefFrontmatter,
} from '../schemas/brief.js';
import { getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { writeFrontmatter } from '../utils/gray-matter-io.js';
import { today } from '../utils/today.js';
import { NotFoundError, UsageError } from '../errors.js';
import { defineCommand } from '../registry/index.js';
import { loadAllBriefs } from './_focus-helpers.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
});

const ResultSchema = z.object({
  slug: z.string(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'unpause',
  description: 'Move a paused initiative back to backburner.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    usage: 'active-work unpause <slug>',
  },
  async run({ slug }) {
    const briefs = await loadAllBriefs();
    const target = briefs.find((b) => b.slug === slug);
    if (!target) {
      throw new NotFoundError(`Initiative not found: ${slug}`);
    }
    if (target.frontmatter.state !== 'paused') {
      throw new UsageError(
        `Cannot unpause ${slug}: state is ${target.frontmatter.state}`,
      );
    }

    await withFileLock(getLockPath(slug), async () => {
      const next: BriefFrontmatter = {
        ...target.frontmatter,
        state: 'backburner',
        updated: today(),
      };
      delete (next as Partial<BriefFrontmatter>).paused_since;
      delete (next as Partial<BriefFrontmatter>).restart_trigger;
      delete (next as Partial<BriefFrontmatter>).rank;
      await writeFrontmatter(
        target.briefPath,
        next,
        target.body,
        BriefFrontmatterSchema,
      );
    });

    return { slug };
  },
});
