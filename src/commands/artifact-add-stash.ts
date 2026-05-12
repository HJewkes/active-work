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
  message: z.string(),
  created: z.string().optional(),
});

const ResultSchema = z.object({
  slug: z.string(),
  stash: z.object({
    repo: z.string(),
    message: z.string(),
    created: z.string(),
  }),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'artifact.add-stash',
  description: 'Append a stash entry to artifacts.yml.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      repo: { long: '--repo', description: 'Repo path', required: true },
      message: { long: '--message', description: 'Stash message', required: true },
      created: { long: '--created', description: 'Created date YYYY-MM-DD' },
    },
  },
  async run(args) {
    const artifactsPath = path.join(getInitiativeDir(args.slug), 'artifacts.yml');
    const created = args.created ?? today();
    return withFileLock(getLockPath(args.slug), async () => {
      const current = await readYaml(artifactsPath, ArtifactsSchema);
      const entry = { repo: args.repo, message: args.message, created };
      current.stashes.push(entry);
      await writeYaml(artifactsPath, current, ArtifactsSchema);
      return { slug: args.slug, stash: entry };
    });
  },
});
