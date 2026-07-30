import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { runRefresh, withRefreshLock } from '../miner/session-index/refresh.js';

/**
 * `active-work miner refresh` — bring the session-signal index up to date with
 * `~/.claude/projects`.
 *
 * Shares one code path with the daemon's watcher and
 * `tools/build-session-index.mjs`. The refresh lock is cross-process and this
 * command *blocks* on it: if the daemon is mid-pass, the user's refresh waits
 * and then runs, rather than failing or silently doing nothing. That is why
 * there is no HTTP endpoint here — the lock already serializes the two.
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
  indexed: z.number(),
  unchanged: z.number(),
  quarantined: z.number(),
  missing: z.number(),
  factsAdded: z.number(),
  sessionsRolledUp: z.number(),
  errors: z.array(z.string()),
});
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'miner.refresh',
  description: 'Index new Claude session transcripts into the session-signal index.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      full: {
        long: '--full',
        description: 'Drop every derived row and re-read all transcripts from byte 0.',
      },
      limit: {
        long: '--limit',
        description: 'Visit at most N transcripts.',
      },
      verify_hashes: {
        long: '--verify-hashes',
        description: 'Re-hash every transcript to detect source drift (slow; implied by --full).',
      },
    },
  },
  async run(args) {
    return withRefreshLock(() =>
      runRefresh({ full: args.full, limit: args.limit, verifyHashes: args.verify_hashes }),
    );
  },
});
