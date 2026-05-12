import { z } from 'zod';
import {
  BriefFrontmatterSchema,
  type BriefFrontmatter,
} from '../schemas/brief.js';
import { getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { writeFrontmatter } from '../utils/gray-matter-io.js';
import { today } from '../utils/today.js';
import { NotFoundError } from '../errors.js';
import { defineCommand } from '../registry/index.js';
import { loadAllBriefs, sortSlugs } from './_focus-helpers.js';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const isoDate = z
  .string()
  .regex(ISO_DATE_REGEX, 'since must be YYYY-MM-DD')
  .refine((v) => {
    const parsed = new Date(v);
    if (Number.isNaN(parsed.getTime())) return false;
    return parsed.toISOString().slice(0, 10) === v;
  }, 'since must be a valid calendar date');

const ArgsSchema = z.object({
  slug: z.string().min(1),
  since: isoDate,
  restart_trigger: z.string().min(1),
});

const ResultSchema = z.object({
  slug: z.string(),
  paused_since: z.string(),
  restart_trigger: z.string(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'pause',
  description: 'Mark an initiative as paused with required restart metadata.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      since: {
        long: '--since',
        description: 'Pause-since date (YYYY-MM-DD).',
        required: true,
      },
      'restart-trigger': {
        long: '--restart-trigger',
        description: 'What event should cause this initiative to resume.',
        required: true,
      },
    },
    usage: 'aw pause <slug> --since YYYY-MM-DD --restart-trigger "..."',
  },
  async run({ slug, since, restart_trigger }) {
    const briefs = await loadAllBriefs();
    const target = briefs.find((b) => b.slug === slug);
    if (!target) {
      throw new NotFoundError(`Initiative not found: ${slug}`);
    }

    const wasFocused = target.frontmatter.state === 'focused';
    const survivors = wasFocused
      ? briefs
          .filter(
            (b) => b.frontmatter.state === 'focused' && b.slug !== slug,
          )
          .map((b) => {
            if (b.frontmatter.rank === undefined) {
              throw new Error(`Focused initiative ${b.slug} missing rank`);
            }
            return { slug: b.slug, rank: b.frontmatter.rank };
          })
          .sort((a, b) => a.rank - b.rank)
      : [];

    const renumberOps: { slug: string; to: number }[] = [];
    survivors.forEach((s, i) => {
      const newRank = i + 1;
      if (s.rank !== newRank) {
        renumberOps.push({ slug: s.slug, to: newRank });
      }
    });

    const updateDate = today();
    const slugsToLock = sortSlugs([slug, ...renumberOps.map((r) => r.slug)]);

    await applyLocked(slugsToLock, async () => {
      const paused: BriefFrontmatter = {
        ...target.frontmatter,
        state: 'paused',
        paused_since: since,
        restart_trigger,
        updated: updateDate,
      };
      delete (paused as Partial<BriefFrontmatter>).rank;
      await writeFrontmatter(
        target.briefPath,
        paused,
        target.body,
        BriefFrontmatterSchema,
      );

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

    return { slug, paused_since: since, restart_trigger };
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
