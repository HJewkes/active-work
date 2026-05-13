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
import { loadAllBriefs, sortSlugs } from './_focus-helpers.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
});

const RenumberEntrySchema = z.object({
  slug: z.string(),
  from: z.number().int().positive(),
  to: z.number().int().positive(),
});

const ResultSchema = z.object({
  slug: z.string(),
  renumbered: z.array(RenumberEntrySchema),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'unfocus',
  description: 'Demote a focused initiative to backburner and renumber survivors.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    usage: 'active-work unfocus <slug>',
  },
  async run({ slug }) {
    const briefs = await loadAllBriefs();
    const target = briefs.find((b) => b.slug === slug);
    if (!target) {
      throw new NotFoundError(`Initiative not found: ${slug}`);
    }
    if (target.frontmatter.state !== 'focused') {
      throw new UsageError(
        `Cannot unfocus ${slug}: state is ${target.frontmatter.state}`,
      );
    }

    const survivors = briefs
      .filter((b) => b.frontmatter.state === 'focused' && b.slug !== slug)
      .map((b) => {
        if (b.frontmatter.rank === undefined) {
          throw new Error(`Focused initiative ${b.slug} missing rank`);
        }
        return { slug: b.slug, rank: b.frontmatter.rank };
      })
      .sort((a, b) => a.rank - b.rank);

    const renumberOps: { slug: string; from: number; to: number }[] = [];
    survivors.forEach((s, i) => {
      const newRank = i + 1;
      if (s.rank !== newRank) {
        renumberOps.push({ slug: s.slug, from: s.rank, to: newRank });
      }
    });

    const updateDate = today();
    const slugsToLock = sortSlugs([slug, ...renumberOps.map((r) => r.slug)]);

    await applyLocked(slugsToLock, async () => {
      // Write target.
      const cleared: BriefFrontmatter = {
        ...target.frontmatter,
        state: 'backburner',
        updated: updateDate,
      };
      delete (cleared as Partial<BriefFrontmatter>).rank;
      await writeFrontmatter(
        target.briefPath,
        cleared,
        target.body,
        BriefFrontmatterSchema,
      );

      // Renumber survivors that actually moved.
      for (const op of renumberOps) {
        const brief = briefs.find((b) => b.slug === op.slug);
        if (!brief) continue;
        const next: BriefFrontmatter = {
          ...brief.frontmatter,
          state: 'focused',
          rank: op.to,
          updated: updateDate,
        };
        await writeFrontmatter(
          brief.briefPath,
          next,
          brief.body,
          BriefFrontmatterSchema,
        );
      }
    });

    return { slug, renumbered: renumberOps };
  },
});

async function applyLocked(
  slugs: string[],
  fn: () => Promise<void>,
): Promise<void> {
  const recurse = async (index: number): Promise<void> => {
    if (index === slugs.length) {
      await fn();
      return;
    }
    await withFileLock(getLockPath(slugs[index]), () => recurse(index + 1));
  };
  await recurse(0);
}
