import type { LedgerRow } from '@titan-design/decider';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { loadHumanOnlyInitiatives } from '../decider/human-only.js';
import { readLedgerRows } from '../decider/ledger.js';
import { isUnclaimed, searchPrecedents } from '../decider/search.js';
import { getActiveRoot } from '../utils/paths.js';

const ArgsSchema = z.object({
  query: z.string().min(1),
  limit: z.coerce.number().int().positive().max(100).optional(),
  initiative: z.string().min(1).optional(),
  class: z.string().min(1).optional(),
  include_unclaimed: z.boolean().optional(),
});
type Args = z.infer<typeof ArgsSchema>;

const HitSchema = z.object({
  key: z.string(),
  source: z.string(),
  asked_at: z.string().nullable(),
  initiative: z.string().nullable(),
  unclaimed: z.boolean(),
  category: z.string(),
  header: z.string().nullable(),
  question: z.string(),
  options: z.array(z.string()),
  recommended: z.string().nullable(),
  answer: z.string().nullable(),
  outcome: z.string().nullable(),
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

function citationOf(row: LedgerRow): string {
  if (row.source !== 'transcript') return row.key;
  const session = row.locator?.sessionId ?? row.session_id ?? '?';
  const toolUse = row.locator?.toolUseId ?? row.tool_use_id ?? '?';
  return `session ${session} tool_use ${toolUse} at ${row.asked_at ?? '?'}`;
}

function toHit(row: LedgerRow, score: number): z.infer<typeof HitSchema> {
  return {
    key: row.key,
    source: row.source,
    asked_at: row.asked_at,
    initiative: row.initiative,
    unclaimed: isUnclaimed(row),
    category: row.category,
    header: row.header,
    question: row.question,
    options: row.options.map((o) => o.label),
    recommended: row.recommended,
    answer: row.answer,
    outcome: row.outcome,
    score,
    citation: citationOf(row),
  };
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
      class: { long: '--class', description: 'Only precedents of this category, e.g. merge_gate' },
      include_unclaimed: {
        long: '--include-unclaimed',
        description: 'Also return precedents no initiative claims (hidden by default)',
      },
    },
    usage:
      'active-work precedent search <query> [--limit 8] [--initiative <slug>] [--class <c>] [--include-unclaimed]',
  },
  async run(args) {
    const activeRoot = getActiveRoot();
    const humanOnly = await loadHumanOnlyInitiatives(activeRoot);
    const { rows, malformed } = await readLedgerRows(activeRoot);
    const hits = await searchPrecedents(rows, args.query, {
      limit: args.limit,
      initiative: args.initiative,
      category: args.class,
      includeUnclaimed: args.include_unclaimed,
      humanOnly,
    });
    return {
      query: args.query,
      hits: hits.map(({ score, row }) => toHit(row, score)),
      malformed,
    };
  },
});
