import { z } from 'zod';
import { NotFoundError } from '../errors.js';
import { defineCommand } from '../registry/index.js';
import { resolveSessionLocation } from '../sessions/resolve-session-location.js';

const ArgsSchema = z.object({
  session_id: z.string().min(1),
});

const ResultSchema = z.object({
  session_id: z.string(),
  cwd: z.string(),
  source: z.enum(['active-work', 'claude-projects']),
  slug: z.string().optional(),
});

export default defineCommand({
  name: 'resume',
  description:
    'Resolve the working directory a Claude session id belongs to, so `claude --resume` can be run from the right place.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['session_id'],
    usage: 'active-work resume <session_id>',
  },
  async run(args, ctx) {
    const resolved = await resolveSessionLocation(ctx.activeRoot, args.session_id);
    if (!resolved) {
      throw new NotFoundError(
        `No session found for '${args.session_id}' in active-work sessions or ~/.claude/projects.`,
      );
    }
    return { session_id: args.session_id, ...resolved };
  },
});
