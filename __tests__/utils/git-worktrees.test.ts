import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverWorktrees,
  listStashes,
  parseWorktreePorcelain,
  readWorktreeState,
} from '../../src/utils/git-worktrees.js';
import { resetRunners, setGitRunner, type CommandRunner } from '../../src/utils/git-gh.js';

const PORCELAIN = [
  'worktree /repo/main',
  'HEAD aaaa1111',
  'branch refs/heads/main',
  '',
  'worktree /repo/wt-detached',
  'HEAD bbbb2222',
  'detached',
  '',
  'worktree /repo/bare',
  'bare',
  '',
].join('\n');

/**
 * Route a fake git invocation by the subcommand present in its args.
 *
 * `--is-inside-work-tree` answers "yes" unless a handler overrides it, so the
 * tests that care about tree contents don't each have to restate that the
 * worktree exists. It is checked first because its args also contain
 * `rev-parse`, which a branch handler would otherwise swallow.
 */
function gitFake(handlers: Record<string, () => { code: number; stdout: string }>): CommandRunner {
  const present = handlers['--is-inside-work-tree'] ?? (() => ({ code: 0, stdout: 'true\n' }));
  return async (_bin, args) => {
    if (args.includes('--is-inside-work-tree')) return { ...present(), stderr: '' };
    for (const [key, handler] of Object.entries(handlers)) {
      if (args.includes(key)) return { ...handler(), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unhandled' };
  };
}

afterEach(() => {
  resetRunners();
});

describe('parseWorktreePorcelain', () => {
  it('parses path, head, and branch for an attached worktree', () => {
    const [main] = parseWorktreePorcelain(PORCELAIN);
    expect(main).toEqual({
      path: '/repo/main',
      head: 'aaaa1111',
      branch: 'main',
      detached: false,
      bare: false,
    });
  });

  it('marks a detached worktree with a null branch', () => {
    const detached = parseWorktreePorcelain(PORCELAIN)[1]!;
    expect(detached.detached).toBe(true);
    expect(detached.branch).toBeNull();
  });

  it('marks a bare worktree', () => {
    const bare = parseWorktreePorcelain(PORCELAIN)[2]!;
    expect(bare.bare).toBe(true);
    expect(bare.head).toBeNull();
  });

  it('ignores unknown keys and stray leading lines', () => {
    const entries = parseWorktreePorcelain('locked\nworktree /repo/a\nprunable gitdir gone\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('/repo/a');
  });

  it('returns an empty list for empty output', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
  });
});

describe('discoverWorktrees', () => {
  it('enumerates worktrees from porcelain output', async () => {
    setGitRunner(gitFake({ worktree: () => ({ code: 0, stdout: PORCELAIN }) }));
    const found = await discoverWorktrees('/repo/main');
    expect(found.map((w) => w.path)).toEqual([
      '/repo/main',
      '/repo/wt-detached',
      '/repo/bare',
    ]);
  });

  it('returns an empty list when git fails', async () => {
    setGitRunner(async () => ({ code: 128, stdout: '', stderr: 'not a repo' }));
    expect(await discoverWorktrees('/nope')).toEqual([]);
  });

  it('returns an empty list when the runner throws', async () => {
    setGitRunner(async () => {
      throw new Error('spawn failed');
    });
    expect(await discoverWorktrees('/nope')).toEqual([]);
  });
});

describe('readWorktreeState', () => {
  it('reports a dirty tree with a file count and ahead/behind', async () => {
    let revListCalls = 0;
    setGitRunner(
      gitFake({
        status: () => ({ code: 0, stdout: ' M src/a.ts\n?? src/b.ts\n' }),
        'rev-parse': () => ({ code: 0, stdout: 'feat/thing\n' }),
        'rev-list': () => ({ code: 0, stdout: revListCalls++ === 0 ? '3\n' : '2\n' }),
      }),
    );
    expect(await readWorktreeState('/repo/wt')).toEqual({
      present: true,
      dirty: true,
      files_changed: 2,
      branch: 'feat/thing',
      ahead: 3,
      behind: 2,
    });
  });

  // A deleted worktree used to read exactly like a clean one — not dirty, no
  // files, no upstream — so it vanished from `artifact status` without a word.
  it('reports a vanished worktree as absent, not as clean', async () => {
    setGitRunner(
      gitFake({
        '--is-inside-work-tree': () => ({ code: 128, stdout: '' }),
        status: () => ({ code: 0, stdout: ' M src/a.ts\n' }),
      }),
    );
    const state = await readWorktreeState('/repo/gone');
    expect(state.present).toBe(false);
    expect(state.dirty).toBe(false);
    expect(state.files_changed).toBe(0);
  });

  it('reports a live worktree as present', async () => {
    setGitRunner(
      gitFake({
        status: () => ({ code: 0, stdout: '' }),
        'rev-parse': () => ({ code: 0, stdout: 'main\n' }),
        'rev-list': () => ({ code: 0, stdout: '0\n' }),
      }),
    );
    expect((await readWorktreeState('/repo/main')).present).toBe(true);
  });

  it('reports a clean tree as not dirty with zero files changed', async () => {
    setGitRunner(
      gitFake({
        status: () => ({ code: 0, stdout: '\n' }),
        'rev-parse': () => ({ code: 0, stdout: 'main\n' }),
        'rev-list': () => ({ code: 0, stdout: '0\n' }),
      }),
    );
    const state = await readWorktreeState('/repo/main');
    expect(state.dirty).toBe(false);
    expect(state.files_changed).toBe(0);
  });

  it('yields null ahead/behind when there is no upstream', async () => {
    setGitRunner(
      gitFake({
        status: () => ({ code: 0, stdout: '' }),
        'rev-parse': () => ({ code: 0, stdout: 'solo\n' }),
        'rev-list': () => ({ code: 128, stdout: '' }),
      }),
    );
    const state = await readWorktreeState('/repo/solo');
    expect(state.ahead).toBeNull();
    expect(state.behind).toBeNull();
  });

  it('yields a null branch when HEAD is detached', async () => {
    setGitRunner(
      gitFake({
        status: () => ({ code: 0, stdout: '' }),
        'rev-parse': () => ({ code: 0, stdout: 'HEAD\n' }),
        'rev-list': () => ({ code: 128, stdout: '' }),
      }),
    );
    expect((await readWorktreeState('/repo/detached')).branch).toBeNull();
  });
});

describe('listStashes', () => {
  it('parses sha and label pairs', async () => {
    setGitRunner(
      gitFake({
        stash: () => ({
          code: 0,
          stdout: 'aaaa1111\tWIP on main: 1234 tidy\nbbbb2222\tOn feat: spike\n',
        }),
      }),
    );
    expect(await listStashes('/repo/main')).toEqual([
      { sha: 'aaaa1111', label: 'WIP on main: 1234 tidy' },
      { sha: 'bbbb2222', label: 'On feat: spike' },
    ]);
  });

  it('returns an empty list when there are no stashes', async () => {
    setGitRunner(gitFake({ stash: () => ({ code: 0, stdout: '' }) }));
    expect(await listStashes('/repo/main')).toEqual([]);
  });

  it('returns an empty list when git fails', async () => {
    setGitRunner(async () => ({ code: 1, stdout: '', stderr: 'boom' }));
    expect(await listStashes('/repo/main')).toEqual([]);
  });
});
