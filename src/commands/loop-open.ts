import { z } from 'zod';
import { NextStepSchema, type NextStep } from '../schemas/session.js';
import { assertInitiativeExists, recordLoopOpen } from '../sessions/loop-ledger.js';
import { getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { defineCommand } from '../registry/index.js';
import { slugifyLabel } from './source-add.js';

const DERIVED_ID_MAX_LENGTH = 48;

const ArgsSchema = z
  .object({
    slug: z.string().min(1),
    text: NextStepSchema.shape.text,
    kind: NextStepSchema.shape.kind.default('prose'),
    ref: NextStepSchema.shape.ref,
    due: NextStepSchema.shape.due,
    id: NextStepSchema.shape.id.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== 'prose' && value.ref === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ref'],
        message: `--ref is required when --kind is ${value.kind}: it names the ${value.kind} whose state is the trigger`,
      });
    }
  });

const ResultSchema = z.object({
  ref: z.string(),
  text: z.string(),
  kind: z.enum(['task', 'pr', 'prose']),
  target_ref: z.string().optional(),
  due: z.string().optional(),
  session_file: z.string(),
  path: z.string(),
  opened_at: z.string(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

function deriveId(text: string): string {
  return slugifyLabel(text).slice(0, DERIVED_ID_MAX_LENGTH).replace(/-+$/, '');
}

function toStep(args: Args): NextStep {
  return {
    id: args.id ?? deriveId(args.text),
    text: args.text,
    kind: args.kind,
    ...(args.ref !== undefined ? { ref: args.ref } : {}),
    ...(args.due !== undefined ? { due: args.due } : {}),
  };
}

export default defineCommand<Args, Result>({
  name: 'loop.open',
  description:
    'Open a loop now, without waiting for wrap. Use it at the moment a promise is made ' +
    '("restore the pool after the 18:00 reset", "schedule the digest once the PR merges"): ' +
    'a session that ends before it wraps loses everything it only meant to file. Give the ' +
    'promise a trigger with --due, or with --kind task|pr and --ref; `active-work loops` ' +
    'marks the loop "trigger met" when the time passes, the task is done or the PR merges.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      text: {
        long: '--text',
        description: 'What is owed, in one line a future session can act on',
        required: true,
      },
      kind: {
        long: '--kind',
        description: "'prose' (default) | 'task' | 'pr'",
      },
      ref: {
        long: '--ref',
        description:
          'The task id, or the PR as a URL, owner/repo#number or number. Required for --kind task|pr',
      },
      due: {
        long: '--due',
        description: 'ISO 8601 time with timezone at which the loop comes due',
      },
      id: {
        long: '--id',
        description: 'Short id for the loop (default: derived from --text)',
      },
    },
    usage:
      'active-work loop open <slug> --text <text> [--kind prose|task|pr] [--ref <task-id|pr>] [--due <iso>] [--id <id>]',
  },
  async run(args, ctx) {
    const target = { slug: args.slug, activeRoot: ctx.activeRoot };
    await assertInitiativeExists(target);
    const step = toStep(args);
    return withFileLock(getLockPath(args.slug), async () => {
      const entry = await recordLoopOpen(target, step, new Date());
      return {
        ref: entry.ref,
        text: step.text,
        kind: step.kind,
        ...(step.ref !== undefined ? { target_ref: step.ref } : {}),
        ...(step.due !== undefined ? { due: step.due } : {}),
        session_file: entry.sessionFile,
        path: entry.path,
        opened_at: entry.at,
      };
    });
  },
});
