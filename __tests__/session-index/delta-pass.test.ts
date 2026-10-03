import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverTranscripts } from '@titan-design/session-read';
import { graphDocumentFrequency } from '../../src/search/document-frequency.js';
import { createDirtySet } from '../../src/session-index/dirty-set.js';
import { transcriptsFromDirty, unknownRootCandidates } from '../../src/session-index/delta-pass.js';
import { openGraph, type SessionGraph } from '../../src/session-index/graph.js';
import { runRefresh } from '../../src/session-index/refresh.js';
import { RefreshScheduler } from '../../src/session-index/scheduler.js';
import type * as Episodes from '../../src/session-index/episodes.js';

const episodeStep = vi.hoisted(() => ({ before: null as (() => Promise<void>) | null }));

vi.mock('../../src/session-index/episodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Episodes>();
  return {
    ...actual,
    refreshEpisodes: async (...args: Parameters<typeof actual.refreshEpisodes>) => {
      await episodeStep.before?.();
      return actual.refreshEpisodes(...args);
    },
  };
});

const UNCHANGED = 1_000;

let dir: string;
let root: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-delta-'));
  root = path.join(dir, 'projects');
  mkdirSync(path.join(root, 'demo'), { recursive: true });
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
  vi.stubEnv('AGENT_CHAT_HOME', path.join(dir, 'agent-chat'));
});

afterEach(() => {
  episodeStep.before = null;
  vi.unstubAllEnvs();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const userLine = (n: number, text: string): string =>
  `${JSON.stringify({
    type: 'user',
    sessionId: `sess-${n}`,
    uuid: `u-${n}-${text.length}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: text },
  })}\n`;

function writeTranscript(n: number): string {
  const file = path.join(root, 'demo', `s${n}.jsonl`);
  writeFileSync(file, userLine(n, 'first prompt'), 'utf8');
  return file;
}

const indexedAt = (): Map<string, string | null> =>
  new Map(graph.transcripts.list().map((row) => [row.sourceKey, row.lastIndexedAt]));

describe('delta pass', () => {
  it('opens only the one transcript the dirty set names among 1,000 unchanged ones', async () => {
    for (let n = 0; n < UNCHANGED; n += 1) writeTranscript(n);
    await runRefresh({ graph, root, skipPrOutcomes: true, skipWorkspace: true, taskRoot: dir });
    const before = indexedAt();
    const changed = path.join(root, 'demo', 's7.jsonl');
    const appended = userLine(7, 'a second, longer prompt');
    appendFileSync(changed, appended, 'utf8');
    const dirty = createDirtySet();
    dirty.add(root, 'demo/s7.jsonl');

    const transcripts = await transcriptsFromDirty(graph, dirty.drain(), [
      { root, account: 'default' },
    ]);
    const summary = await runRefresh({ graph, mode: 'delta', transcripts, taskRoot: dir });

    expect(summary).toMatchObject({
      kind: 'delta',
      transcripts: 1,
      scanned: 1,
      indexed: 1,
      unchanged: 0,
      filesOpened: 1,
      bytesRead: Buffer.byteLength(appended),
    });
    expect(Object.keys(summary.phases)).toEqual(['scan', 'rollup', 'episodes', 'workspace']);
    const changedKey = [...before.keys()].find((key) => key.endsWith('/demo/s7.jsonl'));
    for (const [key, stamp] of indexedAt()) {
      if (key !== changedKey) expect(stamp).toBe(before.get(key));
    }
  }, 60_000);

  it('counts a term higher after a delta pass indexes a transcript containing it', async () => {
    writeTranscript(1);
    await runRefresh({ graph, root, skipPrOutcomes: true, skipWorkspace: true, taskRoot: dir });
    const frequency = graphDocumentFrequency(graph);
    const before = frequency('prompt');
    appendFileSync(path.join(root, 'demo', 's1.jsonl'), userLine(1, 'another prompt here'), 'utf8');
    const dirty = createDirtySet();
    dirty.add(root, 'demo/s1.jsonl');
    const transcripts = await transcriptsFromDirty(graph, dirty.drain(), [
      { root, account: 'default' },
    ]);

    await runRefresh({ graph, mode: 'delta', transcripts, skipWorkspace: true, taskRoot: dir });

    expect(frequency('prompt')).toBeGreaterThan(before);
  });

  it('counts a term higher after a full refresh indexes a transcript containing it', async () => {
    writeTranscript(1);
    await runRefresh({ graph, root, skipPrOutcomes: true, skipWorkspace: true, taskRoot: dir });
    const frequency = graphDocumentFrequency(graph);
    const before = frequency('prompt');
    writeTranscript(2);

    await runRefresh({ graph, root, skipPrOutcomes: true, skipWorkspace: true, taskRoot: dir });

    expect(frequency('prompt')).toBeGreaterThan(before);
  });

  it('visits only recent rows and files with no row when a root is unknown', async () => {
    const [settled, recent] = [writeTranscript(1), writeTranscript(2)];
    await runRefresh({ graph, root, skipPrOutcomes: true, skipWorkspace: true, taskRoot: dir });
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    for (const row of graph.transcripts.list()) {
      if (!row.sourceKey.endsWith('s1.jsonl')) continue;
      graph.transcripts.advance(row.sourceKey, {
        lastOffset: row.lastOffset,
        fileMtime: longAgo.toISOString(),
      });
    }
    utimesSync(settled, longAgo, longAgo);
    const fresh = writeTranscript(3);

    const found = await unknownRootCandidates(graph, { root, account: 'default' });

    expect(found.map((t) => t.absolutePath).sort()).toEqual([recent, fresh].sort());
  });
});

describe('delta pass aborted mid-scan', () => {
  const assistantLine = (n: number): string =>
    `${JSON.stringify({
      type: 'assistant',
      sessionId: `sess-${n}`,
      uuid: `a-${n}`,
      parentUuid: `u-${n}-12`,
      timestamp: '2026-01-01T00:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    })}\n`;

  const unrolledTurns = (): number =>
    (
      graph.db.prepare('SELECT COUNT(*) AS n FROM turn WHERE ended_at IS NULL').get() as {
        n: number;
      }
    ).n;

  it('rolls up the sessions it committed before the abort', async () => {
    for (const n of [1, 2]) appendFileSync(writeTranscript(n), assistantLine(n), 'utf8');
    const transcripts = await discoverTranscripts(root);
    const aborted = new Error('watcher closed');
    const yieldPoint = vi.fn(async () => {
      throw aborted;
    });

    const pass = runRefresh({ graph, mode: 'delta', transcripts, yieldPoint, taskRoot: dir });

    await expect(pass).rejects.toBe(aborted);
    const turns = graph.db.prepare('SELECT COUNT(*) AS n FROM turn').get() as { n: number };
    expect(turns.n).toBe(1);
    expect(unrolledTurns()).toBe(0);
  });
});

describe('delta pass behind runNow', () => {
  /** Resolves after `ms`, or at once when released. */
  function blockFor(ms: number): { blocked: Promise<void>; release: () => void } {
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      release = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    return { blocked, release };
  }

  it('reads fresh inside the related budget while the episode step blocks for 5 s', async () => {
    writeTranscript(1);
    const transcripts = await discoverTranscripts(root);
    const episodes = blockFor(5_000);
    let episodeStepBlocked = false;
    episodeStep.before = () => {
      episodeStepBlocked = true;
      return episodes.blocked;
    };
    const scheduler = new RefreshScheduler((_kind, onIndexed) =>
      runRefresh({ graph, mode: 'delta', transcripts, taskRoot: dir, onIndexed }),
    );

    try {
      const started = Date.now();
      const freshness = await scheduler.runNow(800);
      const elapsedMs = Date.now() - started;

      expect(freshness).toBe('fresh');
      expect(elapsedMs).toBeLessThan(800);
      expect(episodeStepBlocked).toBe(true);
      expect(scheduler.status().running).toBe(true);
    } finally {
      episodes.release();
      await scheduler.close();
    }
    expect(scheduler.status().running).toBe(false);
  });

  /** A scheduler whose delta drains `dirty` the way the daemon's pass runner does. */
  function dirtyScheduler(dirty: ReturnType<typeof createDirtySet>): RefreshScheduler {
    const roots = [{ root, account: 'default' }];
    return new RefreshScheduler(
      async (_kind, onIndexed) => {
        const transcripts = await transcriptsFromDirty(graph, dirty.drain(), roots);
        return runRefresh({ graph, mode: 'delta', transcripts, taskRoot: dir, onIndexed });
      },
      { hasUndrained: () => dirty.size > 0 },
    );
  }

  /** Blocks only the first pass's episode step, writing `s2` while it holds. */
  function writeDuringFirstEpisodes(
    dirty: ReturnType<typeof createDirtySet>,
    block: Promise<void>,
  ): void {
    let calls = 0;
    episodeStep.before = () => {
      calls += 1;
      if (calls > 1) return Promise.resolve();
      writeTranscript(2);
      dirty.add(root, 'demo/s2.jsonl');
      return block;
    };
  }

  const isIndexed = (name: string): boolean =>
    graph.transcripts.list().some((row) => row.sourceKey.endsWith(`/demo/${name}`));

  it('reads stale when it joins a delta in its episode step after a path was written', async () => {
    writeTranscript(1);
    const dirty = createDirtySet();
    dirty.add(root, 'demo/s1.jsonl');
    const episodes = blockFor(5_000);
    writeDuringFirstEpisodes(dirty, episodes.blocked);
    const scheduler = dirtyScheduler(dirty);

    try {
      const first = await scheduler.runNow(800);
      const joined = await scheduler.runNow(300);

      expect(first).toBe('fresh');
      expect(joined).toBe('stale');
      expect(isIndexed('s2.jsonl')).toBe(false);
    } finally {
      episodes.release();
      await scheduler.close();
    }
  });

  it('reads fresh once a follow-up delta indexes the path written during the episode step', async () => {
    writeTranscript(1);
    const dirty = createDirtySet();
    dirty.add(root, 'demo/s1.jsonl');
    const episodes = blockFor(5_000);
    writeDuringFirstEpisodes(dirty, episodes.blocked);
    const scheduler = dirtyScheduler(dirty);

    try {
      await scheduler.runNow(800);
      setTimeout(episodes.release, 100);
      const joined = await scheduler.runNow(3_000);

      expect(joined).toBe('fresh');
      expect(isIndexed('s2.jsonl')).toBe(true);
      expect(dirty.size).toBe(0);
    } finally {
      episodes.release();
      await scheduler.close();
    }
  });
});
