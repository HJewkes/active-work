import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openSessionIndex, type SessionIndexDb } from '../../../src/miner/session-index/db.js';
import { runRefresh, type RefreshSummary } from '../../../src/miner/session-index/refresh.js';
import { RefreshScheduler } from '../../../src/miner/session-index/scheduler.js';
import { FIXTURE_LINES, renderTranscript } from './fixture.js';

let dir: string;
let root: string;
let db: SessionIndexDb;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-refresh-'));
  root = path.join(dir, 'projects');
  mkdirSync(path.join(root, 'demo'), { recursive: true });
  db = openSessionIndex(path.join(dir, 'index.sqlite3'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines = FIXTURE_LINES): void {
  writeFileSync(path.join(root, 'demo', name), renderTranscript(lines), 'utf8');
}

describe('runRefresh', () => {
  it('indexes the corpus and rolls up the sessions it touched', async () => {
    writeTranscript('a.jsonl');

    const summary = await runRefresh({ db, root });

    expect(summary).toMatchObject({
      transcripts: 1,
      scanned: 1,
      indexed: 1,
      unchanged: 0,
      quarantined: 0,
      missing: 0,
      errors: [],
    });
    expect(summary.factsAdded).toBe(FIXTURE_LINES.length);
    expect(summary.sessionsRolledUp).toBeGreaterThan(0);
    // The rollup ran: turns are closed, which no single line can do.
    expect(db.prepare('SELECT COUNT(*) AS n FROM turns WHERE ended_at IS NOT NULL').get()).toEqual({
      n: 2,
    });
  });

  it('reports an unchanged corpus without re-reading it', async () => {
    writeTranscript('a.jsonl');
    await runRefresh({ db, root });

    const second = await runRefresh({ db, root });

    expect(second).toMatchObject({ indexed: 0, unchanged: 1, factsAdded: 0 });
  });

  it('honours --limit and surfaces a quarantined transcript as an error', async () => {
    writeTranscript('a.jsonl');
    writeFileSync(path.join(root, 'demo', 'b.jsonl'), 'not json\n', 'utf8');

    const limited = await runRefresh({ db, root, limit: 1 });
    expect(limited).toMatchObject({ transcripts: 2, scanned: 1 });

    const all = await runRefresh({ db, root });
    expect(all.quarantined).toBe(1);
    expect(all.errors).toHaveLength(1);
    expect(all.errors[0]).toMatch(/quarantined: .*b\.jsonl/);
  });

  it('a full refresh converges on the same row counts as an incremental one', async () => {
    writeTranscript('a.jsonl');
    await runRefresh({ db, root });
    const incremental = counts();

    await runRefresh({ db, root, full: true });

    expect(counts()).toEqual(incremental);
  });
});

function counts(): Record<string, number> {
  const scalar = (table: string): number =>
    (db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    facts: scalar('facts'),
    sessions: scalar('sessions'),
    turns: scalar('turns'),
    edges: scalar('edges'),
    spans: scalar('searchable_spans'),
    fts: scalar('spans_fts'),
  };
}

describe('RefreshScheduler', () => {
  const summary = (): RefreshSummary => ({
    startedAt: new Date().toISOString(),
    durationMs: 0,
    transcripts: 0,
    scanned: 0,
    indexed: 0,
    unchanged: 0,
    quarantined: 0,
    missing: 0,
    factsAdded: 0,
    sessionsRolledUp: 0,
    errors: [],
  });

  /** A run that only resolves once the test lets it. */
  function gatedRun(): {
    run: () => Promise<RefreshSummary>;
    release: () => void;
    started: () => number;
  } {
    let starts = 0;
    let unblock: (() => void) | null = null;
    return {
      started: () => starts,
      release: () => unblock?.(),
      run: () => {
        starts += 1;
        return new Promise<RefreshSummary>((resolve) => {
          unblock = () => resolve(summary());
        });
      },
    };
  }

  it('collapses triggers arriving mid-run into exactly one extra run', async () => {
    const gate = gatedRun();
    const scheduler = new RefreshScheduler(gate.run);

    scheduler.trigger();
    for (let i = 0; i < 10; i++) scheduler.trigger();
    expect(gate.started()).toBe(1);

    gate.release();
    await vi.waitFor(() => expect(gate.started()).toBe(2));
    gate.release();
    await scheduler.close();

    expect(gate.started()).toBe(2);
  });

  it('never runs two passes concurrently', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let runs = 0;
    const scheduler = new RefreshScheduler(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      runs += 1;
      await Promise.resolve();
      concurrent -= 1;
      return summary();
    });

    scheduler.trigger();
    scheduler.trigger();
    await vi.waitFor(() => expect(runs).toBe(2));

    // A trigger arriving after the drain has finished starts a fresh run
    // rather than being dropped.
    scheduler.trigger();
    await vi.waitFor(() => expect(runs).toBe(3));
    await scheduler.close();

    expect(maxConcurrent).toBe(1);
  });

  it('close() awaits the in-flight run and drops what was queued', async () => {
    const gate = gatedRun();
    const scheduler = new RefreshScheduler(gate.run);

    scheduler.trigger();
    scheduler.trigger();
    const closing = scheduler.close();
    gate.release();
    await closing;

    expect(gate.started()).toBe(1);
    expect(scheduler.status()).toMatchObject({ running: false, pending: false });
    // A trigger after close is inert.
    scheduler.trigger();
    expect(gate.started()).toBe(1);
  });

  it('survives a throwing run, backing off and recording the error', async () => {
    const delays: number[] = [];
    let runs = 0;
    const scheduler = new RefreshScheduler(
      () => {
        runs += 1;
        return Promise.reject(new Error(`boom ${runs}`));
      },
      { sleep: async (ms) => void delays.push(ms), baseBackoffMs: 10, maxBackoffMs: 40 },
    );

    scheduler.trigger();
    await vi.waitFor(() => expect(runs).toBe(1));
    scheduler.trigger();
    await vi.waitFor(() => expect(runs).toBe(2));
    scheduler.trigger();
    await vi.waitFor(() => expect(runs).toBe(3));
    await scheduler.close();

    expect(delays).toEqual([10, 20, 40]);
    expect(scheduler.status()).toMatchObject({ consecutiveErrors: 3, lastError: 'boom 3' });
  });

  it('clears the error state once a run succeeds', async () => {
    let runs = 0;
    const scheduler = new RefreshScheduler(
      () => {
        runs += 1;
        return runs === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(summary());
      },
      { sleep: async () => {} },
    );

    scheduler.trigger();
    await vi.waitFor(() => expect(runs).toBe(1));
    scheduler.trigger();
    await vi.waitFor(() => expect(runs).toBe(2));
    await scheduler.close();

    expect(scheduler.status()).toMatchObject({ consecutiveErrors: 0, lastError: null });
    expect(scheduler.status().last).not.toBeNull();
  });
});
