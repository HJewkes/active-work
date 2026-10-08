import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultLiveStatusFetcher } from '../../src/bootstrap/prompt.js';
import type { BranchEntry } from '../../src/schemas/artifacts.js';
import {
  resetRunners,
  resolveOrgRepo,
  setGhRunner,
  setGitRunner,
  type CommandRunner,
} from '../../src/utils/git-gh.js';

const REPO_A = '/tmp/clones/widgets';
const REPO_B = '/tmp/clones/gadgets';
const ORIGINS: Record<string, string> = {
  [REPO_A]: 'git@github.com:acme/widgets.git',
  [REPO_B]: 'https://github.com/acme/gadgets.git',
};

interface Pr {
  headRefName: string;
  number: number;
  state: string;
  title: string;
  url: string;
  statusCheckRollup: Array<{ conclusion?: string; state?: string }>;
}

function pr(head: string, number: number, rollup: Pr['statusCheckRollup'] = []): Pr {
  return {
    headRefName: head,
    number,
    state: 'OPEN',
    title: `Change ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    statusCheckRollup: rollup,
  };
}

function branch(repo: string, name: string): BranchEntry {
  return { repo, name };
}

/** A git where every branch exists, is 2 ahead / 7 behind, and origin/main exists. */
function stubGit(): string[][] {
  const calls: string[][] = [];
  const runner: CommandRunner = (_bin, args) => {
    calls.push(args);
    const repoPath = args[1]!;
    const verb = args.slice(2).join(' ');
    let stdout = '';
    if (verb === 'remote get-url origin') stdout = `${ORIGINS[repoPath]}\n`;
    else if (verb.startsWith('log -1')) stdout = '2026-09-01T10:00:00Z\n';
    else if (verb.startsWith('rev-list')) stdout = '7\t2\n';
    return Promise.resolve({ code: 0, stdout, stderr: '' });
  };
  setGitRunner(runner);
  return calls;
}

/** A gh that serves `prsByRepo`, honouring `--head` and `--limit` like the real one. */
function stubGh(prsByRepo: Record<string, Pr[]>): string[][] {
  const calls: string[][] = [];
  const runner: CommandRunner = (_bin, args) => {
    calls.push(args);
    const flag = (name: string) => {
      const at = args.indexOf(name);
      return at === -1 ? undefined : args[at + 1];
    };
    const head = flag('--head');
    const listed = (prsByRepo[flag('--repo')!] ?? []).filter(
      (p) => !head || p.headRefName === head,
    );
    const stdout = JSON.stringify(listed.slice(0, Number(flag('--limit'))));
    return Promise.resolve({ code: 0, stdout, stderr: '' });
  };
  setGhRunner(runner);
  return calls;
}

const isBulk = (args: string[]) => !args.includes('--head');

afterEach(() => resetRunners());

describe('defaultLiveStatusFetcher', () => {
  it('asks gh once per distinct repo when the bulk lists answer every branch', async () => {
    const git = stubGit();
    const gh = stubGh({
      'acme/widgets': [pr('feat/a', 11, [{ conclusion: 'SUCCESS' }]), pr('feat/b', 12)],
      'acme/gadgets': [pr('feat/c', 13)],
    });
    const branches = [
      branch(REPO_A, 'feat/a'),
      branch(REPO_A, 'feat/b'),
      branch(REPO_A, 'stale/no-pr'),
      branch(REPO_B, 'feat/c'),
    ];

    const statuses = await defaultLiveStatusFetcher(branches);

    expect(gh).toHaveLength(2);
    expect(gh.every(isBulk)).toBe(true);
    expect(git.filter((args) => args.includes('get-url'))).toHaveLength(2);
    expect(statuses.map((s) => s.pr?.number ?? null)).toEqual([11, 12, null, 13]);
    expect(statuses[0]).toMatchObject({ present: true, ahead: 2, behind: 7 });
    expect(statuses[0]!.pr?.checks).toBe('pass (1/1)');
  });

  it('falls back to a per-branch query for heads a truncated bulk list missed', async () => {
    stubGit();
    const crowd = Array.from({ length: 200 }, (_, i) => pr(`feat/newer-${i}`, 1000 + i));
    const gh = stubGh({ 'acme/widgets': [...crowd, pr('feat/old', 7)] });
    const branches = [branch(REPO_A, 'feat/newer-3'), branch(REPO_A, 'feat/old')];

    const statuses = await defaultLiveStatusFetcher(branches);

    expect(gh.filter(isBulk)).toHaveLength(1);
    expect(gh.filter((args) => !isBulk(args))).toEqual([
      expect.arrayContaining(['--head', 'feat/old']),
    ]);
    expect(statuses.map((s) => s.pr?.number)).toEqual([1003, 7]);
  });

  it('renders the same PR from the bulk list as from the per-branch query', async () => {
    stubGit();
    const rollup = [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { state: 'PENDING' }];
    const prs = [pr('feat/a', 21, rollup)];
    stubGh({ 'acme/widgets': prs });
    const [fromBulk] = await defaultLiveStatusFetcher([branch(REPO_A, 'feat/a')]);
    const crowded = [...Array.from({ length: 200 }, (_, i) => pr(`x-${i}`, i)), ...prs];
    stubGh({ 'acme/widgets': crowded });

    const [fromFallback] = await defaultLiveStatusFetcher([branch(REPO_A, 'feat/a')]);

    expect(fromBulk!.pr).toEqual(fromFallback!.pr);
    expect(fromBulk!.pr?.checks).toBe('fail (1/3)');
  });
});

describe('resolveOrgRepo', () => {
  afterEach(() => vi.useRealTimers());

  it('reads a clone origin once while the answer is fresh', async () => {
    const git = stubGit();

    const answers = await Promise.all([resolveOrgRepo(REPO_A), resolveOrgRepo(REPO_A)]);
    await resolveOrgRepo(REPO_A);

    expect(answers).toEqual(['acme/widgets', 'acme/widgets']);
    expect(git).toHaveLength(1);
  });

  it('reads the origin again once the answer has expired', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-08T10:00:00Z') });
    const git = stubGit();
    await resolveOrgRepo(REPO_A);

    vi.setSystemTime(new Date('2026-10-08T10:06:00Z'));
    await resolveOrgRepo(REPO_A);

    expect(git).toHaveLength(2);
  });

  it('does not keep a failed lookup, so an origin added later is seen', async () => {
    let hasOrigin = false;
    setGitRunner(() =>
      Promise.resolve(
        hasOrigin
          ? { code: 0, stdout: `${ORIGINS[REPO_A]}\n`, stderr: '' }
          : { code: 2, stdout: '', stderr: 'error: No such remote' },
      ),
    );
    const before = await resolveOrgRepo(REPO_A);

    hasOrigin = true;
    const after = await resolveOrgRepo(REPO_A);

    expect([before, after]).toEqual([null, 'acme/widgets']);
  });
});
