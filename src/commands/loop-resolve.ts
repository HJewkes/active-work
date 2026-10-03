import path from 'node:path';
import { z } from 'zod';
import {
  assertInitiativeExists,
  findLoopToClose,
  recordLoopResolve,
} from '../sessions/loop-ledger.js';
import { loadSessionsFromDir } from '../sessions/open-loops.js';
import { getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { assertValidSlug } from '../utils/slug.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z
  .object({
    slug: z.string().min(1),
    id: z.string().min(1),
    outcome: z.enum(['done', 'abandoned']).default('done'),
    note: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.outcome === 'abandoned' && value.note === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: '--note is required when --outcome is abandoned: say why it was dropped',
      });
    }
  });

const ResultSchema = z.object({
  ref: z.string(),
  text: z.string(),
  outcome: z.enum(['done', 'abandoned']),
  note: z.string().optional(),
  closed_by: z.string(),
  path: z.string(),
  closed_at: z.string(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'loop.resolve',
  description:
    'Close an open loop now, without waiting for wrap. <id> is the full ref printed by ' +
    '`active-work loops` (<session-file-stem>#<id>), or the bare id when only one open loop ' +
    'carries it. Fails, and writes nothing, when the loop is already resolved or abandoned, ' +
    'when the id names several open loops, or when it names none.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug', 'id'],
    options: {
      outcome: {
        long: '--outcome',
        description: "'done' (default) | 'abandoned'",
      },
      note: {
        long: '--note',
        description: 'Why the loop closed. Required for --outcome abandoned',
      },
    },
    usage: 'active-work loop resolve <slug> <id> [--outcome done|abandoned] [--note <text>]',
  },
  async run(args, ctx) {
    assertValidSlug(args.slug);
    const target = { slug: args.slug, activeRoot: ctx.activeRoot };
    await assertInitiativeExists(target);
    const resolution = {
      outcome: args.outcome,
      ...(args.note !== undefined ? { note: args.note } : {}),
    };
    return withFileLock(getLockPath(args.slug), async () => {
      const loaded = await loadSessionsFromDir(path.join(ctx.activeRoot, args.slug));
      const now = new Date();
      const loop = findLoopToClose(loaded, args.id, args.slug, now);
      const entry = await recordLoopResolve(target, loop, resolution, now);
      return {
        ref: loop.ref,
        text: loop.text,
        ...resolution,
        closed_by: entry.sessionFile,
        path: entry.path,
        closed_at: entry.at,
      };
    });
  },
});
