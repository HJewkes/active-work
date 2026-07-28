import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BriefFrontmatterSchema } from '../schemas/brief.js';
import {
  NextStepSchema,
  SessionIdSchema,
  SessionResolveSchema,
  type NextStep,
  type SessionResolve,
} from '../schemas/session.js';
import { writeSessionFile } from '../sessions/session-file.js';
import { getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readRawFrontmatter, writeFrontmatter } from '../utils/gray-matter-io.js';
import { today } from '../utils/today.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const NextStepsSchema = z.array(NextStepSchema);
const ResolvesSchema = z.array(SessionResolveSchema);

// MCP callers pass structured arrays; the CLI passes a JSON string through a
// single flag, since comma-splitting cannot express nested objects.
const nextStepsArg = z.union([z.string(), NextStepsSchema]);
const resolvesArg = z.union([z.string(), ResolvesSchema]);

const ArgsSchema = z
  .object({
    slug: z.string().min(1),
    session_id: SessionIdSchema,
    started: z.string().min(1),
    ended: z.string().min(1),
    track: z.enum(['canonical', 'sidecar', 'adhoc']).default('canonical'),
    body: z.string().optional(),
    body_file: z.string().optional(),
    next_steps: nextStepsArg.optional(),
    resolves: resolvesArg.optional(),
    no_loops: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const hasBody = value.body !== undefined;
    const hasFile = value.body_file !== undefined;
    if (!hasBody && !hasFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'Exactly one of --body or --body-file is required',
      });
    }
    if (hasBody && hasFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: '--body and --body-file are mutually exclusive',
      });
    }
  });

const ResultSchema = z.object({
  path: z.string(),
  filename: z.string(),
  next_steps: z.number().int().nonnegative(),
  resolves: z.number().int().nonnegative(),
  updated: z.string(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

function parseLedger<T>(
  raw: string | T[] | undefined,
  schema: z.ZodType<T[]>,
  field: string,
): T[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return schema.parse(raw);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ValidationError(`--${field} must be a JSON array`);
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ValidationError(`Invalid --${field}: ${result.error.message}`);
  }
  return result.data;
}

/**
 * The whole design rests on loops being filed at wrap. The message deliberately
 * does not name `--no-loops`: an agent that reaches this error should be pointed
 * at the work of filing loops, not at the flag that silences the check. The flag
 * is documented in `--help` for the caller who genuinely has nothing hanging.
 */
function requireLedger(
  ledger: { next_steps: NextStep[]; resolves: SessionResolve[] },
  noLoops: boolean,
): void {
  const hasEntries = ledger.next_steps.length > 0 || ledger.resolves.length > 0;
  if (noLoops) {
    if (hasEntries) {
      throw new ValidationError(
        '--no-loops asserts an empty ledger; drop it to file --next-steps or --resolves.',
      );
    }
    return;
  }
  if (hasEntries) return;
  throw new ValidationError(
    'Refusing to wrap with an empty ledger. Pass --next-steps with the loops this ' +
      'session leaves open (anything a future session would need to pick up: ' +
      'unfinished work, open PRs, unanswered questions) and/or --resolves with the ' +
      'refs of prior loops it closed.',
  );
}

async function stampBriefUpdated(briefPath: string): Promise<string> {
  const updated = today();
  const { frontmatter, body } = await readRawFrontmatter(briefPath);
  frontmatter.updated = updated;
  await writeFrontmatter(briefPath, frontmatter, body, BriefFrontmatterSchema);
  return updated;
}

/**
 * Write the session file, then bump `brief.updated`. If the brief write fails
 * the session file is removed again, so a wrap is all-or-nothing rather than
 * merely discouraged from being partial.
 */
async function writeWrap(
  args: Args,
  briefPath: string,
  body: string,
  ledger: { next_steps: NextStep[]; resolves: SessionResolve[] },
): Promise<Result> {
  const session = await writeSessionFile({
    slug: args.slug,
    session_id: args.session_id,
    started: args.started,
    ended: args.ended,
    track: args.track,
    body,
    next_steps: ledger.next_steps,
    resolves: ledger.resolves,
    ...(args.no_loops === true ? { no_loops: true as const } : {}),
  });
  try {
    const updated = await stampBriefUpdated(briefPath);
    return {
      ...session,
      next_steps: ledger.next_steps.length,
      resolves: ledger.resolves.length,
      updated,
    };
  } catch (err) {
    await fs.rm(session.path, { force: true });
    throw err;
  }
}

export default defineCommand<Args, Result>({
  name: 'wrap',
  description:
    "Close out a session in one atomic step: write the session file with its open-loop ledger (next_steps / resolves) and stamp the brief's updated date. Refuses an empty ledger unless --no-loops is passed.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      session_id: {
        long: '--session-id',
        description: 'Claude session identifier',
        required: true,
      },
      started: {
        long: '--started',
        description: 'ISO 8601 session start timestamp',
        required: true,
      },
      ended: {
        long: '--ended',
        description: 'ISO 8601 session end timestamp',
        required: true,
      },
      track: {
        long: '--track',
        description:
          "'canonical' (mainline thread) | 'sidecar' (folded/derived) | 'adhoc' (parallel ad-hoc work) (default: canonical)",
      },
      body: {
        long: '--body',
        description: 'Raw markdown body (session narrative)',
      },
      body_file: {
        long: '--body-file',
        description: 'Path to a file containing the markdown body',
      },
      next_steps: {
        long: '--next-steps',
        description:
          'JSON array of loops this session opens: [{"id","text","kind":"task|pr|prose","ref"?}]',
      },
      resolves: {
        long: '--resolves',
        description:
          'JSON array of loops this session closes: [{"ref":"<session-file-stem>#<id>","outcome":"done|abandoned","note"?}]',
      },
      no_loops: {
        long: '--no-loops',
        description:
          'Assert that this session leaves nothing hanging. Records no_loops: true so a deliberate empty ledger is distinguishable from an unfiled one. Mutually exclusive with --next-steps / --resolves.',
      },
    },
    usage:
      'active-work wrap <slug> --session-id <id> --started <iso> --ended <iso> [--track canonical|sidecar|adhoc] (--body <text> | --body-file <path>) (--next-steps <json> | --resolves <json> | --no-loops)',
  },
  async run(args, ctx) {
    const briefPath = path.join(ctx.activeRoot, args.slug, 'brief.md');
    try {
      await fs.access(briefPath);
    } catch {
      throw new NotFoundError(`Initiative not found: ${args.slug}`);
    }

    const ledger = {
      next_steps: parseLedger(args.next_steps, NextStepsSchema, 'next-steps'),
      resolves: parseLedger(args.resolves, ResolvesSchema, 'resolves'),
    };
    requireLedger(ledger, args.no_loops ?? false);
    const body = args.body ?? (await fs.readFile(args.body_file!, 'utf8'));

    return withFileLock(getLockPath(args.slug), () =>
      writeWrap(args, briefPath, body, ledger),
    );
  },
});
