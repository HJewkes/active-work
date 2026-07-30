import { z } from 'zod';
import { listSources } from '../sources/list.js';
import { lintSources } from '../lint/sources.js';
import { getInitiativeDir } from '../utils/paths.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  type: z.enum(['pr', 'deepdive', 'session', 'pointer']).optional(),
});

const SourceEntrySchema = z.object({
  filename: z.string(),
  path: z.string(),
  type: z.enum(['pr', 'deepdive', 'session', 'pointer']),
  title: z.string(),
});

const ResultSchema = z.object({
  sources: z.array(SourceEntrySchema),
  // Drift between the directory and brief.md's hand-written references. Empty
  // when the brief keeps no reference list at all.
  drift: z.array(z.string()),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'source.list',
  description:
    "List an initiative's sources, derived by reading sources/*.md — never a stored index.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      type: {
        long: '--type',
        description: 'Only sources of this type: pr | deepdive | session | pointer',
      },
    },
    usage: 'active-work source list <slug> [--type pr|deepdive|session|pointer]',
  },
  async run(args) {
    const initiativeDir = getInitiativeDir(args.slug);
    const sources = await listSources(initiativeDir);
    const selected = args.type ? sources.filter((entry) => entry.type === args.type) : sources;
    const findings = await lintSources(args.slug, initiativeDir);
    return {
      sources: selected,
      drift: findings.map((finding) => finding.message),
    };
  },
});
