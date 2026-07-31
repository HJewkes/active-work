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
/** Internal budgets stay well under this so a slow box fails honestly. */
const TEST_TIMEOUT = 20_000;

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
 *
 * AW-44: the new-directory tests now wait on `whenWatching()`/`isWatching()` —
 * the watcher's real "this path is covered" signal — before asserting that a
 * write inside that path fires. Previously they chained two blind 4s polls,
 * whose worst case exceeded Vitest's default 5s test timeout, so under
 * full-suite load whichever subtest happened to be slow died on the timeout
 * rather than on a real assertion. Waiting on the actual readiness signal
 * removes the guesswork instead of widening the guess.
 */
describe('watchTree', () => {
  it(
    'fires when a file at the root changes',
    async () => {
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
    },
    TEST_TIMEOUT,
  );

  it(
    'fires when a file in a nested subdirectory changes',
    async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'aw-watch-'));
      const nested = path.join(dir, 'initiative', 'tasks');
      mkdirSync(nested, { recursive: true });

      let count = 0;
      watcher = watchTree(dir, () => (count += 1), { debounceMs: DEBOUNCE });

      // Pre-existing dirs are attached synchronously by `watchTree`, so this
      // is a state check, not a wait.
      expect(watcher.isWatching(nested)).toBe(true);

      const observed = await pollUntil(
        async () => {
          writeFileSync(path.join(nested, 'AW-1.yml'), `id: AW-${counter++}`);
          return count > 0;
        },
        4000,
        DEBOUNCE * 2,
      );
      expect(observed).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'picks up directories created after the watcher starts',
    async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'aw-watch-'));

      let count = 0;
      watcher = watchTree(dir, () => (count += 1), { debounceMs: DEBOUNCE });

      const fresh = path.join(dir, 'new-initiative');
      mkdirSync(fresh);

      // A rescan is only ever scheduled by a change on an already-watched dir,
      // so a lost mkdir event would wedge this forever. Ticking the root while
      // polling re-triggers the rescan, and the poll condition is the watcher's
      // own attach signal rather than elapsed time.
      const attached = await pollUntil(
        () => {
          writeFileSync(path.join(dir, `tick-${counter++}.md`), 'tick');
          return watcher!.isWatching(fresh);
        },
        4000,
        DEBOUNCE,
      );
      expect(attached).toBe(true);

      // Let any in-flight debounce from the root ticks drain so the assertion
      // below can only be satisfied by an event originating inside `fresh`.
      await new Promise((r) => setTimeout(r, DEBOUNCE * 4));

      const before = count;
      const observed = await pollUntil(
        async () => {
          writeFileSync(path.join(fresh, `f-${counter++}.md`), 'state');
          return count > before;
        },
        4000,
        DEBOUNCE * 2,
      );
      expect(observed).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'watches a directory created inside an already-watched subdirectory (AW-44)',
    async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'aw-watch-'));
      const initiative = path.join(dir, 'initiative');
      mkdirSync(initiative);

      let count = 0;
      watcher = watchTree(dir, () => (count += 1), { debounceMs: DEBOUNCE });
      expect(watcher.isWatching(initiative)).toBe(true);

      // The rescan used to skip descending into directories it was already
      // watching, so `initiative/tasks` never got a watcher and every task
      // write beneath it was invisible to the daemon.
      const tasks = path.join(initiative, 'tasks');
      mkdirSync(tasks);

      const attached = await pollUntil(
        () => {
          writeFileSync(path.join(initiative, `tick-${counter++}.md`), 'tick');
          return watcher!.isWatching(tasks);
        },
        4000,
        DEBOUNCE,
      );
      expect(attached).toBe(true);

      await new Promise((r) => setTimeout(r, DEBOUNCE * 4));

      const before = count;
      const observed = await pollUntil(
        async () => {
          writeFileSync(path.join(tasks, `AW-${counter++}.yml`), 'id: x');
          return count > before;
        },
        4000,
        DEBOUNCE * 2,
      );
      expect(observed).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'whenWatching resolves for a directory created after the watcher starts',
    async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'aw-watch-'));
      let count = 0;
      watcher = watchTree(dir, () => (count += 1), { debounceMs: DEBOUNCE });

      const fresh = path.join(dir, 'late');
      mkdirSync(fresh);

      const pending = watcher.whenWatching(fresh, 4000);
      // Keep the rescan loop alive in case the mkdir event itself was lost.
      const ticker = setInterval(() => {
        try {
          writeFileSync(path.join(dir, `tick-${counter++}.md`), 'tick');
        } catch {
          /* dir torn down */
        }
      }, DEBOUNCE);
      const ok = await pending;
      clearInterval(ticker);

      expect(ok).toBe(true);
      expect(watcher.isWatching(fresh)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'whenWatching resolves false once the watcher is closed',
    async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'aw-watch-'));
      const w = watchTree(dir, () => undefined, { debounceMs: DEBOUNCE });
      const pending = w.whenWatching(path.join(dir, 'never'), 4000);
      w.close();
      await expect(pending).resolves.toBe(false);
    },
    TEST_TIMEOUT,
  );

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
