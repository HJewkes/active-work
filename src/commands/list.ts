import { z } from 'zod';
import type { BriefFrontmatter } from '../schemas/brief.js';
import { getActiveRoot } from '../utils/paths.js';
import { scanInitiatives } from './audit.js';
import { defineCommand } from '../registry/index.js';

const argsSchema = z.object({}).strict();

const itemSchema = z.object({
  slug: z.string(),
  title: z.string(),
  state: z.enum(['focused', 'backburner', 'paused', 'done']),
  rank: z.number().int().positive().optional(),
  ship_target: z.string().optional(),
  paused_since: z.string().optional(),
  updated: z.string(),
});

const sectionSchema = z.object({
  heading: z.string(),
  items: z.array(itemSchema),
});

const parseErrorSchema = z.object({
  slug: z.string(),
  error: z.string(),
});

const resultSchema = z.object({
  sections: z.array(sectionSchema),
  parse_errors: z.array(parseErrorSchema),
});

interface Item {
  slug: string;
  title: string;
  state: BriefFrontmatter['state'];
  rank?: number;
  ship_target?: string;
  paused_since?: string;
  updated: string;
}

function toItem(slug: string, fm: BriefFrontmatter): Item {
  return {
    slug,
    title: fm.title,
    state: fm.state,
    ...(fm.rank !== undefined ? { rank: fm.rank } : {}),
    ...(fm.ship_target !== undefined ? { ship_target: fm.ship_target } : {}),
    ...(fm.paused_since !== undefined ? { paused_since: fm.paused_since } : {}),
    updated: fm.updated,
  };
}

export default defineCommand({
  name: 'list',
  description:
    'List every initiative grouped by state. Replaces the legacy INDEX.md dump.',
  args: argsSchema,
  result: resultSchema,
  cli: {
    usage: 'list',
  },
  async run() {
    const activeRoot = getActiveRoot();
    const { entries, errors } = await scanInitiatives(activeRoot);

    const focused: Item[] = [];
    const backburner: Item[] = [];
    const paused: Item[] = [];
    const done: Item[] = [];

    for (const { slug, frontmatter } of entries) {
      const item = toItem(slug, frontmatter);
      switch (frontmatter.state) {
        case 'focused':
          focused.push(item);
          break;
        case 'backburner':
          backburner.push(item);
          break;
        case 'paused':
          paused.push(item);
          break;
        case 'done':
          done.push(item);
          break;
      }
    }

    focused.sort((a, b) => {
      const aRank = a.rank ?? Number.POSITIVE_INFINITY;
      const bRank = b.rank ?? Number.POSITIVE_INFINITY;
      if (aRank !== bRank) return aRank - bRank;
      return a.slug.localeCompare(b.slug);
    });
    backburner.sort((a, b) => a.slug.localeCompare(b.slug));
    paused.sort((a, b) => {
      const aPaused = a.paused_since ?? '';
      const bPaused = b.paused_since ?? '';
      if (aPaused !== bPaused) return aPaused.localeCompare(bPaused);
      return a.slug.localeCompare(b.slug);
    });
    done.sort((a, b) => {
      if (a.updated !== b.updated) return b.updated.localeCompare(a.updated);
      return a.slug.localeCompare(b.slug);
    });

    return {
      sections: [
        { heading: 'Focused', items: focused },
        { heading: 'Backburner', items: backburner },
        { heading: 'Paused', items: paused },
        { heading: 'Done', items: done },
      ],
      parse_errors: errors,
    };
  },
});
