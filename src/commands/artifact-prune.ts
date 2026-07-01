import path from 'node:path';
import { z } from 'zod';
import { ArtifactsSchema, type BranchEntry } from '../schemas/artifacts.js';
import { getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { defineCommand } from '../registry/index.js';
import { getGitRunner, resolveLocalRepoPath } from '../utils/git-gh.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  apply: z.boolean().optional(),
});

const PrunedSchema = z.object({
  repo: z.string(),
  name: z.string(),
  reason: z.string(),
});

const ResultSchema = z.object({
  slug: z.string(),
  applied: z.boolean(),
  pruned: z.array(PrunedSchema),
  kept_count: z.number().int().nonnegative(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

async function branchExists(repoPath: string, name: string): Promise<boolean> {
  const git = getGitRunner();
  try {
    const res = await git('git', [
      '-C',
      repoPath,
      'rev-parse',
      '--verify',
      `refs/heads/${name}`,
    ]);
    return res.code === 0;
  } catch {
    return false;
  }
}

async function classifyBranch(
  branch: BranchEntry,
): Promise<{ keep: true } | { keep: false; reason: string }> {
  const repoPath = resolveLocalRepoPath(branch.repo);
  if (!repoPath) {
    // `org/repo` style — we have no local clone to verify against, so
    // keep it: prune should never delete a tracked branch we can't see.
    return { keep: true };
  }
  const present = await branchExists(repoPath, branch.name);
  if (present) return { keep: true };
  return { keep: false, reason: 'branch missing in local repo' };
}

const artifactPrune = defineCommand<Args, Result>({
  name: 'artifact.prune',
  description:
    'List (default) or remove (--apply) tracked branches that no longer exist locally.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      apply: {
        long: '--apply',
        description: 'Write the pruned artifacts.yml. Without this, dry-run only.',
      },
    },
  },
  async run(args) {
    const artifactsPath = path.join(getInitiativeDir(args.slug), 'artifacts.yml');
    const apply = args.apply ?? false;
    return withFileLock(getLockPath(args.slug), async () => {
      const current = await readYaml(artifactsPath, ArtifactsSchema);
      const keep: BranchEntry[] = [];
      const pruned: Array<{ repo: string; name: string; reason: string }> = [];
      for (const branch of current.branches) {
        const verdict = await classifyBranch(branch);
        if (verdict.keep) {
          keep.push(branch);
        } else {
          pruned.push({ repo: branch.repo, name: branch.name, reason: verdict.reason });
        }
      }
      if (apply && pruned.length > 0) {
        current.branches = keep;
        await writeYaml(artifactsPath, current, ArtifactsSchema);
      }
      return {
        slug: args.slug,
        applied: apply && pruned.length > 0,
        pruned,
        kept_count: keep.length,
      };
    });
  },
});

export default artifactPrune;
