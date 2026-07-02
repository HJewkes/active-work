import { afterEach, describe, expect, it } from 'vitest';
import syncCmd, { setGitRunner, resetRunners } from '../../src/commands/sync.js';
import type { CommandRunner, CommandResult } from '../../src/utils/git-gh.js';
import { UsageError, ActiveWorkError } from '../../src/errors.js';

const ctx = { activeRoot: '/fake/active-root', warnings: [], format: 'json' as const };

interface Scenario {
  isRepo?: boolean;
  branch?: string;
  hasUpstream?: boolean;
  dirty?: boolean;
  staged?: string[];
  pull?: CommandResult;
  /** Whether HEAD moves across the pull (i.e. upstream had new commits). */
  headMoves?: boolean;
  conflicts?: string[];
  push?: CommandResult;
}

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom'): CommandResult => ({ code: 1, stdout: '', stderr });

/**
 * Build a fake git runner that answers each subcommand from `s`. Calls are
 * recorded so tests can assert on side effects (e.g. that a commit happened).
 */
function scenario(s: Scenario = {}): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  let headReads = 0;
  const runner: CommandRunner = async (_bin, args) => {
    const sub = args.slice(2); // drop ['-C', root]
    calls.push(sub);
    const key = sub.join(' ');
    if (key === 'rev-parse --is-inside-work-tree') {
      return s.isRepo === false ? ok('false') : ok('true');
    }
    if (key === 'rev-parse HEAD') {
      // First read = before pull, second = after. HEAD moves iff headMoves.
      const moved = (s.headMoves ?? true) && headReads++ > 0;
      return ok(moved ? 'sha-after' : 'sha-before');
    }
    if (key === 'rev-parse --abbrev-ref HEAD') return ok(s.branch ?? 'main');
    if (key.startsWith('rev-parse --abbrev-ref --symbolic-full-name')) {
      return s.hasUpstream === false ? fail('no upstream') : ok('origin/main');
    }
    if (key === 'status --porcelain') return ok(s.dirty ? ' M tasks/AW-1.yml\n' : '');
    if (key === 'add -A') return ok();
    if (key === 'diff --cached --name-only') {
      return ok((s.staged ?? ['tasks/AW-1.yml']).join('\n'));
    }
    if (sub[0] === 'commit') return ok();
    if (key === 'pull --rebase') return s.pull ?? ok('Successfully rebased.');
    if (key === 'diff --name-only --diff-filter=U') {
      return ok((s.conflicts ?? []).join('\n'));
    }
    if (key === 'push') return s.push ?? ok();
    throw new Error(`unexpected git call: ${key}`);
  };
  return { runner, calls };
}

afterEach(() => resetRunners());

describe('sync', () => {
  it('rejects when the active root is not a git repo', async () => {
    const { runner } = scenario({ isRepo: false });
    setGitRunner(runner);
    await expect(syncCmd.run({}, ctx)).rejects.toBeInstanceOf(UsageError);
  });

  it('rejects on a detached HEAD', async () => {
    const { runner } = scenario({ branch: 'HEAD' });
    setGitRunner(runner);
    await expect(syncCmd.run({}, ctx)).rejects.toBeInstanceOf(UsageError);
  });

  it('rejects when the branch has no upstream', async () => {
    const { runner } = scenario({ hasUpstream: false });
    setGitRunner(runner);
    await expect(syncCmd.run({}, ctx)).rejects.toThrow(/no upstream/i);
  });

  it('pulls and pushes a clean tree without committing', async () => {
    const { runner, calls } = scenario({ dirty: false });
    setGitRunner(runner);
    const res = await syncCmd.run({}, ctx);
    expect(res).toMatchObject({
      branch: 'main',
      committed: false,
      committed_files: 0,
      rebased: true,
      pushed: true,
    });
    expect(calls.some((c) => c[0] === 'commit')).toBe(false);
  });

  it('reports rebased=false when HEAD does not move (already up to date)', async () => {
    const { runner } = scenario({ dirty: false, headMoves: false });
    setGitRunner(runner);
    const res = await syncCmd.run({}, ctx);
    expect(res.rebased).toBe(false);
    expect(res.pushed).toBe(true);
  });

  it('auto-commits a dirty tree before pulling', async () => {
    const { runner, calls } = scenario({ dirty: true, staged: ['tasks/AW-1.yml'] });
    setGitRunner(runner);
    const res = await syncCmd.run({}, ctx);
    expect(res.committed).toBe(true);
    expect(res.committed_files).toBe(1);
    const commit = calls.find((c) => c[0] === 'commit');
    expect(commit).toBeDefined();
    // Default message carries the aw-sync marker.
    expect(commit!.join(' ')).toMatch(/aw sync:/);
  });

  it('uses a custom commit message when provided', async () => {
    const { runner, calls } = scenario({ dirty: true });
    setGitRunner(runner);
    await syncCmd.run({ message: 'sync from laptop' }, ctx);
    const commit = calls.find((c) => c[0] === 'commit')!;
    expect(commit).toContain('sync from laptop');
  });

  it('does not commit when nothing is staged (e.g. only ignored files)', async () => {
    const { runner } = scenario({ dirty: true, staged: [] });
    setGitRunner(runner);
    const res = await syncCmd.run({}, ctx);
    expect(res.committed).toBe(false);
    expect(res.committed_files).toBe(0);
  });

  it('fails on a dirty tree when --require-clean is set', async () => {
    const { runner, calls } = scenario({ dirty: true });
    setGitRunner(runner);
    await expect(syncCmd.run({ require_clean: true }, ctx)).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(calls.some((c) => c[0] === 'commit')).toBe(false);
  });

  it('surfaces a rebase conflict clearly and leaves it in place', async () => {
    const { runner, calls } = scenario({
      dirty: false,
      pull: fail('CONFLICT (content): Merge conflict in tasks/AW-1.yml'),
      conflicts: ['tasks/AW-1.yml', 'handoff.md'],
    });
    setGitRunner(runner);
    await expect(syncCmd.run({}, ctx)).rejects.toThrow(/conflict/i);
    // Must NOT push after a failed rebase, and must NOT auto-abort.
    expect(calls.some((c) => c[0] === 'push')).toBe(false);
    expect(calls.some((c) => c.join(' ').includes('rebase --abort'))).toBe(false);
    await expect(syncCmd.run({}, ctx).catch((e: Error) => e.message)).resolves.toContain(
      'tasks/AW-1.yml',
    );
  });

  it('surfaces a push failure', async () => {
    const { runner } = scenario({ dirty: false, push: fail('rejected: non-fast-forward') });
    setGitRunner(runner);
    await expect(syncCmd.run({}, ctx)).rejects.toBeInstanceOf(ActiveWorkError);
  });
});
