import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { searchPrecedents } from '../precedent/search.js';
import { PrecedentRowSchema, type PrecedentRow } from '../precedent/schema.js';
import { readAllPrecedents } from '../precedent/store.js';
import { getActiveRoot } from '../utils/paths.js';

const ArgsSchema = z.object({
  query: z.string().min(1),
  limit: z.coerce.number().int().positive().max(100).optional(),
  initiative: z.string().min(1).optional(),
  class: z.string().min(1).optional(),
});
type Args = z.infer<typeof ArgsSchema>;

const HitSchema = PrecedentRowSchema.extend({
  score: z.number(),
  /** Where the row came from, in a form a reader can follow back. */
  citation: z.string(),
});

const ResultSchema = z.object({
  query: z.string(),
  hits: z.array(HitSchema),
  malformed: z.number(),
});
type Result = z.infer<typeof ResultSchema>;

function citationOf(row: PrecedentRow): string {
  if (row.source !== 'transcript') return row.key;
  return `session ${row.session_id ?? '?'} tool_use ${row.tool_use_id ?? '?'} at ${row.asked_at ?? '?'}`;
}

export default defineCommand<Args, Result>({
  name: 'precedent.search',
  description: 'Rank indexed precedents (answered questions, decisions) for a query.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['query'],
    options: {
      limit: { long: '--limit', description: 'How many results to return (default 8)' },
      initiative: {
        long: '--initiative',
        description: 'Bias towards this initiative. A boost, never a filter.',
      },
      class: { long: '--class', description: 'Only precedents of this class, e.g. merge_gate' },
    },
    usage: 'active-work precedent search <query> [--limit 8] [--initiative <slug>] [--class <c>]',
  },
  async run(args) {
    const { rows, malformed } = await readAllPrecedents(getActiveRoot());
    const hits = await searchPrecedents(rows, args.query, {
      limit: args.limit,
      initiative: args.initiative,
      class: args.class,
    });
    return {
      query: args.query,
      hits: hits.map(({ score, row }) => ({ ...row, score, citation: citationOf(row) })),
      malformed,
    };
  },
});
