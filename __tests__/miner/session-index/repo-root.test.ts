import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commandCwd } from '../../../src/miner/session-index/bash-parse.js';
import { fileRef, repoForCwd, toRepoRelative } from '../../../src/miner/session-index/edges.js';
import {
  clearRepoCache,
  parseOriginUrl,
  repoNameFromRemoteUrl,
  resolveRepo,
} from '../../../src/miner/session-index/repo-root.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-repo-root-'));
  clearRepoCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearRepoCache();
});

/** A working tree is a `.git` directory; `origin` is what names it. */
function makeRepo(at: string, originUrl?: string): string {
  mkdirSync(path.join(at, '.git'), { recursive: true });
  if (originUrl) {
    writeFileSync(path.join(at, '.git', 'config'), `[remote "origin"]\n\turl = ${originUrl}\n`);
  }
  return at;
}

describe('resolveRepo', () => {
  it('names a repo from its origin remote, not its directory name', () => {
    const root = makeRepo(
      path.join(dir, 'checked-out-as-something-else'),
      'git@github.com:acme/demo.git',
    );

    expect(resolveRepo(root)).toEqual({ root, name: 'demo' });
  });

  it('falls back to the toplevel basename when there is no origin remote', () => {
    const root = makeRepo(path.join(dir, 'local-only'));

    expect(resolveRepo(root)).toEqual({ root, name: 'local-only' });
  });

  it('resolves a nested directory to its enclosing working tree', () => {
    const root = makeRepo(path.join(dir, 'demo'), 'https://github.com/acme/demo');
    const nested = path.join(root, 'src', 'miner', 'deep');
    mkdirSync(nested, { recursive: true });

    expect(resolveRepo(nested)).toEqual({ root, name: 'demo' });
  });

  it('resolves a linked worktree through its gitdir pointer', () => {
    const main = makeRepo(path.join(dir, 'demo'), 'git@github.com:acme/demo.git');
    const worktreeGitDir = path.join(main, '.git', 'worktrees', 'wt');
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    const worktree = path.join(dir, 'wt-checkout');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);

    expect(resolveRepo(worktree)).toEqual({ root: worktree, name: 'demo' });
  });

  it('returns null for a directory with no .git ancestor', () => {
    const plain = path.join(dir, 'state', 'active-work');
    mkdirSync(plain, { recursive: true });

    expect(resolveRepo(plain)).toBeNull();
  });
});

describe('toRepoRelative', () => {
  it('attributes a file to its enclosing repo, relative to the working-tree root', () => {
    const root = makeRepo(path.join(dir, 'demo'), 'git@github.com:acme/demo.git');
    mkdirSync(path.join(root, 'src'), { recursive: true });

    expect(toRepoRelative(path.join(root, 'src', 'app.ts'))).toEqual({
      repo: 'demo',
      path: 'src/app.ts',
    });
  });

  it('is independent of which subdirectory the tool call ran in', () => {
    const root = makeRepo(path.join(dir, 'demo'));
    mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });

    expect(toRepoRelative(path.join(root, 'src', 'nested', 'app.ts')).path).toBe(
      'src/nested/app.ts',
    );
  });

  it('leaves a file with no .git ancestor unattributed (AW-91 state-dir collision)', () => {
    // Both directories end in `active-work`; only one is a git checkout. The
    // old `basename(cwd)` rule attributed the state file to the repo.
    const repo = makeRepo(
      path.join(dir, 'projects', 'active-work'),
      'git@github.com:h/active-work.git',
    );
    const stateDir = path.join(dir, 'Application Support', 'active-work', 'active-work');
    mkdirSync(stateDir, { recursive: true });

    const tracked = toRepoRelative(path.join(repo, 'brief.md'));
    const state = toRepoRelative(path.join(stateDir, 'brief.md'));

    expect(tracked).toEqual({ repo: 'active-work', path: 'brief.md' });
    expect(state).toEqual({ repo: null, path: path.join(stateDir, 'brief.md') });
    expect(fileRef(state.repo, state.path)).not.toContain('file:active-work/');
  });

  it('leaves a non-absolute path alone — it has no anchor to resolve against', () => {
    expect(toRepoRelative('src/app.ts')).toEqual({ repo: null, path: 'src/app.ts' });
  });
});

describe('repoForCwd', () => {
  it('names the repo a tool call ran in, and nothing for a plain directory', () => {
    const root = makeRepo(path.join(dir, 'demo'), 'git@github.com:acme/demo.git');
    const plain = path.join(dir, 'plain');
    mkdirSync(plain, { recursive: true });

    expect(repoForCwd(root)).toBe('demo');
    expect(repoForCwd(plain)).toBeNull();
    expect(repoForCwd(null)).toBeNull();
  });
});

describe('commandCwd', () => {
  const session = '/state/active-work';

  it.each([
    ['cd /projects/demo && git checkout -b feat/x', '/projects/demo'],
    ['cd /projects/demo; git commit -m x', '/projects/demo'],
    ['git -C /projects/demo checkout -b feat/x', '/projects/demo'],
    // `-C` is the more specific of the two and wins.
    ['cd /elsewhere && git -C /projects/demo push', '/projects/demo'],
  ])('anchors %s at %s', (command, expected) => {
    expect(commandCwd(command, session)).toBe(expected);
  });

  it('falls back to the session cwd when the command names no directory', () => {
    expect(commandCwd('git checkout -b feat/x', session)).toBe(session);
    expect(commandCwd('git checkout -b feat/x', null)).toBeNull();
  });

  it('resolves a relative cd against the session cwd', () => {
    expect(commandCwd('cd ../demo && git push', '/projects/other')).toBe('/projects/demo');
  });

  it('expands a leading ~', () => {
    expect(commandCwd('cd ~/projects/demo && git push', session)).toBe(
      path.join(os.homedir(), 'projects/demo'),
    );
  });
});

describe('remote URL parsing', () => {
  it('reads url from the origin section only', () => {
    const config = [
      '[core]',
      '\turl = not-a-remote',
      '[remote "upstream"]',
      '\turl = git@github.com:other/upstream.git',
      '[remote "origin"]',
      '\turl = git@github.com:acme/demo.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ].join('\n');

    expect(parseOriginUrl(config)).toBe('git@github.com:acme/demo.git');
  });

  it('returns null when there is no origin', () => {
    expect(parseOriginUrl('[remote "upstream"]\n\turl = x\n')).toBeNull();
  });

  it.each([
    ['git@github.com:acme/demo.git', 'demo'],
    ['https://github.com/acme/demo', 'demo'],
    ['https://github.com/acme/demo.git/', 'demo'],
    ['/srv/mirrors/demo.git', 'demo'],
  ])('derives a short repo name from %s', (url, expected) => {
    expect(repoNameFromRemoteUrl(url)).toBe(expected);
  });
});
