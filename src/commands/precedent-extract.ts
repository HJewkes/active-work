import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { extractPrecedents } from '../decider/extract.js';
import { getActiveRoot } from '../utils/paths.js';

/**
 * `active-work precedent extract` — index the human's answers as precedents.
 *
 * Feeds the `@titan-design/decider` ledger (`.decider/decider.sqlite3` in the
 * active root) from the v1 `precedents.jsonl` files, `AskUserQuestion` calls in
 * transcripts the miner graph located, `kind: decision` notes, imported
 * `feedback` memories and agent-chat queue answers. Each source resumes from
 * its watermark and rows are keyed, so a re-run writes nothing twice.
 */

const ArgsSchema = z.object({});
type Args = z.infer<typeof ArgsSchema>;

const SourceSummarySchema = z.object({
  source: z.string(),
  read: z.number(),
  written: z.number(),
  alreadyIndexed: z.number(),
  excluded: z.record(z.string(), z.number()),
  pending: z.number(),
  errors: z.array(z.string()),
});

const ResultSchema = z.object({
  ledger: z.string(),
  sources: z.array(SourceSummarySchema),
});
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'precedent.extract',
  description:
    "Index the human's answered questions, decision notes and queue answers as precedents.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: { usage: 'active-work precedent extract' },
  async run() {
    return extractPrecedents({ activeRoot: getActiveRoot() });
  },
});
