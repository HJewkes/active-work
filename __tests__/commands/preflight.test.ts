import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import preflightCmd from '../../src/commands/preflight.js';
import { resetRunners, setGitRunner } from '../../src/utils/git-gh.js';
import { NotFoundError } from '../../src/errors.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';
const SAMPLE_REPO = path.join(os.homedir(), 'code', 'sample');

function context(activeRoot: string) {
  return { activeRoot, warnings: [] as string[], format: 'json' as const };
}

/** One repo, one dirty and unpushed worktree that artifacts.yml never heard of. */
function setLiveGit(): void {
  setGitRunner(async (_bin, args) => {
    const rest = args.slice(2);
    if (rest[0] === 'worktree' && args[1] === SAMPLE_REPO) {
      return {
        code: 0,
        stdout: 'worktree /tmp/wt-live\nHEAD abc123\nbranch refs/heads/feat/live\n',
        stderr: '',
      };
    }
    if (args[1] !== '/tmp/wt-live') return { code: 1, stdout: '', stderr: 'nope' };
    if (rest[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '' };
    if (rest[0] === 'rev-parse') return { code: 0, stdout: 'feat/live\n', stderr: '' };
    if (rest[0] === 'status') return { code: 0, stdout: ' M a\n M b\n', stderr: '' };
    if (rest[0] === 'rev-list') {
      // `--not --remotes` counts commits on no remote; the branch is 4 ahead of
      // its upstream and all four exist nowhere else.
      const count = rest[2] === 'HEAD..@{u}' ? '0' : '4';
      return { code: 0, stdout: `${count}\n`, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'nope' };
  });
}

afterEach(() => {
  resetRunners();
});

describe('preflight', () => {
  it('reports unrecorded, dirty, and unpushed state for the swept repos', async () => {
    await withTempActiveRoot(async (root) => {
      setLiveGit();
      const res = await preflightCmd.run({ slug: SLUG, cwd: SAMPLE_REPO }, context(root));
      expect(res.slug).toBe(SLUG);
      // The resolved repository, which git reports as the first worktree of
      // the set — not the path the sweep happened to be pointed at.
      expect(res.repos).toEqual(['/tmp/wt-live']);
      expect(res.unrecorded.worktrees).toEqual([
        { path: '/tmp/wt-live', repo: '~/code/sample', branch: 'feat/live' },
      ]);
      expect(res.unrecorded.branches).toEqual([
        { repo: '~/code/sample', name: 'feat/live' },
      ]);
      expect(res.dirty).toEqual([
        { path: '/tmp/wt-live', repo: '~/code/sample', files_changed: 2 },
      ]);
      expect(res.unpushed).toEqual([
        {
          path: '/tmp/wt-live',
          repo: '~/code/sample',
          branch: 'feat/live',
          ahead: 4,
          no_upstream: false,
        },
      ]);
    });
  });

  it('returns the categories a wrap has to answer', async () => {
    await withTempActiveRoot(async (root) => {
      setLiveGit();
      const res = await preflightCmd.run({ slug: SLUG, cwd: SAMPLE_REPO }, context(root));
      expect(res.checklist.length).toBeGreaterThan(0);
      const joined = res.checklist.join(' ');
      expect(joined).toMatch(/open loops/);
      expect(joined).toMatch(/notes/);
      expect(joined).toMatch(/tasks/);
      expect(joined).toMatch(/worktree/);
    });
  });

  it('writes nothing', async () => {
    await withTempActiveRoot(async (root) => {
      setLiveGit();
      const file = path.join(root, SLUG, 'artifacts.yml');
      const before = await fs.readFile(file, 'utf8');
      const beforeStat = await fs.stat(file);
      const briefBefore = await fs.readFile(path.join(root, SLUG, 'brief.md'), 'utf8');

      await preflightCmd.run({ slug: SLUG, cwd: SAMPLE_REPO }, context(root));

      expect(await fs.readFile(file, 'utf8')).toBe(before);
      expect((await fs.stat(file)).mtimeMs).toBe(beforeStat.mtimeMs);
      expect(await fs.readFile(path.join(root, SLUG, 'brief.md'), 'utf8')).toBe(briefBefore);
    });
  });

  it('rejects an unknown initiative', async () => {
    await withTempActiveRoot(async (root) => {
      setLiveGit();
      await expect(
        preflightCmd.run({ slug: 'nope', cwd: SAMPLE_REPO }, context(root)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('validates its own result shape', async () => {
    await withTempActiveRoot(async (root) => {
      setLiveGit();
      const res = await preflightCmd.run({ slug: SLUG, cwd: SAMPLE_REPO }, context(root));
      expect(preflightCmd.result.safeParse(res).success).toBe(true);
    });
  });
});
