import path from 'node:path';
import type { DiscoveryHit, DiscoverySourceError } from './types.js';
import { runCommand, type RunCommand } from './run-command.js';

/**
 * Discover local git activity (recent branches, worktrees, stashes) across
 * one or more repo paths. Each repo is queried independently so a failure
 * in one repo doesn't suppress hits from the others.
 */

export interface DiscoverGitResult {
  hits: DiscoveryHit[];
  errors: DiscoverySourceError[];
}

const BRANCH_LIMIT = 20;

export async function discoverGit(
  repoPaths: string[],
  run: RunCommand = runCommand,
): Promise<DiscoverGitResult> {
  const hits: DiscoveryHit[] = [];
  const errors: DiscoverySourceError[] = [];

  for (const repoPath of repoPaths) {
    const repoName = path.basename(repoPath);
    await collectBranches(repoPath, repoName, hits, errors, run);
    await collectWorktrees(repoPath, repoName, hits, errors, run);
    await collectStashes(repoPath, repoName, hits, errors, run);
  }

  return { hits, errors };
}

async function collectBranches(
  repoPath: string,
  repoName: string,
  hits: DiscoveryHit[],
  errors: DiscoverySourceError[],
  run: RunCommand,
): Promise<void> {
  const sourceId = `branch:${repoName}`;
  try {
    const result = await run('git', [
      '-C',
      repoPath,
      'for-each-ref',
      '--sort=-committerdate',
      `--count=${BRANCH_LIMIT}`,
      '--format=%(refname:short)|%(committerdate:short)|%(subject)',
      'refs/heads/',
    ]);
    if (result.code !== 0) {
      errors.push({ source: sourceId, error: errMsg(result.stderr, result.code) });
      return;
    }
    for (const line of splitLines(result.stdout)) {
      const [name, date, ...rest] = line.split('|');
      if (!name) continue;
      const subject = rest.join('|');
      hits.push({
        source: sourceId,
        ref: name,
        detail: `${name} @ ${date ?? ''} — ${subject}`,
        metadata: { repo: repoName, repoPath, name, date, subject },
      });
    }
  } catch (err) {
    errors.push({ source: sourceId, error: errStr(err) });
  }
}

async function collectWorktrees(
  repoPath: string,
  repoName: string,
  hits: DiscoveryHit[],
  errors: DiscoverySourceError[],
  run: RunCommand,
): Promise<void> {
  const sourceId = `worktree:${repoName}`;
  try {
    const result = await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
    if (result.code !== 0) {
      errors.push({ source: sourceId, error: errMsg(result.stderr, result.code) });
      return;
    }
    for (const entry of parseWorktreePorcelain(result.stdout)) {
      // Skip the main worktree (== repoPath); only surface auxiliary ones.
      if (entry.path && entry.path !== repoPath && entry.branch) {
        hits.push({
          source: sourceId,
          ref: entry.branch,
          detail: `worktree ${entry.path} on ${entry.branch}`,
          metadata: { repo: repoName, repoPath, ...entry },
        });
      }
    }
  } catch (err) {
    errors.push({ source: sourceId, error: errStr(err) });
  }
}

async function collectStashes(
  repoPath: string,
  repoName: string,
  hits: DiscoveryHit[],
  errors: DiscoverySourceError[],
  run: RunCommand,
): Promise<void> {
  const sourceId = `stash:${repoName}`;
  try {
    const result = await run('git', ['-C', repoPath, 'stash', 'list']);
    if (result.code !== 0) {
      errors.push({ source: sourceId, error: errMsg(result.stderr, result.code) });
      return;
    }
    for (const line of splitLines(result.stdout)) {
      // Format: stash@{N}: WIP on <branch>: <hash> <subject>
      const refMatch = line.match(/^(stash@\{\d+\}):\s*(.*)$/);
      if (!refMatch) continue;
      const [, ref, message] = refMatch;
      hits.push({
        source: sourceId,
        ref: ref!,
        detail: message ?? line,
        metadata: { repo: repoName, repoPath, ref, message },
      });
    }
  } catch (err) {
    errors.push({ source: sourceId, error: errStr(err) });
  }
}

interface WorktreeEntry {
  path?: string;
  head?: string;
  branch?: string;
}

function parseWorktreePorcelain(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry = {};
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (line === '') {
      if (Object.keys(current).length > 0) entries.push(current);
      current = {};
      continue;
    }
    if (line.startsWith('worktree ')) current.path = line.slice('worktree '.length);
    else if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      current.branch = ref.replace(/^refs\/heads\//, '');
    }
  }
  if (Object.keys(current).length > 0) entries.push(current);
  return entries;
}

function splitLines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

function errMsg(stderr: string, code: number | null): string {
  return stderr.trim() || `git exited with code ${code}`;
}

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
