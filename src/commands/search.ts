import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { searchWorkspace } from '../search/index.js';

const ArgsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  initiative: z.string().min(1).optional(),
});

const HitSchema = z.object({
  ref: z.string(),
  class: z.string(),
  initiative: z.string().nullable(),
  title: z.string().nullable(),
  path: z.string().nullable(),
  excerpt: z.string().nullable(),
  score: z.number(),
  sources: z.array(z.string()),
});

const ResultSchema = z.object({
  query: z.string(),
  hits: z.array(HitSchema),
  // A retriever that failed contributed nothing and is named here. The search
  // still answers, with less; an index is allowed to be partly broken.
  degraded: z.array(z.object({ retriever: z.string(), reason: z.string(), message: z.string() })),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'search',
  description:
    'Search every initiative at once: notes, briefs, sources, tasks, session records and mined transcripts.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['query'],
    options: {
      limit: { long: '--limit', description: 'How many results to return (default 10)' },
      initiative: {
        long: '--initiative',
        description:
          'Bias towards this initiative. A boost, never a filter — foreign hits still rank.',
      },
    },
    usage: 'active-work search <query> [--limit 10] [--initiative <slug>]',
  },
  async run(args) {
    const { hits, degraded } = await searchWorkspace(args.query, {
      limit: args.limit,
      initiative: args.initiative,
    });
    return {
      query: args.query,
      hits,
      degraded: degraded.map((entry) => ({
        retriever: entry.retriever,
        reason: entry.reason,
        message: entry.message,
      })),
    };
  },
});
