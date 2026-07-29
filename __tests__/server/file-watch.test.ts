/**
 * Unit tests for the recursive file watcher. These use a real temp dir and
 * real `fs.watch`, so they assert on observable behavior (a callback fires
 * after a write) rather than watcher internals. Generous timeouts absorb the
 * platform's watch latency; the debounce is kept short to keep tests fast.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { watchTree, type TreeWatcher } from '../../src/server/file-watch.js';

const DEBOUNCE = 40;

let dir: string;
let watcher: TreeWatcher | null = null;
let counter = 0;

/** Poll `cond` (which may itself trigger work) until true or the deadline. */
async function pollUntil(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

afterEach(() => {
  watcher?.close();
  watcher = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/*
 * AW-70: every test here poll-writes rather than writing once.
 *
 * A single write racing `watchTree` was the whole flake. Attaching the watch is
 * load-dependent, and a write landing before the watch is attached is not
 * merely late — it is lost, and nothing fires afterward, so the test waited out
 * its full timeout for an event that could never come. Re-writing makes the
 * assertion "the watcher observes writes" rather than "the watcher was ready
 * within N ms of construction", which is not a property the watcher promises.
 */
describe('watchTree', () => {
  it('fires when a file at the root changes', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'aw-watch-'));

    let count = 0;
    watcher = watchTree(dir, () => (count += 1), { debounceMs: DEBOUNCE });
    const observed = await pollUntil(
      async () => {
        writeFileSync(path.join(dir, 'brief.md'), `hello-${counter++}`);
        return count > 0;
      },
      4000,
      DEBOUNCE * 2,
    );
    expect(observed).toBe(true);
  });

  it('fires when a file in a nested subdirectory changes', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'aw-watch-'));
    const nested = path.join(dir, 'initiative', 'tasks');
    mkdirSync(nested, { recursive: true });

    let count = 0;
    watcher = watchTree(dir, () => (count += 1), { debounceMs: DEBOUNCE });
    const observed = await pollUntil(
      async () => {
        writeFileSync(path.join(nested, 'AW-1.yml'), `id: AW-${counter++}`);
        return count > 0;
      },
      4000,
      DEBOUNCE * 2,
    );
    expect(observed).toBe(true);
  });

  it('picks up directories created after the watcher starts', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'aw-watch-'));

    let count = 0;
    watcher = watchTree(dir, () => (count += 1), { debounceMs: DEBOUNCE });

    const fresh = path.join(dir, 'new-initiative');
    mkdirSync(fresh);

    // A rescan is only ever scheduled by a change on an already-watched dir, so
    // the mkdir above is the sole event that can attach a watch to `fresh`.
    // Losing it to the attach race wedges the test permanently: every later
    // write goes inside `fresh`, which nothing is watching yet. Drive writes at
    // the ROOT first — they prove the watcher is live and re-trigger the rescan,
    // so a missed mkdir cannot deadlock the assertion.
    const live = await pollUntil(
      async () => {
        writeFileSync(path.join(dir, `tick-${counter++}.md`), 'tick');
        return count > 0;
      },
      4000,
      DEBOUNCE * 2,
    );
    expect(live).toBe(true);

    // Let the rescan settle so a leftover debounce cannot be mistaken below for
    // an event originating inside `fresh`.
    await new Promise((r) => setTimeout(r, DEBOUNCE * 4));

    const attached = await pollUntil(
      async () => {
        const before = count;
        writeFileSync(path.join(fresh, `f-${counter++}.md`), 'state');
        await new Promise((r) => setTimeout(r, DEBOUNCE * 3));
        return count > before;
      },
      4000,
      DEBOUNCE,
    );
    expect(attached).toBe(true);
  });

  it('stops firing after close()', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'aw-watch-'));
    let count = 0;
    watcher = watchTree(dir, () => (count += 1), { debounceMs: DEBOUNCE });
    watcher.close();
    watcher = null;

    writeFileSync(path.join(dir, 'brief.md'), 'hello');
    await new Promise((r) => setTimeout(r, DEBOUNCE * 6));
    expect(count).toBe(0);
  });
});
