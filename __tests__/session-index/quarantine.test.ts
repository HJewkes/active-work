import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { indexTranscript } from '@titan-design/session-graph';
import type { DiscoveredTranscript } from '@titan-design/session-read';
import { openGraph, type SessionGraph } from '../../src/session-index/graph.js';
import { FIXTURE_LINES, renderTranscript } from './fixture.js';

let dir: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-quarantine-'));
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
});

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string): DiscoveredTranscript {
  const absolutePath = path.join(dir, name);
  writeFileSync(absolutePath, body, 'utf8');
  return {
    projectDir: 'demo',
    absolutePath,
    displayPath: `~/projects/demo/${name}`,
    subagentId: null,
  };
}

function statusOf(displayPath: string) {
  return graph.db
    .prepare<
      [string],
      { status: string; status_reason: string | null; last_offset: number }
    >('SELECT status, status_reason, last_offset FROM transcript WHERE source_key = ?')
    .get(displayPath);
}

describe('indexTranscript', () => {
  it('quarantines a malformed transcript without blocking a later good one', async () => {
    const bad = write('bad.jsonl', '{"sessionId":"s"}\nthis is not json\n');
    const good = write('good.jsonl', renderTranscript(FIXTURE_LINES));

    const badOutcome = await indexTranscript(graph, bad);
    const goodOutcome = await indexTranscript(graph, good);

    expect(badOutcome.status).toBe('quarantined');
    expect(badOutcome).toHaveProperty('reason', expect.stringMatching(/malformed JSON/));
    expect(goodOutcome).toMatchObject({ status: 'indexed', facts: FIXTURE_LINES.length });
    expect(statusOf(good.displayPath)?.status).toBe('ok');
  });

  it('leaves a quarantined transcript at its old watermark so the next pass retries it', async () => {
    const bad = write('bad.jsonl', 'nope\n');

    await indexTranscript(graph, bad);

    expect(statusOf(bad.displayPath)).toMatchObject({ status: 'quarantined', last_offset: 0 });
  });

  it('marks a transcript that has been deleted as missing rather than quarantined', async () => {
    const gone: DiscoveredTranscript = {
      projectDir: 'demo',
      absolutePath: path.join(dir, 'gone.jsonl'),
      displayPath: '~/gone.jsonl',
      subagentId: null,
    };

    const outcome = await indexTranscript(graph, gone);

    expect(outcome.status).toBe('missing');
    expect(statusOf(gone.displayPath)?.status).toBe('missing');
  });

  it('records the durability triple and clears quarantine once a transcript indexes cleanly', async () => {
    const bad = write('flaky.jsonl', 'nope\n');
    await indexTranscript(graph, bad);

    writeFileSync(bad.absolutePath, renderTranscript(FIXTURE_LINES), 'utf8');
    await indexTranscript(graph, bad, { withContentHash: true });

    const row = graph.db
      .prepare<
        [string],
        { status: string; file_size: number; content_hash: string; status_reason: null }
      >('SELECT status, file_size, content_hash, status_reason FROM transcript WHERE source_key = ?')
      .get(bad.displayPath);
    expect(row?.status).toBe('ok');
    expect(row?.status_reason).toBeNull();
    expect(row?.file_size).toBeGreaterThan(0);
    expect(row?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-indexing an unchanged transcript adds no rows', async () => {
    const good = write('good.jsonl', renderTranscript(FIXTURE_LINES));
    await indexTranscript(graph, good);

    const second = await indexTranscript(graph, good);

    expect(second).toMatchObject({ status: 'unchanged', facts: 0 });
    expect(graph.db.prepare('SELECT COUNT(*) AS n FROM fact').get()).toEqual({
      n: FIXTURE_LINES.length,
    });
  });

  /**
   * The fast path is the watermark, not the mtime: `resumePoint` compares the
   * stored offset to the file's size, so a same-length rewrite is invisible
   * unless the caller pays for a hash. Same guarantee as the pre-package
   * size+mtime check, one fewer thing to be wrong about.
   */
  it('skips reading a transcript whose size still matches its watermark', async () => {
    const good = write('good.jsonl', renderTranscript(FIXTURE_LINES));
    await indexTranscript(graph, good);
    const before = statSync(good.absolutePath);

    const rewritten = renderTranscript(FIXTURE_LINES).replace('please build it', 'please build IT');
    writeFileSync(good.absolutePath, rewritten, 'utf8');
    utimesSync(good.absolutePath, before.atime, before.mtime);

    expect(await indexTranscript(graph, good)).toMatchObject({ status: 'unchanged', facts: 0 });
  });

  it('honours verifyHash by re-reading a same-length rewrite the fast path would skip', async () => {
    const good = write('good.jsonl', renderTranscript(FIXTURE_LINES));
    await indexTranscript(graph, good, { withContentHash: true });
    const first = hashOf(good.displayPath);

    const before = statSync(good.absolutePath);
    writeFileSync(
      good.absolutePath,
      renderTranscript(FIXTURE_LINES).replace('please build it', 'please build IT'),
      'utf8',
    );
    utimesSync(good.absolutePath, before.atime, before.mtime);
    const outcome = await indexTranscript(graph, good, { verifyHash: true, withContentHash: true });

    expect(outcome.status).toBe('rewound');
    expect(hashOf(good.displayPath)).not.toBe(first);
  });
});

function hashOf(displayPath: string): string | null {
  return (
    graph.db
      .prepare<
        [string],
        { content_hash: string | null }
      >('SELECT content_hash FROM transcript WHERE source_key = ?')
      .get(displayPath)?.content_hash ?? null
  );
}
