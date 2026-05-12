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
import {
  loadAllBriefs,
  sortSlugs,
  type InitiativeBrief,
} from './_focus-helpers.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  rank: z.number().int().positive().optional(),
});

const ShiftEntrySchema = z.object({
  slug: z.string(),
  from: z.number().int().positive().optional(),
  to: z.number().int().positive(),
});

const ResultSchema = z.object({
  slug: z.string(),
  rank: z.number().int().positive(),
  shifted: z.array(ShiftEntrySchema),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

interface RankedSlug {
  slug: string;
  rank: number;
}

function buildRanking(briefs: InitiativeBrief[]): RankedSlug[] {
  return briefs
    .filter((b) => b.frontmatter.state === 'focused')
    .map((b) => {
      // schema guarantees rank is present when state is focused
      const rank = b.frontmatter.rank;
      if (rank === undefined) {
        throw new Error(
          `Focused initiative ${b.slug} is missing rank in brief.md`,
        );
      }
      return { slug: b.slug, rank };
    })
    .sort((a, b) => a.rank - b.rank);
}

export default defineCommand<Args, Result>({
  name: 'focus',
  description: 'Promote an initiative into the focused list at a given rank.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      rank: {
        long: '--rank',
        description: 'Target rank (positive integer). Defaults to end of list.',
      },
    },
    usage: 'aw focus <slug> [--rank N]',
  },
  async run({ slug, rank }) {
    const briefs = await loadAllBriefs();
    const target = briefs.find((b) => b.slug === slug);
    if (!target) {
      throw new NotFoundError(`Initiative not found: ${slug}`);
    }

    const ranked = buildRanking(briefs);
    const currentRank = ranked.find((r) => r.slug === slug)?.rank;
    const withoutTarget = ranked.filter((r) => r.slug !== slug);

    let desired: number;
    if (rank === undefined) {
      // Append: 1 if no one focused (excluding target), else max+1.
      desired = withoutTarget.length === 0
        ? 1
        : Math.max(...withoutTarget.map((r) => r.rank)) + 1;
    } else {
      const maxAllowed = withoutTarget.length + 1;
      if (rank > maxAllowed) {
        throw new UsageError(
          `rank ${rank} exceeds maximum of ${maxAllowed} for the focused list`,
        );
      }
      desired = rank;
    }

    // Compute the new ranking.
    const finalRanking: RankedSlug[] = withoutTarget.map((r) => ({
      slug: r.slug,
      rank: r.rank >= desired ? r.rank + 1 : r.rank,
    }));
    finalRanking.push({ slug, rank: desired });
    finalRanking.sort((a, b) => a.rank - b.rank);

    // Determine which briefs actually changed so we only rewrite those.
    const changes = new Map<string, { from?: number; to: number }>();
    for (const entry of finalRanking) {
      const prior = ranked.find((r) => r.slug === entry.slug)?.rank;
      const sameState =
        entry.slug === slug
          ? target.frontmatter.state === 'focused' && prior === entry.rank
          : prior === entry.rank;
      if (!sameState) {
        changes.set(entry.slug, { from: prior, to: entry.rank });
      }
    }

    // Always include target if it wasn't focused before, even if rank
    // somehow matches (defensive).
    if (!changes.has(slug)) {
      changes.set(slug, { from: currentRank, to: desired });
    }

    const updateDate = today();
    const lockOrder = sortSlugs(changes.keys());
    await applyLocked(lockOrder, async () => {
      for (const slugToWrite of lockOrder) {
        const change = changes.get(slugToWrite);
        if (!change) continue;
        const brief = briefs.find((b) => b.slug === slugToWrite);
        if (!brief) {
          throw new NotFoundError(
            `Initiative ${slugToWrite} disappeared mid-update`,
          );
        }
        const next: BriefFrontmatter = {
          ...brief.frontmatter,
          state: 'focused',
          rank: change.to,
          updated: updateDate,
        };
        // Clear paused-only fields just in case target was paused; safe noop
        // for already-focused entries.
        delete (next as Partial<BriefFrontmatter>).paused_since;
        delete (next as Partial<BriefFrontmatter>).restart_trigger;
        await writeFrontmatter(
          brief.briefPath,
          next,
          brief.body,
          BriefFrontmatterSchema,
        );
      }
    });

    const shifted = [...changes.entries()]
      .filter(([s]) => s !== slug)
      .map(([s, c]) => ({ slug: s, from: c.from, to: c.to }))
      .sort((a, b) => a.to - b.to);

    return { slug, rank: desired, shifted };
  },
});

async function applyLocked(
  slugs: string[],
  fn: () => Promise<void>,
): Promise<void> {
  // Acquire all locks in deterministic order. Nest withFileLock calls so
  // releases happen in reverse order.
  const recurse = async (index: number): Promise<void> => {
    if (index === slugs.length) {
      await fn();
      return;
    }
    await withFileLock(getLockPath(slugs[index]), () => recurse(index + 1));
  };
  await recurse(0);
}
