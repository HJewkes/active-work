import path from 'node:path';
import { z } from 'zod';
import { ArtifactsSchema } from '../schemas/artifacts.js';
import { getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { today } from '../utils/today.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  repo: z.string().min(1),
  name: z.string().min(1),
  last_commit: z.string().optional(),
});

const ResultSchema = z.object({
  slug: z.string(),
  branch: z.object({
    repo: z.string(),
    name: z.string(),
    last_commit: z.string(),
  }),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'artifact.add-branch',
  description: 'Append or upsert a branch entry in artifacts.yml.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      repo: { long: '--repo', description: 'Repo path or org/repo', required: true },
      name: { long: '--name', description: 'Branch name', required: true },
      last_commit: { long: '--last-commit', description: 'Last commit date YYYY-MM-DD' },
    },
  },
  async run(args) {
    const artifactsPath = path.join(getInitiativeDir(args.slug), 'artifacts.yml');
    const last_commit = args.last_commit ?? today();
    return withFileLock(getLockPath(args.slug), async () => {
      const current = await readYaml(artifactsPath, ArtifactsSchema);
      const entry = { repo: args.repo, name: args.name, last_commit };
      const idx = current.branches.findIndex(
        (b) => b.repo === args.repo && b.name === args.name,
      );
      if (idx >= 0) {
        current.branches[idx] = entry;
      } else {
        current.branches.push(entry);
      }
      await writeYaml(artifactsPath, current, ArtifactsSchema);
      return { slug: args.slug, branch: entry };
    });
  },
});
