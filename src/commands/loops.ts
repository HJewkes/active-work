import path from 'node:path';
import { z } from 'zod';
import {
  deriveOpenLoopsFrom,
  deriveResolvedLoopsFrom,
  loadSessionsFromDir,
} from '../sessions/open-loops.js';
import { loadTasks } from '../lint/load-tasks.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  state: z.enum(['open', 'resolved', 'abandoned', 'all']).default('open'),
});

const OpenLoopSchema = z.object({
  ref: z.string(),
  text: z.string(),
  kind: z.enum(['task', 'pr', 'prose']),
  target_ref: z.string().optional(),
  session_file: z.string(),
  opened_at: z.string(),
  age_days: z.number().int().nonnegative(),
});

const ResolvedLoopSchema = z.object({
  ref: z.string(),
  text: z.string(),
  kind: z.enum(['task', 'pr', 'prose']),
  outcome: z.enum(['done', 'abandoned']),
  note: z.string().optional(),
  session_file: z.string(),
  closed_by: z.string(),
  opened_at: z.string(),
  closed_at: z.string(),
  age_days: z.number().int().nonnegative(),
});

const ResultSchema = z.object({
  slug: z.string(),
  open: z.array(OpenLoopSchema),
  resolved: z.array(ResolvedLoopSchema),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'loops',
  description:
    "List an initiative's open-loop ledger. Open loops are the unresolved remainder; resolved ones carry the outcome and the reason they were closed, which the bootstrap only surfaces for recent abandonments.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      state: {
        long: '--state',
        description:
          "'open' (default) | 'resolved' | 'abandoned' | 'all'",
      },
    },
    usage: 'active-work loops <slug> [--state open|resolved|abandoned|all]',
  },
  async run(args, ctx) {
    const initiativeDir = path.join(ctx.activeRoot, args.slug);
    const [loaded, tasks] = await Promise.all([
      loadSessionsFromDir(initiativeDir),
      loadTasks(initiativeDir),
    ]);
    const opts = { now: new Date(), tasks };
    const wantOpen = args.state === 'open' || args.state === 'all';
    const wantResolved = args.state !== 'open';

    const open = wantOpen
      ? deriveOpenLoopsFrom(loaded, opts).map((loop) => ({
          ref: loop.ref,
          text: loop.text,
          kind: loop.kind,
          ...(loop.targetRef !== undefined ? { target_ref: loop.targetRef } : {}),
          session_file: loop.sessionFile,
          opened_at: loop.openedAt,
          age_days: loop.ageDays,
        }))
      : [];

    const resolved = wantResolved
      ? deriveResolvedLoopsFrom(loaded, opts)
          .filter((loop) => args.state !== 'abandoned' || loop.outcome === 'abandoned')
          .map((loop) => ({
            ref: loop.ref,
            text: loop.text,
            kind: loop.kind,
            outcome: loop.outcome,
            ...(loop.note !== undefined ? { note: loop.note } : {}),
            session_file: loop.sessionFile,
            closed_by: loop.closedBy,
            opened_at: loop.openedAt,
            closed_at: loop.closedAt,
            age_days: loop.ageDays,
          }))
      : [];

    return { slug: args.slug, open, resolved };
  },
});
