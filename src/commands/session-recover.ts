import path from 'node:path';
import { z } from 'zod';
import { claudeTranscriptRoots } from '@titan-design/session-read';
import { SessionIdSchema } from '../schemas/session.js';
import { assertInitiativeExists } from '../sessions/loop-ledger.js';
import { liveSessionIdsFrom } from '../sessions/live-claude-sessions.js';
import {
  findUnrecordedTranscripts,
  pickNamed,
  writeRecoveredRecord,
  type RecoverTarget,
} from '../sessions/recover-session.js';
import { getActiveRoot, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { assertValidSlug } from '../utils/slug.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  session: SessionIdSchema.optional(),
  track: z.enum(['canonical', 'sidecar', 'adhoc']).default('canonical'),
});

const ResultSchema = z.object({
  recovered: z
    .object({
      session_id: z.string(),
      path: z.string(),
      filename: z.string(),
      transcript: z.string(),
    })
    .nullable(),
  // Other transcripts with no record and no live process, newest first, capped.
  unrecorded: z.array(z.object({ session_id: z.string(), transcript: z.string() })),
  unrecorded_total: z.number().int().nonnegative(),
});

const UNRECORDED_SHOWN = 10;

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

function defaultTarget(args: Args, activeRoot: string): RecoverTarget {
  const roots = claudeTranscriptRoots();
  return {
    activeRoot,
    slug: args.slug,
    track: args.track,
    roots,
    liveSessionIds: liveSessionIdsFrom(roots.map((r) => path.dirname(r.root))),
  };
}

/** Recover one session for `target`; exported so tests can hand in their own ports. */
export async function recoverUnwrapped(
  target: RecoverTarget,
  sessionId: string | undefined,
): Promise<Result> {
  const found = await findUnrecordedTranscripts(target);
  const chosen =
    sessionId === undefined ? found.candidates[0] : pickNamed(found, sessionId, target.slug);
  const others = found.candidates.filter((t) => t !== chosen);
  const rest = {
    unrecorded: others
      .slice(0, UNRECORDED_SHOWN)
      .map((t) => ({ session_id: t.sessionId, transcript: t.path })),
    unrecorded_total: others.length,
  };
  if (!chosen) return { recovered: null, ...rest };
  const written = await writeRecoveredRecord(target, chosen);
  return {
    recovered: { session_id: chosen.sessionId, ...written, transcript: chosen.path },
    ...rest,
  };
}

export default defineCommand<Args, Result>({
  name: 'session.recover',
  description:
    'Rebuild the record of a session that ended without a wrap (a reboot, a crash, a closed ' +
    "window) from its transcript, with no model call. Picks the initiative's newest transcript " +
    'that has no session record and no running claude process, or the one --session names. ' +
    'The record is marked generated and names its transcript; open and prompt label it recovered.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      session: {
        long: '--session',
        description: 'Recover this session id rather than the newest unrecorded one',
      },
      track: {
        long: '--track',
        description: "'canonical' (default) | 'sidecar' | 'adhoc'",
      },
    },
    usage: 'active-work session recover <slug> [--session <id>] [--track canonical|sidecar|adhoc]',
  },
  async run(args, ctx) {
    assertValidSlug(args.slug);
    const activeRoot = ctx.activeRoot ?? getActiveRoot();
    await assertInitiativeExists({ slug: args.slug, activeRoot });
    const target = defaultTarget(args, activeRoot);
    return withFileLock(getLockPath(args.slug), () => recoverUnwrapped(target, args.session));
  },
});
