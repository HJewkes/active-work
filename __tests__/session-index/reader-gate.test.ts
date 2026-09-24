import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReaderGate } from '../../src/session-index/reader-gate.js';

afterEach(() => {
  vi.useRealTimers();
});

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

describe('reader gate', () => {
  it('idle resolves at once when no reader is in flight', async () => {
    vi.useFakeTimers();
    const gate = createReaderGate();

    expect(await settled(gate.idle(5_000))).toBe(true);
  });

  it('idle waits while a reader is in flight and resumes when it releases', async () => {
    vi.useFakeTimers();
    const gate = createReaderGate();
    const release = gate.enter();

    const idle = gate.idle(5_000);
    const whileReading = await settled(idle);
    release();

    expect(whileReading).toBe(false);
    expect(await settled(idle)).toBe(true);
  });

  it('idle keeps waiting until the last of several readers releases', async () => {
    vi.useFakeTimers();
    const gate = createReaderGate();
    const first = gate.enter();
    const second = gate.enter();
    const idle = gate.idle(5_000);

    first();
    first();
    const afterOne = await settled(idle);
    second();

    expect(afterOne).toBe(false);
    expect(await settled(idle)).toBe(true);
  });

  it('the pass resumes only after the released reader has finished replying', async () => {
    const gate = createReaderGate();
    const release = gate.enter();
    const order: string[] = [];
    const pass = gate.idle(5_000).then(() => order.push('pass'));

    const reader = (async () => {
      release();
      await null;
      await null;
      order.push('reader replied');
    })();
    await Promise.all([pass, reader]);

    expect(order).toEqual(['reader replied', 'pass']);
  });

  it('idle gives up after its cap', async () => {
    vi.useFakeTimers();
    const gate = createReaderGate();
    gate.enter();
    const idle = gate.idle(5_000);

    await vi.advanceTimersByTimeAsync(4_999);
    const beforeCap = await settled(idle);
    await vi.advanceTimersByTimeAsync(1);

    expect(beforeCap).toBe(false);
    expect(await settled(idle)).toBe(true);
  });
});
