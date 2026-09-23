import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runRelated } from '../../src/commands/context-related.js';
import type { HitLogEntry, HitLogWriter } from '../../src/search/hit-log.js';
import { refreshInto, scaffold } from '../workspace-index/fixture.js';

/**
 * `context.related` as the spawn broker calls it: naming a trigger is what
 * makes the served hits land in the hit log, server-side (TP-329).
 */

let dir: string;
let root: string;
let dbPath: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-context-related-'));
  root = path.join(dir, 'active');
  dbPath = path.join(dir, 'graph.sqlite3');
  scaffold(root);
  (await refreshInto(dbPath, root)).db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function recorder(): { writer: HitLogWriter; entries: HitLogEntry[]; calls: number } {
  const log = {
    entries: [] as HitLogEntry[],
    calls: 0,
    writer: async (batch: HitLogEntry[]) => {
      log.calls += 1;
      log.entries.push(...batch);
      return null;
    },
  };
  return log;
}

describe('context.related', () => {
  it('a spawn trigger logs every rendered hit with the winning span offsets', async () => {
    const log = recorder();
    const text = 'the alpha lesson';

    const result = await runRelated(
      { for: text, initiative: 'alpha', trigger: 'spawn' },
      { activeRoot: root, dbPath, hitLog: log.writer },
    );

    expect(result.hits.length).toBeGreaterThan(1);
    expect(log.entries.map(({ ts: _ts, ...rest }) => rest)).toEqual(
      result.hits.map((hit, i) => ({
        slug: 'alpha',
        trigger: 'spawn',
        query: text,
        ref: hit.ref,
        rank: i + 1,
        byteOffset: hit.byteOffset,
        byteLength: hit.byteLength,
      })),
    );
    expect(log.entries.every((entry) => typeof entry.byteOffset === 'number')).toBe(true);
    expect(log.entries.every((entry) => (entry.byteLength ?? 0) > 0)).toBe(true);
  });

  it('related without a trigger writes nothing to the hit log', async () => {
    const log = recorder();

    const result = await runRelated(
      { for: 'the alpha lesson', initiative: 'alpha' },
      { activeRoot: root, dbPath, hitLog: log.writer },
    );

    expect(result.hits.length).toBeGreaterThan(0);
    expect(log.calls).toBe(0);
  });

  it('reports a failed hit-log append as degraded and still returns the hits', async () => {
    const result = await runRelated(
      { for: 'the alpha lesson', trigger: 'spawn' },
      { activeRoot: root, dbPath, hitLog: async () => 'EACCES: permission denied' },
    );

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.degraded).toContainEqual({
      source: 'hit-log',
      reason: 'error',
      message: 'EACCES: permission denied',
    });
  });
});
