import path from 'node:path';
import { z } from 'zod';
import { ArtifactsSchema } from '../schemas/artifacts.js';
import { getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { nowIso } from '../utils/today.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  number: z.number().int().positive(),
  repo: z.string().min(1),
  title: z.string(),
  status: z.enum(['open', 'merged', 'closed']).optional(),
});

const ResultSchema = z.object({
  slug: z.string(),
  pr: z.object({
    number: z.number(),
    repo: z.string(),
    title: z.string(),
    status: z.enum(['open', 'merged', 'closed']),
  }),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'artifact.add-pr',
  description: 'Append or upsert a PR entry in artifacts.yml.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      number: { long: '--number', description: 'PR number', required: true },
      repo: { long: '--repo', description: 'org/repo', required: true },
      title: { long: '--title', description: 'PR title', required: true },
      status: { long: '--status', description: 'open | merged | closed' },
    },
  },
  async run(args) {
    const artifactsPath = path.join(getInitiativeDir(args.slug), 'artifacts.yml');
    const status = args.status ?? 'open';
    return withFileLock(getLockPath(args.slug), async () => {
      const current = await readYaml(artifactsPath, ArtifactsSchema);
      const entry = {
        number: args.number,
        repo: args.repo,
        title: args.title,
        status,
        last_checked: nowIso(),
      };
      const idx = current.prs.findIndex(
        (p) => p.repo === args.repo && p.number === args.number,
      );
      if (idx >= 0) {
        current.prs[idx] = entry;
      } else {
        current.prs.push(entry);
      }
      await writeYaml(artifactsPath, current, ArtifactsSchema);
      return {
        slug: args.slug,
        pr: {
          number: entry.number,
          repo: entry.repo,
          title: entry.title,
          status: entry.status,
        },
      };
    });
  },
});
