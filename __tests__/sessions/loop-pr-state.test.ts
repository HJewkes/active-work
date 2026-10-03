import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_PR_CHECKS_PER_CALL,
  clearPrStateCache,
  findMergedPrLoops,
} from '../../src/sessions/loop-pr-state.js';
import type { OpenLoop } from '../../src/sessions/open-loops.js';
import { resetRunners, setGhRunner, type CommandRunner } from '../../src/utils/git-gh.js';

const MINUTE_MS = 60_000;
/** No test here files a bare PR number, so the initiative directory is never read. */
const NO_INITIATIVE = '/nonexistent';

function prLoop(number: number, repo = 'acme/widgets'): OpenLoop {
  return {
    ref: `2026-07-20-1000-sess-a#pr-${repo}-${number}`,
    text: `follow up on ${number}`,
    kind: 'pr',
    targetRef: `${repo}#${number}`,
    sessionFile: '2026-07-20-1000-sess-a',
    sessionId: 'sess-a',
    openedAt: '2026-07-20T10:00:00Z',
    ageDays: 0,
  };
}

/** A `gh` that records each PR asked about and answers with `reply`. */
function recordingGh(reply: (key: string) => string | Error) {
  const calls: string[] = [];
  const runner: CommandRunner = (_bin, args) => {
    const key = `${args[4]}#${args[2]}`;
    calls.push(key);
    const answer = reply(key);
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve({ code: 0, stdout: JSON.stringify({ state: answer }), stderr: '' });
  };
  setGhRunner(runner);
  return calls;
}

function clockAt(start: number) {
  const clock = { ms: start, now: () => clock.ms };
  return clock;
}

afterEach(() => {
  resetRunners();
  clearPrStateCache();
});

describe('findMergedPrLoops cache', () => {
  it('answers a repeat call from the cache, for merged and unmerged PRs alike', async () => {
    const calls = recordingGh((key) => (key === 'acme/widgets#1' ? 'MERGED' : 'OPEN'));
    const loops = [prLoop(1), prLoop(2)];
    const clock = clockAt(0);

    const first = await findMergedPrLoops(NO_INITIATIVE, loops, clock);
    clock.ms += 4 * MINUTE_MS;
    const second = await findMergedPrLoops(NO_INITIATIVE, loops, clock);

    expect(calls.sort()).toEqual(['acme/widgets#1', 'acme/widgets#2']);
    expect([...second.merged]).toEqual([...first.merged]);
    expect([...second.merged]).toEqual([loops[0]!.ref]);
  });

  it('caches a failure, so an offline process does not retry on every call', async () => {
    const calls = recordingGh(() => new Error('connect ENETUNREACH api.github.com'));
    const clock = clockAt(0);

    await findMergedPrLoops(NO_INITIATIVE, [prLoop(1)], clock);
    clock.ms += MINUTE_MS;
    const second = await findMergedPrLoops(NO_INITIATIVE, [prLoop(1)], clock);

    expect(calls).toEqual(['acme/widgets#1']);
    expect(second.merged.size).toBe(0);
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings[0]).toMatch(/Could not check 1 PR\(s\).*ENETUNREACH/);
  });

  it('asks again once the entry is five minutes old', async () => {
    let state = 'OPEN';
    const calls = recordingGh(() => state);
    const clock = clockAt(0);

    const first = await findMergedPrLoops(NO_INITIATIVE, [prLoop(1)], clock);
    state = 'MERGED';
    clock.ms += 5 * MINUTE_MS;
    const second = await findMergedPrLoops(NO_INITIATIVE, [prLoop(1)], clock);

    expect(calls).toHaveLength(2);
    expect(first.merged.size).toBe(0);
    expect(second.merged.size).toBe(1);
  });

  it('treats owner/repo case variants as one PR', async () => {
    const calls = recordingGh(() => 'MERGED');
    const clock = clockAt(0);

    await findMergedPrLoops(NO_INITIATIVE, [prLoop(1, 'acme/widgets')], clock);
    const second = await findMergedPrLoops(NO_INITIATIVE, [prLoop(1, 'Acme/Widgets')], clock);

    expect(calls).toHaveLength(1);
    expect(second.merged.size).toBe(1);
  });
});

describe('findMergedPrLoops per-call cap', () => {
  const OVER = 2;
  const manyLoops = (): OpenLoop[] =>
    Array.from({ length: MAX_PR_CHECKS_PER_CALL + OVER }, (_, i) => prLoop(i + 1));

  it('asks gh about at most the cap and leaves the rest unmarked with one warning', async () => {
    const calls = recordingGh(() => 'MERGED');

    const result = await findMergedPrLoops(NO_INITIATIVE, manyLoops(), clockAt(0));

    expect(calls).toHaveLength(MAX_PR_CHECKS_PER_CALL);
    expect(result.merged.size).toBe(MAX_PR_CHECKS_PER_CALL);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(new RegExp(`waiting on ${OVER} more are left unmarked`));
  });

  it('spends the next call on the PRs the cap left out, not on cached ones', async () => {
    const calls = recordingGh(() => 'MERGED');
    const loops = manyLoops();
    const clock = clockAt(0);

    await findMergedPrLoops(NO_INITIATIVE, loops, clock);
    const second = await findMergedPrLoops(NO_INITIATIVE, loops, clock);

    expect(calls).toHaveLength(loops.length);
    expect(new Set(calls).size).toBe(loops.length);
    expect(second.merged.size).toBe(loops.length);
    expect(second.warnings).toEqual([]);
  });

  it('counts a PR once however many loops wait on it', async () => {
    const calls = recordingGh(() => 'MERGED');
    const loops = manyLoops().slice(0, MAX_PR_CHECKS_PER_CALL);
    const twin = { ...prLoop(1), ref: '2026-07-21-1000-sess-b#twin' };

    const result = await findMergedPrLoops(NO_INITIATIVE, [...loops, twin], clockAt(0));

    expect(calls).toHaveLength(MAX_PR_CHECKS_PER_CALL);
    expect(result.merged.has(twin.ref)).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
