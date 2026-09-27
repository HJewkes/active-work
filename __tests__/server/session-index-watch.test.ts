import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startSessionIndexWatch } from '../../src/server/session-index-watch.js';
import type * as RefreshModule from '../../src/session-index/refresh.js';
import type { RefreshOptions, RefreshSummary } from '../../src/session-index/refresh.js';

const log = { info: vi.fn(), warn: vi.fn() };

let home: string;

beforeEach(() => {
  vi.restoreAllMocks();
  log.info.mockClear();
  log.warn.mockClear();
  home = mkdtempSync(path.join(os.tmpdir(), 'aw-index-watch-'));
  process.env.HOME = home;
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.AW_INDEX_WATCH;
  rmSync(home, { recursive: true, force: true });
});

describe('startSessionIndexWatch', () => {
  it('returns null and logs rather than throwing when the index cannot be opened', async () => {
    const graph = await import('../../src/session-index/graph.js');
    vi.spyOn(graph, 'openGraph').mockImplementation(() => {
      throw new Error('better-sqlite3 ABI mismatch');
    });

    expect(startSessionIndexWatch(log)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('transcript indexing disabled'),
    );
  });

  it('can be switched off entirely with AW_INDEX_WATCH=0', () => {
    process.env.AW_INDEX_WATCH = '0';

    expect(startSessionIndexWatch(log)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('starts a non-blocking initial refresh and closes cleanly', async () => {
    writeFileSync(path.join(home, 'ignored.txt'), 'x', 'utf8');

    const watcher = startSessionIndexWatch(log);

    expect(watcher).not.toBeNull();
    // Construction returns immediately; the refresh is un-awaited so the
    // daemon can bind its port before a cold corpus finishes indexing.
    expect(watcher!.status()).toMatchObject({ running: true });
    await watcher!.close();
    expect(watcher!.status()).toMatchObject({
      running: false,
      pending: false,
      lastMaxLoopStallMs: expect.any(Number),
    });
  });

  it('watches every discovered root', async () => {
    const roots = ['.claude', 'agents'].map((name) => path.join(home, name, 'projects'));
    for (const root of roots) mkdirSync(root, { recursive: true });
    vi.stubEnv('CLAUDE_CONFIG_DIRS', roots.map((root) => path.dirname(root)).join(path.delimiter));

    const watcher = startSessionIndexWatch(log);
    await watcher!.close();

    const watched = log.info.mock.calls
      .filter(([, msg]) => msg === 'watching transcripts for session indexing')
      .map(([obj]) => (obj as { root: string }).root);
    expect(watched).toEqual(roots);
  });

  it('the watcher sweeps the episode backlog on its first pass, every tenth pass, and after a pass that left a backlog', async () => {
    // What each pass reports: a backlog count after a sweep, null without one, or a failure.
    const outcomes: (number | null | Error)[] = [
      0,
      ...Array<null>(9).fill(null),
      3,
      0,
      new Error('pass failed'),
      0,
      null,
    ];
    const sweeps: (boolean | undefined)[] = [];
    vi.resetModules();
    vi.doMock('../../src/session-index/refresh.js', async (importOriginal) => ({
      ...(await importOriginal<typeof RefreshModule>()),
      withRefreshLock: <T>(fn: () => Promise<T>) => fn(),
      runRefresh: (options: RefreshOptions) => {
        sweeps.push(options.episodeSweep);
        const outcome = outcomes[sweeps.length - 1] ?? null;
        if (outcome instanceof Error) return Promise.reject(outcome);
        return Promise.resolve({ episodeBacklog: outcome } as RefreshSummary);
      },
    }));
    vi.stubEnv('AW_INDEX_POLL_MS', '1');
    const { startSessionIndexWatch: start } =
      await import('../../src/server/session-index-watch.js');

    const watcher = start(log);
    await vi.waitFor(() => expect(sweeps.length).toBeGreaterThanOrEqual(outcomes.length), {
      timeout: 5_000,
    });
    await watcher!.close();
    vi.doUnmock('../../src/session-index/refresh.js');

    expect(sweeps.slice(0, outcomes.length)).toEqual([
      true,
      ...Array<boolean>(9).fill(false),
      true,
      true,
      false,
      true,
      false,
    ]);
  });
});
