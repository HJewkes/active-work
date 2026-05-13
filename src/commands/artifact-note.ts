import path from 'node:path';
import { z } from 'zod';
import { ArtifactsSchema } from '../schemas/artifacts.js';
import { getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { UsageError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  repo: z.string().min(1),
  name: z.string().min(1),
  note: z.string().min(1),
});

const ResultSchema = z.object({
  slug: z.string(),
  branch: z.object({
    repo: z.string(),
    name: z.string(),
    note: z.string(),
  }),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'artifact.note',
  description: 'Set or update the free-form note on a tracked branch.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      repo: { long: '--repo', description: 'Repo path or org/repo', required: true },
      name: { long: '--name', description: 'Branch name', required: true },
      note: { long: '--note', description: 'Note text', required: true },
    },
  },
  async run(args) {
    const artifactsPath = path.join(getInitiativeDir(args.slug), 'artifacts.yml');
    return withFileLock(getLockPath(args.slug), async () => {
      const current = await readYaml(artifactsPath, ArtifactsSchema);
      const idx = current.branches.findIndex(
        (b) => b.repo === args.repo && b.name === args.name,
      );
      if (idx < 0) {
        throw new UsageError(
          `No tracked branch '${args.name}' in repo '${args.repo}'. Add it first via 'artifact add-branch'.`,
        );
      }
      const updated = { repo: args.repo, name: args.name, note: args.note };
      current.branches[idx] = updated;
      await writeYaml(artifactsPath, current, ArtifactsSchema);
      return { slug: args.slug, branch: updated };
    });
  },
});
