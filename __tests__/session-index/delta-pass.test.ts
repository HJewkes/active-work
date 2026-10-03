import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDirtySet } from '../../src/session-index/dirty-set.js';
import { transcriptsFromDirty, unknownRootCandidates } from '../../src/session-index/delta-pass.js';
import { openGraph, type SessionGraph } from '../../src/session-index/graph.js';
import { runRefresh } from '../../src/session-index/refresh.js';

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
