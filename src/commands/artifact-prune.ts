import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { ArtifactsSchema, type BranchEntry, type WorktreeEntry } from '../schemas/artifacts.js';
import { getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { defineCommand } from '../registry/index.js';
import { getGitRunner, resolveLocalRepoPath } from '../utils/git-gh.js';
import { isWorktreePresent } from '../utils/git-worktrees.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  apply: z.boolean().optional(),
});

const PrunedSchema = z.object({
  kind: z.enum(['branch', 'worktree']),
  repo: z.string(),
  /** The branch name, or the worktree path. */
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
type Pruned = z.infer<typeof PrunedSchema>;
type Verdict = { keep: true } | { keep: false; reason: string };

async function branchExists(repoPath: string, name: string): Promise<boolean> {
  const git = getGitRunner();
  try {
    const res = await git('git', ['-C', repoPath, 'rev-parse', '--verify', `refs/heads/${name}`]);
    return res.code === 0;
  } catch {
    return false;
  }
}

async function classifyBranch(branch: BranchEntry): Promise<Verdict> {
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

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A worktree is only prunable when its repo is here to vouch for its absence.
 * artifacts.yml travels between machines; a repo that is not cloned on this
 * one says nothing about whether the worktree exists where it was registered.
 */
async function classifyWorktree(entry: WorktreeEntry): Promise<Verdict> {
  const repoPath = resolveLocalRepoPath(entry.repo);
  if (!repoPath || !(await dirExists(repoPath))) return { keep: true };
  if (await isWorktreePresent(entry.path)) return { keep: true };
  return { keep: false, reason: 'worktree path missing' };
}

async function partition<T>(
  entries: T[],
  classify: (entry: T) => Promise<Verdict>,
  describe: (entry: T) => Omit<Pruned, 'reason'>,
): Promise<{ keep: T[]; pruned: Pruned[] }> {
  const keep: T[] = [];
  const pruned: Pruned[] = [];
  for (const entry of entries) {
    const verdict = await classify(entry);
    if (verdict.keep) keep.push(entry);
    else pruned.push({ ...describe(entry), reason: verdict.reason });
  }
  return { keep, pruned };
}

const artifactPrune = defineCommand<Args, Result>({
  name: 'artifact.prune',
  description:
    'List (default) or remove (--apply) tracked branches and worktrees that no longer exist locally.',
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
      const branches = await partition(current.branches, classifyBranch, (b) => ({
        kind: 'branch',
        repo: b.repo,
        name: b.name,
      }));
      const worktrees = await partition(current.worktrees, classifyWorktree, (w) => ({
        kind: 'worktree',
        repo: w.repo,
        name: w.path,
      }));
      const pruned = [...branches.pruned, ...worktrees.pruned];
      if (apply && pruned.length > 0) {
        current.branches = branches.keep;
        current.worktrees = worktrees.keep;
        await writeYaml(artifactsPath, current, ArtifactsSchema);
      }
      return {
        slug: args.slug,
        applied: apply && pruned.length > 0,
        pruned,
        kept_count: branches.keep.length + worktrees.keep.length,
      };
    });
  },
});

export default artifactPrune;
