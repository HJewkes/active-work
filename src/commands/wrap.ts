import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BriefFrontmatterSchema } from '../schemas/brief.js';
import { NoteKindSchema } from '../schemas/note.js';
import {
  NextStepSchema,
  SessionIdSchema,
  SessionResolveSchema,
  type NextStep,
  type SessionResolve,
} from '../schemas/session.js';
import { writeSessionFile } from '../sessions/session-file.js';
import {
  findDanglingResolves,
  type DanglingKind,
} from '../sessions/open-loops.js';
import { writeNoteFile } from '../notes/note-file.js';
import { loadTasks } from '../lint/load-tasks.js';
import {
  recordUnrecorded,
  sweepInitiative,
  type SweepResult,
} from '../wrap/sweep.js';
import { getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readRawFrontmatter, writeFrontmatter } from '../utils/gray-matter-io.js';
import { today } from '../utils/today.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const NextStepsSchema = z.array(NextStepSchema);
const ResolvesSchema = z.array(SessionResolveSchema);

const NoteInputSchema = z.object({
  kind: NoteKindSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
});
const NotesSchema = z.array(NoteInputSchema);
const TaskIdsSchema = z.array(z.string().min(1));

// MCP callers pass structured arrays; the CLI passes a JSON string through a
// single flag, since comma-splitting cannot express nested objects.
const nextStepsArg = z.union([z.string(), NextStepsSchema]);
const resolvesArg = z.union([z.string(), ResolvesSchema]);
const notesArg = z.union([z.string(), NotesSchema]);
const taskIdsArg = z.union([z.string(), TaskIdsSchema]);

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
    notes: notesArg.optional(),
    no_notes: z.boolean().optional(),
    tasks_filed: taskIdsArg.optional(),
    no_tasks: z.boolean().optional(),
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

const RejectedResolveSchema = z.object({
  ref: z.string(),
  kind: z.enum(['missing', 'not-prior', 'self']),
});

const FiledSchema = z.object({
  next_steps: z.number().int().nonnegative(),
  notes: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  worktrees: z.number().int().nonnegative(),
  branches: z.number().int().nonnegative(),
  stashes: z.number().int().nonnegative(),
});

const ResultSchema = z.object({
  path: z.string(),
  filename: z.string(),
  /** False only when some `resolves` ref closed nothing and must be re-filed. */
  ready_to_end: z.boolean(),
  filed: FiledSchema,
  // Not `resolves`: the count of refs passed says nothing about how many closed
  // a loop, and the caller acts on the difference.
  closed: z.object({ resolves_applied: z.number().int().nonnegative() }),
  resolves_rejected: z.array(RejectedResolveSchema),
  /** The date stamped into `brief.updated`. */
  updated: z.string(),
  /** Files this wrap touched, relative to the initiative directory. */
  files_updated: z.array(z.string()),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;
type RejectedResolve = z.infer<typeof RejectedResolveSchema>;
type NoteInput = z.infer<typeof NoteInputSchema>;
type Filed = z.infer<typeof FiledSchema>;

interface Ledger {
  next_steps: NextStep[];
  resolves: SessionResolve[];
}

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
 * Every category a session can leave behind needs an explicit answer, because
 * the alternative — silent omission — is the failure this command exists to
 * prevent. Each `empty` message deliberately does not name its own `--no-*`
 * escape hatch: an agent that reaches the error should be pointed at the work
 * of filing, not at the flag that silences the check. The flags are documented
 * in `--help` for the caller who genuinely has nothing to file.
 */
const GATES = {
  loops: {
    empty:
      'Refusing to wrap with an empty ledger. Pass --next-steps with the loops this ' +
      'session leaves open (anything a future session would need to pick up: ' +
      'unfinished work, open PRs, unanswered questions) and/or --resolves with the ' +
      'refs of prior loops it closed.',
    both: '--no-loops asserts an empty ledger; drop it to file --next-steps or --resolves.',
  },
  notes: {
    empty:
      'Refusing to wrap without an answer for durable notes. Pass --notes with what ' +
      'this session learned that no task would ever carry: process lessons, gotchas ' +
      'that cost time, decisions and why they were made, FYIs about the state of the ' +
      'worktree or the docs.',
    both: '--no-notes asserts this session produced no durable notes; drop it to file --notes.',
  },
  tasks: {
    empty:
      'Refusing to wrap without an answer for tasks. Pass --tasks-filed with the ids of ' +
      'the tasks created during this session — anything actionable that surfaced and ' +
      'must outlive the session must be a task before wrap returns.',
    both: '--no-tasks asserts no tasks were filed this session; drop it to file --tasks-filed.',
  },
} as const;

function requireAnswer(
  filled: boolean,
  none: boolean,
  messages: { empty: string; both: string },
): void {
  if (none) {
    if (filled) throw new ValidationError(messages.both);
    return;
  }
  if (!filled) throw new ValidationError(messages.empty);
}

function requireAnswers(
  args: Args,
  ledger: Ledger,
  notes: NoteInput[],
  taskIds: string[],
): void {
  const hasLoops = ledger.next_steps.length > 0 || ledger.resolves.length > 0;
  requireAnswer(hasLoops, args.no_loops ?? false, GATES.loops);
  requireAnswer(notes.length > 0, args.no_notes ?? false, GATES.notes);
  requireAnswer(taskIds.length > 0, args.no_tasks ?? false, GATES.tasks);
}

/**
 * A fabricated id is worse than no id: it reads as filed work that does not
 * exist. Only existence is checkable here, and the message says so rather than
 * implying the ids were confirmed to be this session's.
 */
async function verifyTaskIds(initiativeDir: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const known = new Set((await loadTasks(initiativeDir)).map((task) => task.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length === 0) return;
  throw new ValidationError(
    `--tasks-filed names ${unknown.length} id(s) with no task file in this initiative: ` +
      `${unknown.join(', ')}. File the task, then wrap. (Only existence is checked — ` +
      'that a task was created during this session is not verifiable.)',
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
  ledger: Ledger,
): Promise<{ path: string; filename: string; updated: string }> {
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
    return { ...session, updated };
  } catch (err) {
    await fs.rm(session.path, { force: true });
    throw err;
  }
}

/** Note paths written, so a later failure can unwind them. */
async function fileNotes(
  initiativeDir: string,
  notes: NoteInput[],
  created: string,
): Promise<string[]> {
  const written: string[] = [];
  for (const note of notes) {
    const result = await writeNoteFile(
      initiativeDir,
      {
        kind: note.kind,
        title: note.title,
        created,
        ...(note.tags === undefined ? {} : { tags: note.tags }),
      },
      note.body,
    );
    written.push(result.path);
  }
  return written;
}

const NOTHING_RECORDED = { worktrees: 0, branches: 0, stashes: 0 };

/**
 * Dirty trees and unpushed branches cannot be recorded anywhere — only the tree
 * itself knows. They are surfaced as warnings rather than gating the wrap.
 */
function warnUnrecordable(sweep: SweepResult, warnings: string[]): void {
  for (const tree of sweep.dirty) {
    warnings.push(
      `Uncommitted work in ${tree.path} (${tree.repo}): ${tree.files_changed} file(s) changed.`,
    );
  }
  for (const branch of sweep.unpushed) {
    warnings.push(
      `${branch.branch} in ${branch.path} (${branch.repo}) is ${branch.ahead} commit(s) ahead of its remote.`,
    );
  }
}

/**
 * Record whatever git state the initiative has not written down. The operator
 * chose recording over refusing: a wrap never fails because a worktree was
 * untracked, only because writing the record itself failed.
 *
 * MUST run inside the initiative lock — `recordUnrecorded` takes none of its own.
 */
async function sweepAndRecord(
  slug: string,
  activeRoot: string,
  warnings: string[],
): Promise<typeof NOTHING_RECORDED> {
  let sweep: SweepResult;
  try {
    sweep = await sweepInitiative(slug, activeRoot, process.cwd());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnings.push(`Could not sweep git state for unrecorded artifacts: ${reason}`);
    return NOTHING_RECORDED;
  }
  warnUnrecordable(sweep, warnings);
  return recordUnrecorded(slug, activeRoot, sweep.unrecorded);
}

/**
 * Which `resolves` entries of the session just written closed nothing, and why.
 *
 * Derived by re-running the canonical derivation over the initiative rather
 * than re-implementing the rules: a second classifier that disagreed with
 * `deriveOpenLoops` would report a close that bootstrap still shows as open.
 */
async function rejectedResolves(
  initiativeDir: string,
  filename: string,
): Promise<RejectedResolve[]> {
  const stem = filename.replace(/\.md$/, '');
  const dangling = await findDanglingResolves(initiativeDir);
  return dangling
    .filter((entry) => entry.sessionFile === stem)
    .map(({ ref, kind }) => ({ ref, kind }));
}

const REMEDY: Record<DanglingKind, string> = {
  missing:
    'no loop carries that ref — check the session-file stem and the next_steps id',
  'not-prior':
    'the loop was opened by a session that did not end strictly before this one — re-file the resolve from a later session',
  self: 'a session cannot close a loop it opened — carry it as a next_step instead',
};

/**
 * The session is on disk by the time this runs and the message says so: an
 * agent that typo'd one ref should re-file that ref, not re-run the wrap and
 * duplicate the narrative.
 *
 * This rides `ctx.warnings` rather than a thrown error. Throwing discarded the
 * receipt — the one case `ready_to_end: false` and `resolves_rejected[]` exist
 * to describe was also the one case no caller could read them, leaving the
 * machine-readable half of the contract available only as prose to parse.
 */
function rejectionReport(
  sessionPath: string,
  rejected: RejectedResolve[],
  total: number,
): string {
  const lines = rejected.map((r) => `  - ${r.ref} (${r.kind}): ${REMEDY[r.kind]}`);
  return (
    `Session written to ${sessionPath}, but ${rejected.length} of ${total} ` +
    `--resolves entries closed no loop:\n${lines.join('\n')}\n` +
    'The session file and brief.updated are committed, so ready_to_end is false: ' +
    're-file only the rejected refs from a later session.'
  );
}

function filesUpdated(
  initiativeDir: string,
  notePaths: string[],
  recorded: Filed,
): string[] {
  const files = ['brief.md'];
  if (recorded.worktrees + recorded.branches + recorded.stashes > 0) {
    files.push('artifacts.yml');
  }
  return files.concat(notePaths.map((p) => path.relative(initiativeDir, p)));
}

export default defineCommand<Args, Result>({
  name: 'wrap',
  description:
    'The last thing a session does. Treat it as the moment the process exits: everything ' +
    'not persisted before wrap returns is lost, so file it first and wrap last. Every ' +
    'category the session can leave behind needs an explicit answer, and omitting one is ' +
    'an error rather than a default — open loops (--next-steps / --resolves, or --no-loops), ' +
    'durable notes (--notes or --no-notes), and tasks created this session (--tasks-filed or ' +
    '--no-tasks). Writes the session file and its ledger, files the notes under ' +
    'sources/notes/, records any worktrees, branches and stashes the initiative had not ' +
    "written down, stamps the brief's updated date, and returns a receipt of what was filed.",
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
      notes: {
        long: '--notes',
        description:
          'JSON array of durable notes to file under sources/notes/: [{"kind":"process|gotcha|fyi|decision","title","body","tags"?}]',
      },
      no_notes: {
        long: '--no-notes',
        description:
          'Assert that this session produced no durable knowledge worth keeping. Mutually exclusive with --notes.',
      },
      tasks_filed: {
        long: '--tasks-filed',
        description:
          'JSON array of task ids created during this session, e.g. ["AW-66","AW-67"]. Each must already exist in the initiative.',
      },
      no_tasks: {
        long: '--no-tasks',
        description:
          'Assert that this session filed no tasks. Mutually exclusive with --tasks-filed.',
      },
    },
    usage:
      'active-work wrap <slug> --session-id <id> --started <iso> --ended <iso> [--track canonical|sidecar|adhoc] (--body <text> | --body-file <path>) (--next-steps <json> | --resolves <json> | --no-loops) (--notes <json> | --no-notes) (--tasks-filed <json> | --no-tasks)',
  },
  async run(args, ctx) {
    const initiativeDir = path.join(ctx.activeRoot, args.slug);
    const briefPath = path.join(initiativeDir, 'brief.md');
    try {
      await fs.access(briefPath);
    } catch {
      throw new NotFoundError(`Initiative not found: ${args.slug}`);
    }

    const ledger: Ledger = {
      next_steps: parseLedger(args.next_steps, NextStepsSchema, 'next-steps'),
      resolves: parseLedger(args.resolves, ResolvesSchema, 'resolves'),
    };
    const notes = parseLedger(args.notes, NotesSchema, 'notes');
    const taskIds = parseLedger(args.tasks_filed, TaskIdsSchema, 'tasks-filed');
    requireAnswers(args, ledger, notes, taskIds);
    const body = args.body ?? (await fs.readFile(args.body_file!, 'utf8'));

    return withFileLock(getLockPath(args.slug), async () => {
      await verifyTaskIds(initiativeDir, taskIds);
      const written = await writeWrap(args, briefPath, body, ledger);
      let notePaths: string[] = [];
      let recorded = NOTHING_RECORDED;
      try {
        notePaths = await fileNotes(initiativeDir, notes, written.updated);
        recorded = await sweepAndRecord(args.slug, ctx.activeRoot, ctx.warnings);
      } catch (err) {
        await Promise.all(
          [...notePaths, written.path].map((p) => fs.rm(p, { force: true })),
        );
        throw err;
      }

      const total = ledger.resolves.length;
      const rejected = await rejectedResolves(initiativeDir, written.filename);
      const filed: Filed = {
        next_steps: ledger.next_steps.length,
        notes: notePaths.length,
        tasks: taskIds.length,
        ...recorded,
      };
      const result: Result = {
        path: written.path,
        filename: written.filename,
        ready_to_end: rejected.length === 0,
        filed,
        closed: { resolves_applied: total - rejected.length },
        resolves_rejected: rejected,
        updated: written.updated,
        files_updated: filesUpdated(initiativeDir, notePaths, filed),
      };
      if (rejected.length > 0) {
        ctx.warnings.push(rejectionReport(written.path, rejected, total));
      }
      return result;
    });
  },
});
