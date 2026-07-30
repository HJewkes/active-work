import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { recordUnrecorded, sweepInitiative } from '../../src/wrap/sweep.js';
import { resetRunners, setGitRunner, type CommandRunner } from '../../src/utils/git-gh.js';
import { ArtifactsSchema } from '../../src/schemas/artifacts.js';
import { readYaml } from '../../src/utils/yaml-io.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';

/** The repo the fixture's brief.md and artifacts.yml both point at. */
const SAMPLE_REPO = path.join(os.homedir(), 'code', 'sample');

interface FakeWorktree {
  path: string;
  branch?: string;
  dirty?: number;
  /** Models `git status` failing, which is "unknown tree", not "clean tree". */
  statusFails?: boolean;
  /** Undefined models "no upstream", which git reports as a failed rev-list. */
  ahead?: number;
  behind?: number;
  /**
   * Commits on no remote (`rev-list HEAD --not --remotes`). Undefined models a
   * failed probe, which is "unknown", not "zero".
   */
  unpushed?: number;
  bare?: boolean;
}

interface FakeRepo {
  worktrees: FakeWorktree[];
  stashes?: Array<{ sha: string; label: string }>;
}

const ok = (stdout = ''): { code: number; stdout: string; stderr: string } => ({
  code: 0,
  stdout,
  stderr: '',
});

const fail = (): { code: number; stdout: string; stderr: string } => ({
  code: 1,
  stdout: '',
  stderr: 'not a git repository',
});

function porcelain(repo: FakeRepo): string {
  return repo.worktrees
    .map((wt) => {
      const lines = [`worktree ${wt.path}`, 'HEAD 0123456789abcdef'];
      if (wt.bare) lines.push('bare');
      else if (wt.branch) lines.push(`branch refs/heads/${wt.branch}`);
      else lines.push('detached');
      return `${lines.join('\n')}\n`;
    })
    .join('\n');
}

/**
 * A git runner over an in-memory repo table. Any directory not in the table
 * fails every call, which is how a moved or deleted repo behaves.
 */
function makeGitRunner(repos: Record<string, FakeRepo>): CommandRunner {
  const worktrees = new Map<string, FakeWorktree>();
  for (const repo of Object.values(repos)) {
    for (const wt of repo.worktrees) worktrees.set(wt.path, wt);
  }
  return async (_bin, args) => {
    const dir = args[1] ?? '';
    const rest = args.slice(2);
    const repo = repos[dir];
    if (rest[0] === 'worktree') return repo ? ok(porcelain(repo)) : fail();
    if (rest[0] === 'stash') {
      if (!repo) return fail();
      return ok((repo.stashes ?? []).map((s) => `${s.sha}\t${s.label}`).join('\n'));
    }
    const wt = worktrees.get(dir);
    if (!wt) return fail();
    if (rest[1] === '--is-inside-work-tree') return ok('true\n');
    if (rest[0] === 'rev-parse') {
      // The `@{u}` probe is how has_upstream is now read (AW-73). It must fail
      // exactly when the fixture has no upstream — which this fake models as
      // `ahead: undefined` — rather than answering like the branch lookup.
      if (rest.includes('@{u}')) {
        return wt.ahead === undefined ? fail() : ok(`origin/${wt.branch ?? 'HEAD'}\n`);
      }
      return ok(`${wt.branch ?? 'HEAD'}\n`);
    }
    if (rest[0] === 'status') {
      if (wt.statusFails) return fail();
      return ok(Array.from({ length: wt.dirty ?? 0 }, (_, i) => ` M file${i}`).join('\n'));
    }
    if (rest[0] === 'rev-list') {
      if (rest.includes('--not')) {
        return wt.unpushed === undefined ? fail() : ok(`${wt.unpushed}\n`);
      }
      if (wt.ahead === undefined) return fail();
      return ok(`${rest[2] === '@{u}..HEAD' ? wt.ahead : (wt.behind ?? 0)}\n`);
    }
    return fail();
  };
}

async function writeArtifacts(root: string, doc: string): Promise<void> {
  await fs.writeFile(path.join(root, SLUG, 'artifacts.yml'), doc, 'utf8');
}

async function readArtifacts(root: string) {
  return readYaml(path.join(root, SLUG, 'artifacts.yml'), ArtifactsSchema);
}

afterEach(() => {
  resetRunners();
});

describe('sweepInitiative repo set', () => {
  it('dedupes the brief worktree, the recorded repo, and cwd into one entry', async () => {
    await withTempActiveRoot(async (root) => {
      setGitRunner(makeGitRunner({}));
      const res = await sweepInitiative(SLUG, root, SAMPLE_REPO);
      expect(res.repos).toEqual([SAMPLE_REPO]);
    });
  });

  it('adds cwd as its own repo when it is not already known', async () => {
    await withTempActiveRoot(async (root) => {
      setGitRunner(makeGitRunner({}));
      const res = await sweepInitiative(SLUG, root, '/tmp/elsewhere');
      expect(res.repos).toEqual([SAMPLE_REPO, '/tmp/elsewhere']);
    });
  });

  it('skips org/repo values that have no local clone', async () => {
    await withTempActiveRoot(async (root) => {
      // The registered worktree seeds the repo set. It lives in artifacts.yml
      // since v4 (AW-67), so overwriting the file must carry it along.
      await writeArtifacts(
        root,
        [
          'branches:',
          '  - repo: acme/widgets',
          '    name: main',
          'stashes: []',
          'worktrees:',
          '  - path: ~/code/sample',
          '    repo: ~/code/sample',
          '    name: main',
          '    default: true',
          '',
        ].join('\n'),
      );
      setGitRunner(makeGitRunner({}));
      const res = await sweepInitiative(SLUG, root, '/tmp/elsewhere');
      // Only the registered worktree and cwd remain; `acme/widgets` has no path.
      expect(res.repos).toEqual([SAMPLE_REPO, '/tmp/elsewhere']);
    });
  });
});

describe('sweepInitiative detection', () => {
  it('reports a live worktree that artifacts.yml does not carry', async () => {
    await withTempActiveRoot(async (root) => {
      setGitRunner(
        makeGitRunner({
          [SAMPLE_REPO]: {
            worktrees: [
              { path: SAMPLE_REPO, branch: 'main', ahead: 0, unpushed: 0 },
              {
                path: '/tmp/wt-feature',
                branch: 'feat/new',
                dirty: 3,
                ahead: 2,
                unpushed: 2,
              },
            ],
          },
        }),
      );
      const res = await sweepInitiative(SLUG, root, SAMPLE_REPO);
      // The registered worktree is already in artifacts.yml, so only the
      // genuinely unrecorded one is reported (AW-67) — before the collapse it
      // was recorded in the brief and re-appended here as if new.
      expect(res.unrecorded.worktrees).toEqual([
        { path: '/tmp/wt-feature', repo: '~/code/sample', branch: 'feat/new' },
      ]);
      expect(res.dirty).toEqual([
        { path: '/tmp/wt-feature', repo: '~/code/sample', files_changed: 3 },
      ]);
      expect(res.unpushed).toEqual([
        {
          path: '/tmp/wt-feature',
          repo: '~/code/sample',
          branch: 'feat/new',
          ahead: 2,
          no_upstream: false,
        },
      ]);
    });
  });

  it('leaves an already-recorded worktree out, matching on path', async () => {
    await withTempActiveRoot(async (root) => {
      await writeArtifacts(
        root,
        [
          'branches: []',
          'stashes: []',
          'worktrees:',
          '  - path: /tmp/wt-feature',
          '    repo: ~/code/sample',
          '    branch: feat/new',
          '    holding: half-done migration',
          '',
        ].join('\n'),
      );
      setGitRunner(
        makeGitRunner({
          [SAMPLE_REPO]: {
            worktrees: [
              { path: '/tmp/wt-feature', branch: 'feat/new', dirty: 1, ahead: 1, unpushed: 1 },
            ],
          },
        }),
      );
      const res = await sweepInitiative(SLUG, root, SAMPLE_REPO);
      expect(res.unrecorded.worktrees).toEqual([]);
      expect(res.dirty).toHaveLength(1);
    });
  });

  it('records only branches carrying unpushed or uncommitted work', async () => {
    await withTempActiveRoot(async (root) => {
      setGitRunner(
        makeGitRunner({
          [SAMPLE_REPO]: {
            worktrees: [
              { path: SAMPLE_REPO, branch: 'main', ahead: 0, unpushed: 0 },
              { path: '/tmp/wt-a', branch: 'feat/ahead', ahead: 3, unpushed: 3 },
              { path: '/tmp/wt-b', branch: 'feat/dirty', dirty: 2, ahead: 0, unpushed: 0 },
              { path: '/tmp/wt-c', branch: 'feat/sample', ahead: 5, unpushed: 5 },
            ],
          },
        }),
      );
      const res = await sweepInitiative(SLUG, root, SAMPLE_REPO);
      // feat/sample is already in the fixture's artifacts.yml; main is clean.
      expect(res.unrecorded.branches).toEqual([
        { repo: '~/code/sample', name: 'feat/ahead' },
        { repo: '~/code/sample', name: 'feat/dirty' },
      ]);
    });
  });

  it('reports live stashes and skips ones already recorded by sha or label', async () => {
    await withTempActiveRoot(async (root) => {
      await writeArtifacts(
        root,
        [
          'branches: []',
          'stashes:',
          '  - repo: ~/code/sample',
          '    label: "WIP on main: known"',
          '    sha: aaa111',
          '  - repo: ~/code/sample',
          '    label: "WIP on main: no sha recorded"',
          '',
        ].join('\n'),
      );
      setGitRunner(
        makeGitRunner({
          [SAMPLE_REPO]: {
            worktrees: [{ path: SAMPLE_REPO, branch: 'main', ahead: 0, unpushed: 0 }],
            stashes: [
              { sha: 'aaa111', label: 'WIP on main: known' },
              { sha: 'bbb222', label: 'WIP on main: no sha recorded' },
              { sha: 'ccc333', label: 'WIP on main: brand new' },
            ],
          },
        }),
      );
      const res = await sweepInitiative(SLUG, root, SAMPLE_REPO);
      expect(res.unrecorded.stashes).toEqual([
        { repo: '~/code/sample', label: 'WIP on main: brand new', sha: 'ccc333' },
      ]);
    });
  });

  it('degrades to nothing when the repo has moved', async () => {
    await withTempActiveRoot(async (root) => {
      setGitRunner(makeGitRunner({}));
      const res = await sweepInitiative(SLUG, root, SAMPLE_REPO);
      expect(res.unrecorded).toEqual({ worktrees: [], branches: [], stashes: [] });
      expect(res.dirty).toEqual([]);
      expect(res.unpushed).toEqual([]);
    });
  });

  it('does not throw when every git call errors out', async () => {
    await withTempActiveRoot(async (root) => {
      setGitRunner(async () => {
        throw new Error('git exploded');
      });
      await expect(sweepInitiative(SLUG, root, SAMPLE_REPO)).resolves.toBeTruthy();
    });
  });
});

describe('sweepInitiative upstream semantics', () => {
  /** ahead undefined = no upstream at all. */
  async function sweepOne(root: string, wt: FakeWorktree) {
    setGitRunner(makeGitRunner({ [SAMPLE_REPO]: { worktrees: [wt] } }));
    return sweepInitiative(SLUG, root, SAMPLE_REPO);
  }

  it('treats a branch with no upstream as unpushed and records it', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await sweepOne(root, {
        path: SAMPLE_REPO,
        branch: 'feat/never-pushed',
        unpushed: 15,
      });
      expect(res.unpushed).toEqual([
        {
          path: SAMPLE_REPO,
          repo: '~/code/sample',
          branch: 'feat/never-pushed',
          ahead: 15,
          no_upstream: true,
        },
      ]);
      expect(res.unrecorded.branches).toEqual([
        { repo: '~/code/sample', name: 'feat/never-pushed' },
      ]);
    });
  });

  it('leaves a tracked branch with nothing to push alone', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await sweepOne(root, {
        path: SAMPLE_REPO,
        branch: 'main',
        ahead: 0,
        unpushed: 0,
      });
      expect(res.unpushed).toEqual([]);
      expect(res.unrecorded.branches).toEqual([]);
    });
  });

  it('reports a tracked branch that is N ahead as unpushed, not never-pushed', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await sweepOne(root, {
        path: SAMPLE_REPO,
        branch: 'feat/ahead',
        ahead: 3,
        unpushed: 3,
      });
      expect(res.unpushed).toEqual([
        {
          path: SAMPLE_REPO,
          repo: '~/code/sample',
          branch: 'feat/ahead',
          ahead: 3,
          no_upstream: false,
        },
      ]);
    });
  });

  it('distinguishes no upstream from zero ahead — the regression', async () => {
    await withTempActiveRoot(async (root) => {
      const noUpstream = await sweepOne(root, {
        path: SAMPLE_REPO,
        branch: 'feat/never-pushed',
        unpushed: 15,
      });
      const zeroAhead = await sweepOne(root, {
        path: SAMPLE_REPO,
        branch: 'main',
        ahead: 0,
        unpushed: 0,
      });
      expect(noUpstream.unpushed).toHaveLength(1);
      expect(zeroAhead.unpushed).toHaveLength(0);
    });
  });

  it('still flags a never-pushed branch when the commit count cannot be taken', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await sweepOne(root, { path: SAMPLE_REPO, branch: 'feat/unknown' });
      expect(res.unpushed).toHaveLength(1);
      expect(res.unpushed[0]!.no_upstream).toBe(true);
    });
  });

  // AW-73: an unreadable tree used to read exactly like a clean one, so wrap
  // said nothing about a worktree that may well have held uncommitted work.
  it('surfaces a tree git could not read instead of treating it as clean', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await sweepOne(root, {
        path: SAMPLE_REPO,
        branch: 'feat/unreadable',
        statusFails: true,
        ahead: 0,
        unpushed: 0,
      });
      expect(res.dirty).toEqual([
        { path: SAMPLE_REPO, repo: '~/code/sample', files_changed: null },
      ]);
      // Unknown dirt is enough to make the branch worth recording, even though
      // there is nothing to push.
      expect(res.unrecorded.branches).toEqual([{ repo: '~/code/sample', name: 'feat/unreadable' }]);
    });
  });

  it('leaves a readable clean tree out of the dirty list', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await sweepOne(root, {
        path: SAMPLE_REPO,
        branch: 'main',
        ahead: 0,
        unpushed: 0,
      });
      expect(res.dirty).toEqual([]);
    });
  });

  it('falls back to ahead when the remote-wide count fails on a tracked branch', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await sweepOne(root, { path: SAMPLE_REPO, branch: 'feat/ahead', ahead: 4 });
      expect(res.unpushed).toEqual([
        {
          path: SAMPLE_REPO,
          repo: '~/code/sample',
          branch: 'feat/ahead',
          ahead: 4,
          no_upstream: false,
        },
      ]);
    });
  });
});

describe('sweepInitiative repo-set dedupe', () => {
  const LINKED = '/tmp/wt-linked';

  /**
   * `git worktree list` answers identically from any worktree of a repo, so a
   * repo set holding both the main checkout and a linked worktree sweeps the
   * same repository twice.
   */
  function setSharedRepoGit(): void {
    const shared: FakeRepo = {
      worktrees: [
        { path: SAMPLE_REPO, branch: 'main', ahead: 0, unpushed: 0 },
        { path: LINKED, branch: 'feat/linked', dirty: 2, ahead: 1, unpushed: 1 },
      ],
      stashes: [{ sha: 'aaa111', label: 'WIP on main: one stash' }],
    };
    setGitRunner(makeGitRunner({ [SAMPLE_REPO]: shared, [LINKED]: shared }));
  }

  it('counts one repository and each worktree, branch, and stash exactly once', async () => {
    await withTempActiveRoot(async (root) => {
      setSharedRepoGit();
      const res = await sweepInitiative(SLUG, root, LINKED);
      expect(res.repos).toEqual([SAMPLE_REPO]);
      // SAMPLE_REPO is the registered worktree, already recorded (AW-67).
      expect(res.unrecorded.worktrees.map((w) => w.path)).toEqual([LINKED]);
      expect(res.unrecorded.branches).toEqual([{ repo: '~/code/sample', name: 'feat/linked' }]);
      expect(res.unrecorded.stashes).toHaveLength(1);
      expect(res.dirty).toHaveLength(1);
      expect(res.unpushed).toHaveLength(1);
    });
  });

  it('never grows artifacts.yml across repeated sweep + record cycles', async () => {
    await withTempActiveRoot(async (root) => {
      setSharedRepoGit();
      const cycle = async (): Promise<string> => {
        const res = await sweepInitiative(SLUG, root, LINKED);
        await recordUnrecorded(SLUG, root, res.unrecorded);
        return fs.readFile(path.join(root, SLUG, 'artifacts.yml'), 'utf8');
      };
      const first = await cycle();
      const second = await cycle();
      expect(second).toBe(first);

      const artifacts = await readArtifacts(root);
      expect(artifacts.worktrees).toHaveLength(2);
      expect(artifacts.stashes).toHaveLength(1);
      expect(artifacts.branches).toHaveLength(2);
    });
  });
});

describe('recordUnrecorded', () => {
  it('appends to artifacts.yml without dropping existing entries', async () => {
    await withTempActiveRoot(async (root) => {
      const added = await recordUnrecorded(SLUG, root, {
        worktrees: [{ path: '/tmp/wt-feature', repo: '~/code/sample', branch: 'feat/new' }],
        branches: [{ repo: '~/code/sample', name: 'feat/other' }],
        stashes: [{ repo: '~/code/sample', label: 'WIP', sha: 'ddd444' }],
      });
      expect(added).toEqual({ worktrees: 1, branches: 1, stashes: 1 });

      const artifacts = await readArtifacts(root);
      expect(artifacts.branches).toEqual([
        {
          repo: '~/code/sample',
          name: 'feat/sample',
          note: 'scaffolding for sample initiative',
        },
        { repo: '~/code/sample', name: 'feat/other' },
      ]);
      expect(artifacts.stashes).toHaveLength(1);
      expect(artifacts.worktrees).toEqual([
        // The fixture's registered worktree survives the append.
        { path: '~/code/sample', repo: '~/code/sample', name: 'main', default: true },
        { path: '/tmp/wt-feature', repo: '~/code/sample', branch: 'feat/new' },
      ]);
    });
  });

  it('leaves holding unset so the agent supplies it', async () => {
    await withTempActiveRoot(async (root) => {
      await recordUnrecorded(SLUG, root, {
        worktrees: [{ path: '/tmp/wt-feature', repo: '~/code/sample', branch: 'feat/new' }],
        branches: [],
        stashes: [],
      });
      const artifacts = await readArtifacts(root);
      expect(artifacts.worktrees[0]).not.toHaveProperty('holding');
    });
  });

  it('is a no-op that does not rewrite the file when nothing is unrecorded', async () => {
    await withTempActiveRoot(async (root) => {
      const file = path.join(root, SLUG, 'artifacts.yml');
      const before = await fs.readFile(file, 'utf8');
      const added = await recordUnrecorded(SLUG, root, {
        worktrees: [],
        branches: [{ repo: '~/code/sample', name: 'feat/sample' }],
        stashes: [],
      });
      expect(added).toEqual({ worktrees: 0, branches: 0, stashes: 0 });
      expect(await fs.readFile(file, 'utf8')).toBe(before);
    });
  });

  it('matches recorded branches across repo spellings', async () => {
    await withTempActiveRoot(async (root) => {
      const added = await recordUnrecorded(SLUG, root, {
        worktrees: [],
        branches: [{ repo: SAMPLE_REPO, name: 'feat/sample' }],
        stashes: [],
      });
      expect(added.branches).toBe(0);
    });
  });

  it('creates artifacts.yml when the initiative has none', async () => {
    await withTempActiveRoot(async (root) => {
      await fs.rm(path.join(root, SLUG, 'artifacts.yml'));
      const added = await recordUnrecorded(SLUG, root, {
        worktrees: [],
        branches: [{ repo: '~/code/sample', name: 'feat/new' }],
        stashes: [],
      });
      expect(added.branches).toBe(1);
      expect((await readArtifacts(root)).branches).toHaveLength(1);
    });
  });
});
