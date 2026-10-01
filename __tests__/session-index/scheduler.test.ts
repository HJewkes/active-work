import { describe, expect, it, vi } from 'vitest';
import { RefreshScheduler } from '../../src/session-index/scheduler.js';
import type { RefreshSummary } from '../../src/session-index/refresh.js';

const summary = {} as RefreshSummary;

/** A fake clock whose sleep advances time and records each wait. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RefreshScheduler', () => {
  it('runs a burst of 100 triggers as one run plus one trailing run per window', async () => {
    const clock = fakeClock();
    const run = vi.fn(async () => summary);
    const scheduler = new RefreshScheduler(run, { ...clock, minIntervalMs: 15_000 });

    for (let i = 0; i < 100; i++) scheduler.trigger();
    await scheduler.close();
    await settle();

    expect(run.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('waits out the interval before a trailing run', async () => {
    const clock = fakeClock();
    const run = vi.fn(async () => {
      if (run.mock.calls.length === 1) scheduler.trigger();
      return summary;
    });
    const scheduler = new RefreshScheduler(run, { ...clock, minIntervalMs: 15_000 });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    expect(clock.sleeps).toEqual([15_000]);
  });

  it('skips an ELOCKED round without logging an error and retries with backoff', async () => {
    const clock = fakeClock();
    const locked = Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' });
    const run = vi
      .fn<() => Promise<RefreshSummary>>()
      .mockRejectedValueOnce(locked)
      .mockResolvedValue(summary);
    const onError = vi.fn();
    const onLockSkip = vi.fn();
    const scheduler = new RefreshScheduler(run, {
      ...clock,
      minIntervalMs: 0,
      onError,
      onLockSkip,
    });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    expect(onError).not.toHaveBeenCalled();
    expect(onLockSkip).toHaveBeenCalledWith(1);
    expect(clock.sleeps).toContain(1_000);
    expect(scheduler.status().lockSkips).toBe(1);
  });

  it('still reports a non-lock failure through onError', async () => {
    const clock = fakeClock();
    const run = vi.fn<() => Promise<RefreshSummary>>().mockRejectedValue(new Error('boom'));
    const onError = vi.fn();
    const scheduler = new RefreshScheduler(run, { ...clock, minIntervalMs: 0, onError });

    scheduler.trigger();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await scheduler.close();

    expect(scheduler.status().consecutiveErrors).toBe(1);
  });
});
