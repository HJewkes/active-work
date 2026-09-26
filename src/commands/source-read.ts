import { z } from 'zod';
import { readInitiativeFile } from '../sources/read.js';
import { UsageError } from '../errors.js';
import { getActiveRoot } from '../utils/paths.js';
import { validateSlug } from '../utils/slug.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  path: z.string().min(1),
});

const ResultSchema = z.object({
  path: z.string(),
  content: z.string(),
  // True when the file exceeded the read cap and `content` holds only its head.
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'source.read',
  description:
    'Read the full text of one file inside an initiative. Accepts a path as `search` returns it, relative to the initiative, or absolute; refuses anything that resolves outside the initiative directory.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug', 'path'],
    usage: 'active-work source read <slug> <path>',
  },
  async run(args) {
    const slugCheck = validateSlug(args.slug);
    if (!slugCheck.ok) throw new UsageError(`Invalid slug '${args.slug}': ${slugCheck.error}`);
    return readInitiativeFile(getActiveRoot(), args.slug, args.path);
  },
});
