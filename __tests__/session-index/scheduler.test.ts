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
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RefreshScheduler', () => {
  it('runs a burst of 100 triggers as one run plus one trailing run a full window later', async () => {
    const clock = fakeClock();
    const run = vi.fn(async () => summary);
    const scheduler = new RefreshScheduler(run, { ...clock, minIntervalMs: 15_000 });

    for (let i = 0; i < 100; i++) scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await settle();

    expect(run).toHaveBeenCalledTimes(2);
    expect(clock.sleeps).toEqual([15_000]);
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

  it('leaves the idle gap after a pass that outlasts the interval', async () => {
    const clock = fakeClock();
    const run = vi.fn(async () => {
      clock.advance(40_000);
      if (run.mock.calls.length === 1) scheduler.trigger();
      return summary;
    });
    const scheduler = new RefreshScheduler(run, { ...clock, minIntervalMs: 15_000 });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    expect(clock.sleeps).toEqual([15_000]);
  });

  it('close() resolves promptly while a window wait is sleeping', async () => {
    const run = vi.fn(async () => summary);
    const scheduler = new RefreshScheduler(run, { minIntervalMs: 60_000 });

    scheduler.trigger();
    scheduler.trigger();
    await settle();
    const closed = await Promise.race([
      scheduler.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 1_000)),
    ]);

    expect(closed).toBe('closed');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('forgets lock skips and restarts the backoff after a successful pass', async () => {
    const clock = fakeClock();
    const locked = Object.assign(new Error('held'), { code: 'ELOCKED' });
    const run = vi
      .fn<() => Promise<RefreshSummary>>()
      .mockRejectedValueOnce(locked)
      .mockRejectedValueOnce(locked)
      .mockResolvedValueOnce(summary)
      .mockRejectedValueOnce(locked)
      .mockResolvedValue(summary);
    const scheduler = new RefreshScheduler(run, { ...clock, minIntervalMs: 0 });

    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    await settle();
    expect(scheduler.status().lockSkips).toBe(0);
    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(5));

    expect(clock.sleeps).toEqual([1_000, 2_000, 1_000]);
  });
});
