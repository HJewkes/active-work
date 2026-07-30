import { z } from 'zod';
import { getActiveRoot } from '../utils/paths.js';
import { NotFoundError } from '../errors.js';
import { defineCommand } from '../registry/index.js';
import { assembleBootstrap } from '../bootstrap/prompt.js';
import { resolveSlug, resolveSlugFromCwd } from './_open-helpers.js';

const ArgsSchema = z.object({
  slug: z.string().min(1).optional(),
  offline: z.boolean().optional(),
  // Directory to resolve the initiative from when no slug is given. Falls back
  // to the interactive-surface context cwd; unset for daemon/MCP callers.
  cwd: z.string().min(1).optional(),
  // Frame the prompt as ad-hoc work on the workstream rather than a
  // continuation of its handoff / top task.
  adhoc: z.boolean().optional(),
  // Skip the check for another session already live on this initiative.
  no_sibling_check: z.boolean().optional(),
});

type PromptArgs = z.infer<typeof ArgsSchema>;

const promptCommand = defineCommand<PromptArgs, string>({
  name: 'prompt',
  description:
    "Print the bootstrap prompt for an initiative — the same text `aw` feeds Claude at launch — without any side effects. Resolves the initiative from a slug or the caller's cwd. Use it to re-seed context in a running session.",
  args: ArgsSchema,
  result: z.string(),
  cli: {
    positional: ['slug'],
    options: {
      offline: {
        long: '--offline',
        description: 'Skip the live `gh`/`git` artifact lookup; render artifacts statically.',
      },
      cwd: {
        long: '--cwd',
        description:
          'Directory to resolve the initiative from when no slug is given (default: current directory).',
      },
      adhoc: {
        long: '--adhoc',
        description:
          'Frame the prompt as ad-hoc work on the workstream, awaiting the user’s task, not a continuation of the handoff / top task.',
      },
      no_sibling_check: {
        long: '--no-sibling-check',
        description:
          'Skip the check for another session already live on this initiative.',
      },
    },
    usage:
      'active-work prompt [slug] [--offline] [--cwd <dir>] [--adhoc] [--no-sibling-check]',
  },
  async run(args, ctx) {
    const activeRoot = ctx.activeRoot ?? getActiveRoot();

    let slug: string;
    if (args.slug) {
      slug = await resolveSlug(activeRoot, args.slug);
    } else {
      const cwd = args.cwd ?? ctx.cwd;
      const matched = cwd ? await resolveSlugFromCwd(activeRoot, cwd) : null;
      if (!matched) {
        throw new NotFoundError(
          'Could not determine an initiative from the current directory. ' +
            'Pass a slug: `active-work prompt <slug>`.',
        );
      }
      slug = matched.slug;
    }

    // Deliberately no archiveStaleTasks, and deliberately no `acquireLease`:
    // `prompt` is a read-only view. It *detects* siblings — re-seeding context
    // mid-session is exactly when you want to know another session is live —
    // but recording a lease would make every re-seed look like a new session
    // to the next bootstrap.
    const { prompt } = await assembleBootstrap({
      activeRoot,
      slug,
      includeLiveStatus: !args.offline,
      adhoc: args.adhoc,
      detectSiblings: !args.no_sibling_check && !args.offline,
      ...(process.env.AW_LEASE_ID ? { ownLeaseId: process.env.AW_LEASE_ID } : {}),
    });
    return prompt;
  },
});

export default promptCommand;
