import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { runDrainIngest } from '../miner/transcript-reader.js';

/**
 * `active-work miner drain-ingest` — cluster new tool-result and error blobs
 * from `~/.claude/projects` into the AW-28 Drain template store
 * (`<minerRoot>/templates.yml` + `occurrences.jsonl`).
 *
 * Registered alongside `miner refresh`/`miner status` (AW-90) so the miner CLI
 * surface stays one namespace, even though the two miners share no store:
 * `refresh` fills the session-signal SQLite index, this fills the template
 * store. `tools/mine-drain.mjs` is a thin wrapper over the same function, per
 * the `build-session-index.mjs` precedent.
 */

const ArgsSchema = z.object({
  full: z.boolean().optional(),
  limit: z.coerce.number().int().positive().optional(),
  verify_hashes: z.boolean().optional(),
});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  startedAt: z.string(),
  durationMs: z.number(),
  transcripts: z.number(),
  scanned: z.number(),
  unchanged: z.number(),
  rewound: z.number(),
  linesRead: z.number(),
  malformedLines: z.number(),
  blobs: z.number(),
  ingested: z.number(),
  newTemplates: z.number(),
  templates: z.number(),
  evicting: z.boolean(),
  curve: z.array(z.object({ blobs: z.number(), templates: z.number(), evicting: z.boolean() })),
  errors: z.array(z.string()),
});
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'miner.drain-ingest',
  description:
    'Cluster new tool-result/error blobs from Claude transcripts into the template store.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      full: {
        long: '--full',
        description: 'Ignore stored watermarks and re-read every transcript from byte 0.',
      },
      limit: {
        long: '--limit',
        description: 'Visit at most N transcripts.',
      },
      verify_hashes: {
        long: '--verify-hashes',
        description: 'Re-hash each read prefix to detect a rewritten transcript (slow).',
      },
    },
  },
  async run(args) {
    return runDrainIngest({
      full: args.full,
      limit: args.limit,
      verifyHashes: args.verify_hashes,
    });
  },
});
