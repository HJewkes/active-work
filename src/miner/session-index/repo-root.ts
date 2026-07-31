import fs from 'node:fs';
import path from 'node:path';

/**
 * Authoritative repo attribution for a filesystem path (AW-91).
 *
 * The first cut derived a repo from `basename(cwd)`, which is a guess: any two
 * directories sharing a last path segment collapse into one repo. That is not
 * hypothetical — a checkout at `~/projects/active-work` and the CLI's own state
 * directory at `~/Library/Application Support/active-work/active-work` both
 * yielded `repo='active-work'`, so plain markdown state files were attributed
 * to the git repo and file precision in the ground-truth eval fell to 87%.
 *
 * The repo is now resolved by walking up to the nearest `.git` (the same thing
 * `git rev-parse --show-toplevel` reports) and naming it from the `origin`
 * remote, falling back to the toplevel's basename. A directory with no `.git`
 * ancestor — the state directory included — resolves to `null` and its files
 * stay unattributed rather than mis-attributed.
 *
 * Resolution is filesystem-derived rather than transcript-derived, so it is
 * memoized per directory: the extraction path calls this once per touched file
 * and a corpus pass touches the same handful of repos tens of thousands of
 * times. Nothing here shells out — `LineHandler` is synchronous and hot.
 */

export interface RepoIdentity {
  /** Absolute path of the working-tree root (the `.git` holder). */
  root: string;
  /** Short repo name: `origin`'s repo segment, else `basename(root)`. */
  name: string;
}

const cache = new Map<string, RepoIdentity | null>();

/** Drop memoized lookups. Tests that build repos on the fly need this. */
export function clearRepoCache(): void {
  cache.clear();
}

/** `.git` is a directory in a normal clone, a `gitdir:` pointer in a worktree. */
function gitDirFor(candidate: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return candidate;
  if (!stat.isFile()) return null;
  const pointer = readFile(candidate)
    ?.match(/^gitdir:\s*(.+)$/m)?.[1]
    ?.trim();
  if (!pointer) return null;
  return path.resolve(path.dirname(candidate), pointer);
}

function readFile(target: string): string | null {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

/**
 * A linked worktree's git dir is `<main>/.git/worktrees/<name>`; its
 * `commondir` file points back at the shared `.git`, which is where `config`
 * (and therefore the remote) lives. A normal clone has no `commondir`.
 */
function commonGitDir(gitDir: string): string {
  const relative = readFile(path.join(gitDir, 'commondir'))?.trim();
  return relative ? path.resolve(gitDir, relative) : gitDir;
}

/**
 * Parse the `origin` remote's URL out of a git config file.
 *
 * Line-oriented rather than one regex: git config is an INI dialect where the
 * section header decides which `url =` is the one being read, and a regex that
 * has to both find the section and stop at the next one is harder to read than
 * the state machine it is emulating.
 */
export function parseOriginUrl(config: string): string | null {
  let inOrigin = false;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const url = line.match(/^url\s*=\s*(.+)$/)?.[1]?.trim();
    if (url) return url;
  }
  return null;
}

/** `git@github.com:org/active-work.git` / `https://…/org/active-work` -> `active-work`. */
export function repoNameFromRemoteUrl(url: string): string | null {
  const last = url
    .replace(/[/:]+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .pop();
  return last && last.length > 0 ? last : null;
}

function repoName(root: string, gitDir: string): string {
  const config = readFile(path.join(commonGitDir(gitDir), 'config'));
  const url = config ? parseOriginUrl(config) : null;
  return (url ? repoNameFromRemoteUrl(url) : null) ?? path.basename(root);
}

/**
 * Nearest enclosing git working tree, or null when there is none.
 *
 * Every directory visited on the way up is memoized with the same answer, so a
 * deep path costs one walk for the whole subtree.
 */
export function resolveRepo(startDir: string | null): RepoIdentity | null {
  if (!startDir) return null;
  const visited: string[] = [];
  let dir = path.resolve(startDir);

  for (;;) {
    const hit = cache.get(dir);
    if (hit !== undefined) return remember(visited, hit);
    visited.push(dir);

    const gitDir = gitDirFor(path.join(dir, '.git'));
    if (gitDir) return remember(visited, { root: dir, name: repoName(dir, gitDir) });

    const parent = path.dirname(dir);
    if (parent === dir) return remember(visited, null);
    dir = parent;
  }
}

function remember(dirs: string[], identity: RepoIdentity | null): RepoIdentity | null {
  for (const dir of dirs) cache.set(dir, identity);
  return identity;
}
