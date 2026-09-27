import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { extractPrecedents } from '../precedent/extract.js';
import { getActiveRoot } from '../utils/paths.js';

/**
 * `active-work precedent extract` — index the human's answers as precedents.
 *
 * Reads `AskUserQuestion` calls located by the miner graph, `kind: decision`
 * notes, imported `feedback` memories and agent-chat queue answers, and
 * appends one row per answered question to `<initiative>/sources/precedents.jsonl`
 * (or the root-level `.precedents.jsonl`). Safe to re-run: rows are keyed and
 * a key already on disk is never written twice.
 */

const ArgsSchema = z.object({});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  askCalls: z.number(),
  alreadyIndexed: z.number(),
  pending: z.number(),
  written: z.object({ transcript: z.number(), note: z.number(), queue: z.number() }),
  files: z.array(z.string()),
  errors: z.array(z.string()),
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
