import path from 'node:path';
import { z } from 'zod';
import { ArtifactsSchema } from '../schemas/artifacts.js';
import { getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml } from '../utils/yaml-io.js';
import { defineCommand } from '../registry/index.js';
import {
  getGhRunner,
  getGitRunner,
  resolveLocalRepoPath,
  resolveOrgRepo,
} from '../utils/git-gh.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
});

const PrInfoSchema = z.object({
  number: z.number().int(),
  state: z.string(),
  title: z.string(),
  url: z.string(),
  checks: z.string().optional(),
});

const BranchStatusSchema = z.object({
  repo: z.string(),
  name: z.string(),
  note: z.string().optional(),
  present: z.boolean(),
  last_commit_iso: z.string().nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  pr: PrInfoSchema.nullable(),
  error: z.string().optional(),
});

const ResultSchema = z.object({
  slug: z.string(),
  branches: z.array(BranchStatusSchema),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;
type BranchStatus = z.infer<typeof BranchStatusSchema>;
type PrInfo = z.infer<typeof PrInfoSchema>;

interface BranchInput {
  repo: string;
  name: string;
  note?: string;
}

const MAX_CONCURRENCY = 8;

export { setGitRunner, setGhRunner, resetRunners } from '../utils/git-gh.js';

/**
 * Bounded-parallel map. Runs `worker(item)` for each item in `items`,
 * with at most `concurrency` in-flight at any time. Preserves order.
 */
async function mapConcurrent<I, O>(
  items: I[],
  concurrency: number,
  worker: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const results: O[] = new Array(items.length);
  let cursor = 0;
  async function pump(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, () => pump());
  await Promise.all(lanes);
  return results;
}

async function checkBranchPresent(repoPath: string, name: string): Promise<boolean> {
  const git = getGitRunner();
  try {
    const res = await git('git', ['-C', repoPath, 'rev-parse', '--verify', `refs/heads/${name}`]);
    return res.code === 0;
  } catch {
    return false;
  }
}

async function lastCommitIso(repoPath: string, name: string): Promise<string | null> {
  const git = getGitRunner();
  try {
    const res = await git('git', ['-C', repoPath, 'log', '-1', '--format=%cI', name]);
    if (res.code !== 0) return null;
    const stamp = res.stdout.trim();
    return stamp.length > 0 ? stamp : null;
  } catch {
    return null;
  }
}

async function detectDefaultBase(repoPath: string): Promise<string | null> {
  const git = getGitRunner();
  for (const candidate of ['main', 'master']) {
    try {
      const res = await git('git', [
        '-C',
        repoPath,
        'rev-parse',
        '--verify',
        `refs/remotes/origin/${candidate}`,
      ]);
      if (res.code === 0) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

async function aheadBehind(
  repoPath: string,
  name: string,
): Promise<{ ahead: number | null; behind: number | null }> {
  const base = await detectDefaultBase(repoPath);
  if (!base) return { ahead: null, behind: null };
  const git = getGitRunner();
  try {
    const res = await git('git', [
      '-C',
      repoPath,
      'rev-list',
      '--left-right',
      '--count',
      `origin/${base}...${name}`,
    ]);
    if (res.code !== 0) return { ahead: null, behind: null };
    // Output is "<behind>\t<ahead>" (left is base, right is branch).
    const parts = res.stdout.trim().split(/\s+/);
    if (parts.length !== 2) return { ahead: null, behind: null };
    const behind = Number(parts[0]);
    const ahead = Number(parts[1]);
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
      return { ahead: null, behind: null };
    }
    return { ahead, behind };
  } catch {
    return { ahead: null, behind: null };
  }
}

async function fetchPrInfo(orgRepo: string, name: string): Promise<PrInfo | null> {
  const gh = getGhRunner();
  try {
    const res = await gh('gh', [
      'pr',
      'list',
      '--head',
      name,
      '--repo',
      orgRepo,
      '--json',
      'number,state,title,url,statusCheckRollup',
      '--limit',
      '1',
    ]);
    if (res.code !== 0) return null;
    const parsed = JSON.parse(res.stdout) as Array<{
      number?: number;
      state?: string;
      title?: string;
      url?: string;
      statusCheckRollup?: Array<{ conclusion?: string; state?: string }>;
    }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const first = parsed[0]!;
    if (
      typeof first.number !== 'number' ||
      typeof first.state !== 'string' ||
      typeof first.title !== 'string' ||
      typeof first.url !== 'string'
    ) {
      return null;
    }
    const checks = summarizeChecks(first.statusCheckRollup ?? []);
    return {
      number: first.number,
      state: first.state,
      title: first.title,
      url: first.url,
      ...(checks ? { checks } : {}),
    };
  } catch {
    return null;
  }
}

function summarizeChecks(
  rollup: Array<{ conclusion?: string; state?: string }>,
): string | undefined {
  if (rollup.length === 0) return undefined;
  let pass = 0;
  let fail = 0;
  let pending = 0;
  for (const entry of rollup) {
    const tag = (entry.conclusion ?? entry.state ?? '').toUpperCase();
    if (tag === 'SUCCESS') pass++;
    else if (tag === 'FAILURE' || tag === 'CANCELLED' || tag === 'TIMED_OUT') fail++;
    else pending++;
  }
  if (fail > 0) return `fail (${fail}/${rollup.length})`;
  if (pending > 0) return `pending (${pending}/${rollup.length})`;
  return `pass (${pass}/${rollup.length})`;
}

async function statusForBranch(branch: BranchInput): Promise<BranchStatus> {
  const out: BranchStatus = {
    repo: branch.repo,
    name: branch.name,
    ...(branch.note ? { note: branch.note } : {}),
    present: false,
    last_commit_iso: null,
    ahead: null,
    behind: null,
    pr: null,
  };

  const repoPath = resolveLocalRepoPath(branch.repo);

  try {
    if (repoPath) {
      out.present = await checkBranchPresent(repoPath, branch.name);
      if (out.present) {
        out.last_commit_iso = await lastCommitIso(repoPath, branch.name);
        const { ahead, behind } = await aheadBehind(repoPath, branch.name);
        out.ahead = ahead;
        out.behind = behind;
      }
    }

    const orgRepo = await resolveOrgRepo(branch.repo);
    if (orgRepo) {
      out.pr = await fetchPrInfo(orgRepo, branch.name);
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }

  return out;
}

const artifactStatus = defineCommand<Args, Result>({
  name: 'artifact.status',
  description:
    'Pull live PR and branch state for the initiative via `git` + `gh`. Read-only.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
  },
  async run(args) {
    const artifactsPath = path.join(getInitiativeDir(args.slug), 'artifacts.yml');
    const current = await withFileLock(getLockPath(args.slug), () =>
      readYaml(artifactsPath, ArtifactsSchema),
    );
    const branches = await mapConcurrent(
      current.branches,
      MAX_CONCURRENCY,
      statusForBranch,
    );
    return { slug: args.slug, branches };
  },
});

export default artifactStatus;
