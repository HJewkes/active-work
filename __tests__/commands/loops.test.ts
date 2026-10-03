import { afterEach, describe, expect, it } from 'vitest';

import loopsCmd from '../../src/commands/loops.js';
import type { NextStep } from '../../src/schemas/session.js';
import { clearPrStateCache } from '../../src/sessions/loop-pr-state.js';
import { writeSessionFile } from '../../src/sessions/session-file.js';
import {
  resetRunners,
  setGhRunner,
  setGitRunner,
  type CommandRunner,
} from '../../src/utils/git-gh.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';
const OPENED = '2026-07-20T10:00:00Z';
const PAST = '2026-07-21T00:00:00Z';
const FAR_FUTURE = '2999-01-01T00:00:00Z';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

async function openLoops(root: string, steps: Array<Omit<NextStep, 'text'>>): Promise<void> {
  await writeSessionFile({
    slug: SLUG,
    activeRoot: root,
    session_id: 'sess-a',
    started: OPENED,
    ended: OPENED,
    track: 'canonical',
    body: 'narrative\n',
    next_steps: steps.map((step) => ({ text: `do ${step.id}`, ...step })),
  });
}

async function list(root: string, overrides: Record<string, unknown> = {}) {
  const ctx = makeCtx(root);
  const result = await loopsCmd.run(loopsCmd.args.parse({ slug: SLUG, ...overrides }), ctx);
  const byId = new Map(result.open.map((loop) => [loop.ref.split('#')[1]!, loop]));
  return { result, byId, warnings: ctx.warnings };
}

/** Answers `gh pr view <n> --repo <repo> --json state` from a table; anything else fails. */
function ghWithStates(states: Record<string, string>): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: CommandRunner = (_bin, args) => {
    const key = `${args[4]}#${args[2]}`;
    calls.push(key);
    const state = states[key];
    return Promise.resolve(
      state === undefined
        ? { code: 1, stdout: '', stderr: 'no pull requests found' }
        : { code: 0, stdout: JSON.stringify({ state }), stderr: '' },
    );
  };
  return { runner, calls };
}

const GH_OFFLINE: CommandRunner = () =>
  Promise.reject(new Error('connect ENETUNREACH api.github.com'));

/** The fixture's one recorded repo resolves to `acme/sample`. */
const GIT_REMOTE: CommandRunner = () =>
  Promise.resolve({ code: 0, stdout: 'git@github.com:acme/sample.git\n', stderr: '' });

afterEach(() => {
  resetRunners();
  clearPrStateCache();
});

describe('loops trigger marking', () => {
  it('marks a loop whose due time has passed and leaves a future one unmarked', async () => {
    await withTempActiveRoot(async (root) => {
      await openLoops(root, [
        { id: 'overdue', kind: 'prose', due: PAST },
        { id: 'later', kind: 'prose', due: FAR_FUTURE },
        { id: 'undated', kind: 'prose' },
      ]);

      const { byId } = await list(root);

      expect(byId.get('overdue')).toMatchObject({ due: PAST, trigger_met: ['due'] });
      expect(byId.get('later')?.trigger_met).toBeUndefined();
      expect(byId.get('undated')?.trigger_met).toBeUndefined();
    });
  });

  it('lists a loop whose task is done as trigger met rather than hiding it', async () => {
    await withTempActiveRoot(async (root) => {
      await openLoops(root, [
        { id: 'after-open-task', kind: 'task', ref: 'SI-1' },
        { id: 'after-done-task', kind: 'task', ref: 'SI-2' },
      ]);

      const { byId } = await list(root);

      expect(byId.get('after-done-task')?.trigger_met).toEqual(['task-done']);
      expect(byId.get('after-open-task')?.trigger_met).toBeUndefined();
    });
  });

  it('marks a pr loop whose PR GitHub reports merged', async () => {
    await withTempActiveRoot(async (root) => {
      const gh = ghWithStates({ 'acme/widgets#57': 'MERGED', 'acme/widgets#58': 'OPEN' });
      setGhRunner(gh.runner);
      await openLoops(root, [
        { id: 'by-url', kind: 'pr', ref: 'https://github.com/acme/widgets/pull/57' },
        { id: 'by-name', kind: 'pr', ref: 'acme/widgets#57' },
        { id: 'still-open', kind: 'pr', ref: 'acme/widgets#58' },
      ]);

      const { byId, warnings } = await list(root);

      expect(byId.get('by-url')?.trigger_met).toEqual(['pr-merged']);
      expect(byId.get('by-name')?.trigger_met).toEqual(['pr-merged']);
      expect(byId.get('still-open')?.trigger_met).toBeUndefined();
      expect(gh.calls.sort()).toEqual(['acme/widgets#57', 'acme/widgets#58']);
      expect(warnings).toEqual([]);
    });
  });

  it("places a bare PR number in the initiative's one recorded repo", async () => {
    await withTempActiveRoot(async (root) => {
      setGitRunner(GIT_REMOTE);
      setGhRunner(ghWithStates({ 'acme/sample#12': 'MERGED' }).runner);
      await openLoops(root, [{ id: 'bare', kind: 'pr', ref: '#12' }]);

      const { byId } = await list(root);

      expect(byId.get('bare')?.trigger_met).toEqual(['pr-merged']);
    });
  });

  it('does not let a merged PR mark a loop on the same number in another repo', async () => {
    await withTempActiveRoot(async (root) => {
      setGhRunner(ghWithStates({ 'acme/widgets#57': 'MERGED', 'acme/gears#57': 'OPEN' }).runner);
      await openLoops(root, [
        { id: 'widgets', kind: 'pr', ref: 'acme/widgets#57' },
        { id: 'gears', kind: 'pr', ref: 'acme/gears#57' },
      ]);

      const { byId } = await list(root);

      expect(byId.get('widgets')?.trigger_met).toEqual(['pr-merged']);
      expect(byId.get('gears')?.trigger_met).toBeUndefined();
    });
  });

  it('still lists every loop, with one warning, when GitHub is unreachable', async () => {
    await withTempActiveRoot(async (root) => {
      setGhRunner(GH_OFFLINE);
      await openLoops(root, [
        { id: 'pr-a', kind: 'pr', ref: 'acme/widgets#57' },
        { id: 'pr-b', kind: 'pr', ref: 'acme/widgets#58', due: PAST },
      ]);

      const { byId, warnings } = await list(root);

      expect(byId.get('pr-a')?.trigger_met).toBeUndefined();
      expect(byId.get('pr-b')?.trigger_met).toEqual(['due']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/Could not check 2 PR\(s\).*ENETUNREACH/);
    });
  });

  it('warns instead of guessing when a bare PR number has no single repo', async () => {
    await withTempActiveRoot(async (root) => {
      const gh = ghWithStates({});
      setGhRunner(gh.runner);
      setGitRunner(() => Promise.resolve({ code: 1, stdout: '', stderr: '' }));
      await openLoops(root, [{ id: 'bare', kind: 'pr', ref: '12' }]);

      const { byId, warnings } = await list(root);

      expect(byId.get('bare')?.trigger_met).toBeUndefined();
      expect(gh.calls).toEqual([]);
      expect(warnings[0]).toMatch(/Cannot tell which repo/);
    });
  });

  it('never calls gh with --offline', async () => {
    await withTempActiveRoot(async (root) => {
      const gh = ghWithStates({ 'acme/widgets#57': 'MERGED' });
      setGhRunner(gh.runner);
      await openLoops(root, [
        { id: 'pr-a', kind: 'pr', ref: 'acme/widgets#57' },
        { id: 'note', kind: 'prose' },
      ]);

      const { byId, warnings } = await list(root, { offline: true });

      expect(byId.get('pr-a')?.trigger_met).toBeUndefined();
      expect(gh.calls).toEqual([]);
      expect(warnings).toEqual([]);
    });
  });
});

describe('loops --due', () => {
  it('lists only the open loops whose trigger is met', async () => {
    await withTempActiveRoot(async (root) => {
      setGhRunner(ghWithStates({ 'acme/widgets#57': 'MERGED' }).runner);
      await openLoops(root, [
        { id: 'overdue', kind: 'prose', due: PAST },
        { id: 'later', kind: 'prose', due: FAR_FUTURE },
        { id: 'after-done-task', kind: 'task', ref: 'SI-2' },
        { id: 'merged', kind: 'pr', ref: 'acme/widgets#57' },
        { id: 'undated', kind: 'prose' },
      ]);

      const { result } = await list(root, { due: true });

      expect(result.open.map((loop) => loop.ref.split('#')[1]).sort()).toEqual([
        'after-done-task',
        'merged',
        'overdue',
      ]);
      expect(result.resolved).toEqual([]);
    });
  });

  it('returns nothing when no trigger is met', async () => {
    await withTempActiveRoot(async (root) => {
      await openLoops(root, [{ id: 'later', kind: 'prose', due: FAR_FUTURE }]);

      const { result } = await list(root, { due: true, state: 'all' });

      expect(result.open).toEqual([]);
      expect(result.resolved).toEqual([]);
    });
  });
});
