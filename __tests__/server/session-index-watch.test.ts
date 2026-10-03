import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startSessionIndexWatch } from '../../src/server/session-index-watch.js';
import { withRefreshLock } from '../../src/session-index/refresh.js';
import type * as MachinePressureModule from '../../src/utils/machine-pressure.js';
import { FIXTURE_LINES, SESSION, renderTranscript } from '../session-index/fixture.js';
import type * as PrOutcomesModule from '../../src/session-index/pr-outcomes.js';
import type * as RefreshModule from '../../src/session-index/refresh.js';
import type { RefreshOptions, RefreshSummary } from '../../src/session-index/refresh.js';
import { createDirtySet } from '../../src/session-index/dirty-set.js';
import type { WorkspaceGraph } from '../../src/session-index/graph.js';

const probe = vi.hoisted(() => ({
  reads: [] as { swapUsedPct: number; pressureLevel: number }[],
}));

// The real probe would run sysctl; each read pops a scripted sample, then the machine is calm.
vi.mock('../../src/utils/machine-pressure.js', async (importOriginal) => ({
  ...(await importOriginal<typeof MachinePressureModule>()),
  readMachinePressure: async () => probe.reads.shift() ?? { swapUsedPct: 0, pressureLevel: 1 },
}));

// A fixture transcript carries a PR url; keep the pass off the real `gh`.
vi.mock('../../src/session-index/pr-outcomes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof PrOutcomesModule>()),
  ghPrResolver: () => async () => new Map(),
}));

const log = { info: vi.fn(), warn: vi.fn() };

let home: string;

beforeEach(() => {
  vi.restoreAllMocks();
  log.info.mockClear();
  log.warn.mockClear();
  probe.reads.length = 0;
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

  it('starts a non-blocking initial refresh and close aborts it without a failure', async () => {
    writeFileSync(path.join(home, 'ignored.txt'), 'x', 'utf8');

    const watcher = startSessionIndexWatch(log);

    expect(watcher).not.toBeNull();
    // Construction returns immediately; the refresh is un-awaited so the
    // daemon can bind its port before a cold corpus finishes indexing.
    expect(watcher!.status()).toMatchObject({ running: true });
    await watcher!.close();
    expect(watcher!.status()).toMatchObject({ running: false, pending: false, last: null });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('close() while the pass waits on a lock held elsewhere returns without waiting it out', async () => {
    let letGo!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const held = withRefreshLock(async () => {
      entered();
      await new Promise<void>((resolve) => (letGo = resolve));
    });
    await inside;
    const releaseLater = setTimeout(() => letGo(), 3_000);
    const watcher = startSessionIndexWatch(log);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const started = Date.now();
    await watcher!.close();
    const elapsedMs = Date.now() - started;
    clearTimeout(releaseLater);
    letGo();
    await held;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(log.warn).not.toHaveBeenCalled();
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
        return Promise.resolve({
          episodeBacklog: outcome,
          errors: [],
          phases: {},
        } as unknown as RefreshSummary);
      },
    }));
    vi.stubEnv('AW_INDEX_POLL_MS', '1');
    vi.stubEnv('AW_INDEX_MIN_INTERVAL_MS', '1');
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

  it('a delta pass that meets the lock held keeps the dirty paths for the next pass', async () => {
    const root = path.join(home, '.claude', 'projects');
    vi.stubEnv('CLAUDE_CONFIG_DIRS', path.dirname(root));
    const visited: string[][] = [];
    let held = true;
    vi.resetModules();
    vi.doMock('../../src/session-index/refresh.js', async (importOriginal) => ({
      ...(await importOriginal<typeof RefreshModule>()),
      withRefreshLock: <T>(fn: () => Promise<T>, options?: { retries?: number }) => {
        if (options?.retries === 0 && held) {
          held = false;
          return Promise.reject(Object.assign(new Error('held'), { code: 'ELOCKED' }));
        }
        return fn();
      },
      runRefresh: (options: RefreshOptions) => {
        visited.push((options.transcripts ?? []).map((t) => t.absolutePath));
        return Promise.resolve({
          kind: 'delta',
          errors: [],
          phases: {},
        } as unknown as RefreshSummary);
      },
    }));
    const { passRunner } = await import('../../src/server/session-index-watch.js');
    const dirty = createDirtySet();
    dirty.add(root, path.join('demo', 't1.jsonl'));
    const runner = passRunner({} as WorkspaceGraph, dirty, log, new AbortController().signal);

    await expect(runner.run('delta')).rejects.toMatchObject({ code: 'ELOCKED' });
    const sizeAfterSkip = dirty.size;
    await runner.run('delta');
    vi.doUnmock('../../src/session-index/refresh.js');

    expect(sizeAfterSkip).toBe(1);
    expect(visited).toEqual([[path.join(root, 'demo', 't1.jsonl')]]);
    expect(dirty.size).toBe(0);
  });

  it('a delta pass forwards onIndexed to the refresh', async () => {
    vi.resetModules();
    vi.doMock('../../src/session-index/refresh.js', async (importOriginal) => ({
      ...(await importOriginal<typeof RefreshModule>()),
      withRefreshLock: <T>(fn: () => Promise<T>) => fn(),
      runRefresh: (options: RefreshOptions) => {
        options.onIndexed?.();
        return Promise.resolve({
          kind: 'delta',
          errors: [],
          phases: {},
        } as unknown as RefreshSummary);
      },
    }));
    const { passRunner } = await import('../../src/server/session-index-watch.js');
    const dirty = createDirtySet();
    const runner = passRunner({} as WorkspaceGraph, dirty, log, new AbortController().signal);
    const onIndexed = vi.fn();

    await runner.run('delta', onIndexed);
    vi.doUnmock('../../src/session-index/refresh.js');

    expect(onIndexed).toHaveBeenCalledTimes(1);
  });

  describe('with transcripts on disk', () => {
    beforeEach(() => {
      const project = path.join(home, '.claude', 'projects', 'demo');
      mkdirSync(project, { recursive: true });
      for (const n of [1, 2, 3]) {
        const body = renderTranscript(FIXTURE_LINES).replaceAll(SESSION, `sess-watch-${n}`);
        writeFileSync(path.join(project, `t${n}.jsonl`), body, 'utf8');
      }
      vi.stubEnv('CLAUDE_CONFIG_DIRS', path.join(home, '.claude'));
      vi.stubEnv('AW_INDEX_POLL_MS', '3600000');
    });

    const passLines = () =>
      log.info.mock.calls.filter(([, msg]) => msg === 'session index pass').map(([obj]) => obj);

    it('logs one session index pass line with what the pass opened and read', async () => {
      const watcher = startSessionIndexWatch(log);
      await vi.waitFor(() => expect(passLines()).toHaveLength(1), { timeout: 10_000 });
      await watcher!.close();

      expect(passLines()[0]).toMatchObject({
        kind: 'full',
        transcripts: 3,
        scanned: 3,
        filesOpened: 3,
        bytesRead: expect.any(Number),
        durationMs: expect.any(Number),
        maxStallMs: expect.any(Number),
        phases: expect.objectContaining({
          discover: expect.any(Number),
          corpus: expect.any(Number),
        }),
        errors: [],
        errorCount: 0,
      });
      expect((passLines()[0] as { bytesRead: number }).bytesRead).toBeGreaterThan(0);
    });

    it('logs the pass kind the refresh reports', async () => {
      vi.resetModules();
      vi.doMock('../../src/session-index/refresh.js', async (importOriginal) => ({
        ...(await importOriginal<typeof RefreshModule>()),
        withRefreshLock: <T>(fn: () => Promise<T>) => fn(),
        runRefresh: () =>
          Promise.resolve({
            kind: 'delta',
            episodeBacklog: null,
            errors: [],
            phases: {},
          } as unknown as RefreshSummary),
      }));
      const { startSessionIndexWatch: start } =
        await import('../../src/server/session-index-watch.js');

      const watcher = start(log);
      await vi.waitFor(() => expect(passLines()).toHaveLength(1), { timeout: 10_000 });
      await watcher!.close();
      vi.doUnmock('../../src/session-index/refresh.js');

      expect(passLines()[0]).toMatchObject({ kind: 'delta' });
    });

    it('logs one pause and one resume while memory pressure holds the pass', async () => {
      vi.stubEnv('AW_INDEX_GATE_RECHECK_MS', '1');
      probe.reads.push(
        { swapUsedPct: 80, pressureLevel: 1 },
        { swapUsedPct: 80, pressureLevel: 1 },
        { swapUsedPct: 10, pressureLevel: 1 },
      );

      const watcher = startSessionIndexWatch(log);
      await vi.waitFor(() => expect(passLines()).toHaveLength(1), { timeout: 10_000 });
      await watcher!.close();

      const messages = log.info.mock.calls.map(([, msg]) => msg as string);
      expect(messages.filter((msg) => msg.startsWith('session index paused: '))).toEqual([
        'session index paused: swap 80% used (limit 60%)',
      ]);
      expect(messages.filter((msg) => msg === 'session index resumed')).toHaveLength(1);
      expect(messages.indexOf('session index resumed')).toBeLessThan(
        messages.indexOf('session index pass'),
      );
    });

    it('a transcript append starts no pass; the poll does', async () => {
      const debounceMs = 100;
      vi.stubEnv('AW_INDEX_DEBOUNCE_MS', String(debounceMs));
      vi.stubEnv('AW_INDEX_MIN_INTERVAL_MS', '1');
      let pollTick: () => void = () => {};
      const watcher = startSessionIndexWatch(log, {
        startPoll: (tick) => {
          pollTick = tick;
          return () => {};
        },
      });
      await vi.waitFor(() => expect(passLines()).toHaveLength(1), { timeout: 10_000 });

      const transcript = path.join(home, '.claude', 'projects', 'demo', 't1.jsonl');
      appendFileSync(transcript, renderTranscript(FIXTURE_LINES.slice(0, 1)), 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 3 * debounceMs));
      const afterAppend = passLines().length;
      pollTick();
      await vi.waitFor(() => expect(passLines()).toHaveLength(2), { timeout: 10_000 });
      await watcher!.close();

      expect(afterAppend).toBe(1);
      expect(passLines()[1]).toMatchObject({ kind: 'full' });
    });
  });
});
