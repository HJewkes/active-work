import { spawn } from 'node:child_process';
import path from 'node:path';
import { expandTilde } from './paths.js';

/**
 * Live-pull helpers for AW-15 `artifact.status` / `artifact.prune`.
 *
 * Everything in this module is failure-tolerant: callers want partial data
 * with per-branch error strings, not a single thrown exception that aborts
 * the entire status sweep. The runners are exposed as injectable DI hooks so
 * tests can stub them without spawning subprocesses.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  bin: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>;

const defaultRunner: CommandRunner = (bin, args, opts = {}) =>
  new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });

let gitRunner: CommandRunner = defaultRunner;
let ghRunner: CommandRunner = defaultRunner;

export function setGitRunner(next: CommandRunner): void {
  gitRunner = next;
}

export function setGhRunner(next: CommandRunner): void {
  ghRunner = next;
}

export function resetRunners(): void {
  gitRunner = defaultRunner;
  ghRunner = defaultRunner;
}

export function getGitRunner(): CommandRunner {
  return gitRunner;
}

export function getGhRunner(): CommandRunner {
  return ghRunner;
}

/**
 * True when `repo` looks like a bare `org/repo` GitHub spec rather than a
 * filesystem path.
 *
 * Heuristic: exactly one slash, no leading `/`, `~`, or `.`, and no whitespace.
 * `~/code/sample` has a tilde, `./foo/bar` has a dot, `/abs/path` starts with
 * `/` — all of those are treated as paths.
 */
export function looksLikeOrgRepo(repo: string): boolean {
  if (!repo) return false;
  if (repo.startsWith('/') || repo.startsWith('~') || repo.startsWith('.')) return false;
  if (/\s/.test(repo)) return false;
  const slashCount = (repo.match(/\//g) ?? []).length;
  return slashCount === 1;
}

/**
 * Resolve a `branches[].repo` value (which may be a local path or `org/repo`)
 * to an absolute filesystem path. Returns `null` when the value looks like
 * an `org/repo` spec (no local clone to operate on).
 */
export function resolveLocalRepoPath(repo: string): string | null {
  if (looksLikeOrgRepo(repo)) return null;
  return path.resolve(expandTilde(repo));
}

/**
 * Run `git -C <repoPath> remote get-url origin` and derive `org/repo` from
 * the URL. Supports https, ssh, and git:// URLs. Returns null if the URL
 * can't be parsed or the call fails.
 */
export async function deriveOrgRepoFromPath(repoPath: string): Promise<string | null> {
  try {
    const res = await gitRunner('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
    if (res.code !== 0) return null;
    return parseOrgRepoFromRemoteUrl(res.stdout.trim());
  } catch {
    return null;
  }
}

/** Parse `org/repo` out of a git remote URL. Exported for testing. */
export function parseOrgRepoFromRemoteUrl(url: string): string | null {
  // https://github.com/org/repo(.git)?
  // git@github.com:org/repo(.git)?
  // ssh://git@github.com/org/repo(.git)?
  const trimmed = url.trim().replace(/\.git$/, '');
  const sshMatch = /^[^@]+@[^:]+:([^/]+)\/(.+)$/.exec(trimmed);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  try {
    const u = new URL(trimmed);
    const parts = u.pathname.replace(/^\//, '').split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[0]}/${parts[1]}`;
    }
  } catch {
    // not a parseable URL
  }
  return null;
}

/**
 * Resolve `repo` to an `org/repo` string suitable for `gh`. If `repo` already
 * looks like `org/repo`, return it unchanged. Otherwise treat it as a local
 * path and derive from `git remote`. Returns null when neither route works.
 */
export async function resolveOrgRepo(repo: string): Promise<string | null> {
  if (looksLikeOrgRepo(repo)) return repo;
  const localPath = resolveLocalRepoPath(repo);
  if (!localPath) return null;
  return deriveOrgRepoFromPath(localPath);
}
