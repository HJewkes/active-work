import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import { toHealthIndexState } from '../../src/server/daemon.js';
import { measureLoopStall } from '../../src/server/session-index-watch.js';

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until);
}

describe('event-loop stall gauge', () => {
  it('a pass that blocks the loop reports the length of the block', async () => {
    const { result, maxStallMs } = await measureLoopStall(async () => {
      await sleep(30);
      busyWait(300);
      await sleep(30);
      return 'done';
    });

    expect(result).toBe('done');
    expect(maxStallMs).toBeGreaterThanOrEqual(250);
  });

  it('a pass that keeps yielding reports no long stall', async () => {
    const { maxStallMs } = await measureLoopStall(async () => {
      for (let i = 0; i < 10; i++) {
        busyWait(5);
        await sleep(15);
      }
    });

    expect(maxStallMs).toBeLessThan(150);
  });

  it('/health index carries the longest stall of the last pass', () => {
    const index = toHealthIndexState({
      running: false,
      pending: false,
      last: null,
      lastError: null,
      consecutiveErrors: 0,
      lastMaxLoopStallMs: 412,
    });

    expect(index).toMatchObject({ indexing: false, lastMaxLoopStallMs: 412 });
  });
});
