import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BranchEntrySchema,
  StashEntrySchema,
  WorktreeEntrySchema,
} from '../schemas/artifacts.js';
import { NotFoundError } from '../errors.js';
import { defineCommand } from '../registry/index.js';
import { sweepInitiative } from '../wrap/sweep.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  cwd: z.string().min(1).optional(),
});

const DirtyTreeSchema = z.object({
  path: z.string(),
  repo: z.string(),
  /** Null when git could not read the tree — unknown, not clean. */
  files_changed: z.number().int().nonnegative().nullable(),
});

const UnpushedBranchSchema = z.object({
  path: z.string(),
  repo: z.string(),
  branch: z.string(),
  ahead: z.number().int().nonnegative(),
  no_upstream: z.boolean(),
});

const ResultSchema = z.object({
  slug: z.string(),
  repos: z.array(z.string()),
  unrecorded: z.object({
    worktrees: z.array(WorktreeEntrySchema),
    branches: z.array(BranchEntrySchema),
    stashes: z.array(StashEntrySchema),
  }),
  dirty: z.array(DirtyTreeSchema),
  unpushed: z.array(UnpushedBranchSchema),
  checklist: z.array(z.string()),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

/**
 * The categories a wrap has to answer. Git state is swept deterministically;
 * these are the four things only the session itself knows.
 */
const CHECKLIST = [
  'open loops: what this session leaves hanging, filed as wrap --next-steps, plus the prior loops it closed via --resolves',
  'durable notes: anything learned that outlives the session, filed with note.add',
  'tasks filed: work you named but did not do, filed with task.add',
  'worktree/artifact state: what each dirty or unpushed worktree is holding, and whether every branch and stash worth keeping is recorded',
];

export default defineCommand<Args, Result>({
  name: 'preflight',
  description:
    'Read-only pre-wrap sweep: the uncommitted trees, unpushed branches, and worktrees/branches/stashes present in git but missing from artifacts.yml, plus the checklist a wrap must answer. Writes nothing.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      cwd: {
        long: '--cwd',
        description:
          'Directory to include in the swept repo set (default: current directory).',
      },
    },
    usage: 'active-work preflight <slug> [--cwd <dir>]',
  },
  async run(args, ctx) {
    const briefPath = path.join(ctx.activeRoot, args.slug, 'brief.md');
    try {
      await fs.access(briefPath);
    } catch {
      throw new NotFoundError(`Initiative not found: ${args.slug}`);
    }
    const cwd = args.cwd ?? ctx.cwd ?? process.cwd();
    const sweep = await sweepInitiative(args.slug, ctx.activeRoot, cwd);
    return { slug: args.slug, ...sweep, checklist: CHECKLIST };
  },
});
