import path from 'node:path';
import { z } from 'zod';
import {
  deriveOpenLoopsFrom,
  deriveResolvedLoopsFrom,
  loadSessionsFromDir,
  triggersMet,
  type LoadedSessions,
  type LoopTrigger,
  type OpenLoop,
} from '../sessions/open-loops.js';
import { findMergedPrLoops } from '../sessions/loop-pr-state.js';
import { loadTasks } from '../lint/load-tasks.js';
import type { Task } from '../schemas/task.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  state: z.enum(['open', 'resolved', 'abandoned', 'all']).default('open'),
  due: z.boolean().optional(),
  offline: z.boolean().optional(),
});

const OpenLoopSchema = z.object({
  ref: z.string(),
  text: z.string(),
  kind: z.enum(['task', 'pr', 'prose']),
  target_ref: z.string().optional(),
  due: z.string().optional(),
  /** Present when the loop is owed now: which of its triggers fired. */
  trigger_met: z.array(z.enum(['task-done', 'pr-merged', 'due'])).optional(),
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

type OpenEntry = z.infer<typeof OpenLoopSchema>;

interface OpenContext {
  initiativeDir: string;
  tasks: Task[];
  now: Date;
  warnings: string[];
}

function toOpenEntry(loop: OpenLoop, fired: LoopTrigger[]): OpenEntry {
  return {
    ref: loop.ref,
    text: loop.text,
    kind: loop.kind,
    ...(loop.targetRef !== undefined ? { target_ref: loop.targetRef } : {}),
    ...(loop.due !== undefined ? { due: loop.due } : {}),
    ...(fired.length > 0 ? { trigger_met: fired } : {}),
    session_file: loop.sessionFile,
    opened_at: loop.openedAt,
    age_days: loop.ageDays,
  };
}

/**
 * Every loop with no explicit resolution, marked with the triggers that fired.
 *
 * Derived without `tasks`, unlike the bootstrap: there a done task closes its
 * loop silently, which is right for "finish SI-1" and wrong for "once SI-1 is
 * done, do X". Here such a loop stays listed and says its trigger is met.
 */
async function openEntries(
  loaded: LoadedSessions,
  args: Args,
  context: OpenContext,
): Promise<OpenEntry[]> {
  const { now, tasks } = context;
  const loops = deriveOpenLoopsFrom(loaded, { now });
  const prs =
    args.offline === true
      ? { merged: new Set<string>(), warnings: [] }
      : await findMergedPrLoops(context.initiativeDir, loops);
  context.warnings.push(...prs.warnings);
  return loops.map((loop) => {
    const mergedPrs = prs.merged.has(loop.ref) && loop.targetRef ? [loop.targetRef] : [];
    return toOpenEntry(loop, triggersMet(loop, { now, tasks, mergedPrs }));
  });
}

function resolvedEntries(loaded: LoadedSessions, args: Args, context: OpenContext) {
  return deriveResolvedLoopsFrom(loaded, context)
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
    }));
}

export default defineCommand<Args, Result>({
  name: 'loops',
  description:
    "List an initiative's open-loop ledger. Open loops are the unresolved remainder; a loop " +
    'whose referenced task is done, whose referenced PR is merged or whose due time has passed ' +
    'carries trigger_met, and --due lists only those. Resolved ones carry the outcome and the ' +
    'reason they were closed, which the bootstrap only surfaces for recent abandonments. Open ' +
    'and close loops between wraps with `loop open` and `loop resolve`.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      state: {
        long: '--state',
        description: "'open' (default) | 'resolved' | 'abandoned' | 'all'",
      },
      due: {
        long: '--due',
        description:
          'Only open loops whose trigger is met: due time passed, task done or PR merged. Overrides --state',
      },
      offline: {
        long: '--offline',
        description: 'Skip the GitHub check for merged PRs; pr loops are then never marked',
      },
    },
    usage: 'active-work loops <slug> [--state open|resolved|abandoned|all] [--due] [--offline]',
  },
  async run(args, ctx) {
    const initiativeDir = path.join(ctx.activeRoot, args.slug);
    const [loaded, tasks] = await Promise.all([
      loadSessionsFromDir(initiativeDir),
      loadTasks(initiativeDir),
    ]);
    const context = { initiativeDir, tasks, now: new Date(), warnings: ctx.warnings };
    const dueOnly = args.due === true;
    const wantOpen = dueOnly || args.state === 'open' || args.state === 'all';
    const wantResolved = !dueOnly && args.state !== 'open';

    const open = wantOpen ? await openEntries(loaded, args, context) : [];
    return {
      slug: args.slug,
      open: dueOnly ? open.filter((loop) => loop.trigger_met !== undefined) : open,
      resolved: wantResolved ? resolvedEntries(loaded, args, context) : [],
    };
  },
});
