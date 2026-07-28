import { getGitRunner } from './git-gh.js';

/**
 * Live git worktree reads for `artifact.status`.
 *
 * Nothing here is persisted: `artifacts.yml` records only worktree identity
 * and purpose (see `src/schemas/artifacts.ts`), and everything volatile —
 * dirty flag, files changed, ahead/behind — is pulled at read time.
 *
 * Like `git-gh.ts`, every helper is failure-tolerant: a repo that has been
 * moved or deleted yields empty/null data rather than aborting the sweep.
 * All git calls go through `getGitRunner()` so tests can inject a fake.
 */

export interface DiscoveredWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
}

export interface WorktreeState {
  /**
   * False when the path is gone or is no longer a git worktree. Without this a
   * deleted worktree reads exactly like a clean one — no dirt, no files, no
   * upstream — and silently drops out of the operator's attention.
   */
  present: boolean;
  dirty: boolean;
  files_changed: number;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface StashRef {
  label: string;
  sha: string;
}

const NO_UPSTREAM = { ahead: null, behind: null } as const;

function shortBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

function emptyWorktree(path: string): DiscoveredWorktree {
  return { path, head: null, branch: null, detached: false, bare: false };
}

/**
 * Parse `git worktree list --porcelain` output. Records are separated by
 * blank lines and always open with a `worktree <path>` line. Exported for
 * testing.
 */
export function parseWorktreePorcelain(stdout: string): DiscoveredWorktree[] {
  const out: DiscoveredWorktree[] = [];
  let current: DiscoveredWorktree | null = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') {
      current = emptyWorktree(value);
      out.push(current);
    } else if (!current) {
      continue;
    } else if (key === 'HEAD') {
      current.head = value || null;
    } else if (key === 'branch') {
      current.branch = shortBranch(value);
    } else if (key === 'detached') {
      current.detached = true;
    } else if (key === 'bare') {
      current.bare = true;
    }
  }
  return out;
}

/** Enumerate the worktrees attached to `repoPath`. Empty on failure. */
export async function discoverWorktrees(repoPath: string): Promise<DiscoveredWorktree[]> {
  const git = getGitRunner();
  try {
    const res = await git('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
    if (res.code !== 0) return [];
    return parseWorktreePorcelain(res.stdout);
  } catch {
    return [];
  }
}

async function readDirty(
  worktreePath: string,
): Promise<{ dirty: boolean; files_changed: number }> {
  const git = getGitRunner();
  try {
    const res = await git('git', ['-C', worktreePath, 'status', '--porcelain']);
    if (res.code !== 0) return { dirty: false, files_changed: 0 };
    const lines = res.stdout.split('\n').filter((line) => line.trim().length > 0);
    return { dirty: lines.length > 0, files_changed: lines.length };
  } catch {
    return { dirty: false, files_changed: 0 };
  }
}

/** Current branch of a worktree, or null when HEAD is detached. */
async function readBranch(worktreePath: string): Promise<string | null> {
  const git = getGitRunner();
  try {
    const res = await git('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']);
    if (res.code !== 0) return null;
    const name = res.stdout.trim();
    return name && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

async function countRevs(worktreePath: string, range: string): Promise<number | null> {
  const git = getGitRunner();
  try {
    const res = await git('git', ['-C', worktreePath, 'rev-list', '--count', range]);
    if (res.code !== 0) return null;
    const count = Number(res.stdout.trim());
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

/** Ahead/behind versus the tracking branch; nulls when there is no upstream. */
async function readAheadBehind(
  worktreePath: string,
): Promise<{ ahead: number | null; behind: number | null }> {
  const ahead = await countRevs(worktreePath, '@{u}..HEAD');
  if (ahead === null) return { ...NO_UPSTREAM };
  const behind = await countRevs(worktreePath, 'HEAD..@{u}');
  return { ahead, behind };
}

/** Whether `worktreePath` still resolves inside a git working tree. */
async function isPresent(worktreePath: string): Promise<boolean> {
  const git = getGitRunner();
  try {
    const res = await git('git', [
      '-C',
      worktreePath,
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    return res.code === 0 && res.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

const ABSENT: WorktreeState = {
  present: false,
  dirty: false,
  files_changed: 0,
  branch: null,
  ahead: null,
  behind: null,
};

/** Live, non-persisted state of a single worktree. */
export async function readWorktreeState(worktreePath: string): Promise<WorktreeState> {
  if (!(await isPresent(worktreePath))) return { ...ABSENT };
  const [{ dirty, files_changed }, branch, { ahead, behind }] = await Promise.all([
    readDirty(worktreePath),
    readBranch(worktreePath),
    readAheadBehind(worktreePath),
  ]);
  return { present: true, dirty, files_changed, branch, ahead, behind };
}

/** Stashes present in `repoPath`, newest first. Empty on failure. */
export async function listStashes(repoPath: string): Promise<StashRef[]> {
  const git = getGitRunner();
  try {
    const res = await git('git', ['-C', repoPath, 'stash', 'list', '--format=%H%x09%gs']);
    if (res.code !== 0) return [];
    return res.stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((parts): parts is [string, string] => Boolean(parts[0]?.trim() && parts[1]))
      .map(([sha, label]) => ({ sha: sha.trim(), label: label.trim() }));
  } catch {
    return [];
  }
}
