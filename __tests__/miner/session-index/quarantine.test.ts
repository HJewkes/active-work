import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSessionIndex, type SessionIndexDb } from '../../../src/miner/session-index/db.js';
import { indexTranscript } from '../../../src/miner/session-index/quarantine.js';
import { FIXTURE_LINES, renderTranscript } from './fixture.js';

let dir: string;
let db: SessionIndexDb;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-quarantine-'));
  db = openSessionIndex(path.join(dir, 'index.sqlite3'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string): { absolutePath: string; displayPath: string } {
  const absolutePath = path.join(dir, name);
  writeFileSync(absolutePath, body, 'utf8');
  return { absolutePath, displayPath: `~/projects/demo/${name}` };
}

function statusOf(displayPath: string) {
  return db
    .prepare<
      [string],
      { status: string; quarantine_reason: string | null; last_byte_offset: number }
    >('SELECT status, quarantine_reason, last_byte_offset FROM transcripts WHERE path = ?')
    .get(displayPath);
}

describe('indexTranscript', () => {
  it('quarantines a malformed transcript without blocking a later good one', async () => {
    const bad = write('bad.jsonl', '{"sessionId":"s"}\nthis is not json\n');
    const good = write('good.jsonl', renderTranscript(FIXTURE_LINES));

    const badOutcome = await indexTranscript(db, bad);
    const goodOutcome = await indexTranscript(db, good);

    expect(badOutcome.status).toBe('quarantined');
    expect(badOutcome.reason).toMatch(/malformed JSON/);
    expect(goodOutcome).toMatchObject({ status: 'indexed', factsAdded: FIXTURE_LINES.length });
    expect(statusOf(good.displayPath)?.status).toBe('ok');
  });

  it('leaves a quarantined transcript at its old watermark so the next pass retries it', async () => {
    const bad = write('bad.jsonl', 'nope\n');

    await indexTranscript(db, bad);

    expect(statusOf(bad.displayPath)).toMatchObject({ status: 'quarantined', last_byte_offset: 0 });
  });

  it('marks a transcript that has been deleted as missing rather than quarantined', async () => {
    const gone = { absolutePath: path.join(dir, 'gone.jsonl'), displayPath: '~/gone.jsonl' };

    const outcome = await indexTranscript(db, gone);

    expect(outcome.status).toBe('missing');
    expect(statusOf(gone.displayPath)?.status).toBe('missing');
  });

  it('records the durability triple and clears quarantine once a transcript indexes cleanly', async () => {
    const bad = write('flaky.jsonl', 'nope\n');
    await indexTranscript(db, bad);

    writeFileSync(bad.absolutePath, renderTranscript(FIXTURE_LINES), 'utf8');
    await indexTranscript(db, bad, { verifyContentHash: true });

    const row = db
      .prepare<
        [string],
        { status: string; file_size: number; content_hash: string; quarantine_reason: null }
      >('SELECT status, file_size, content_hash, quarantine_reason FROM transcripts WHERE path = ?')
      .get(bad.displayPath);
    expect(row?.status).toBe('ok');
    expect(row?.quarantine_reason).toBeNull();
    expect(row?.file_size).toBeGreaterThan(0);
    expect(row?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-indexing an unchanged transcript adds no rows', async () => {
    const good = write('good.jsonl', renderTranscript(FIXTURE_LINES));
    await indexTranscript(db, good);

    const second = await indexTranscript(db, good);

    expect(second).toMatchObject({ status: 'unchanged', factsAdded: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual({
      n: FIXTURE_LINES.length,
    });
  });

  it('skips reading a transcript whose size and mtime are unchanged', async () => {
    const good = write('good.jsonl', renderTranscript(FIXTURE_LINES));
    await indexTranscript(db, good);
    const before = statSync(good.absolutePath);

    // Same byte length, different bytes, restored mtime: only a pass that
    // actually re-reads the file could notice the change.
    const rewritten = renderTranscript(FIXTURE_LINES).replace('please build it', 'please build IT');
    writeFileSync(good.absolutePath, rewritten, 'utf8');
    utimesSync(good.absolutePath, before.atime, before.mtime);

    expect(await indexTranscript(db, good)).toMatchObject({ status: 'unchanged', factsAdded: 0 });
  });

  it('honours verifyContentHash by re-reading a transcript the fast path would skip', async () => {
    const good = write('good.jsonl', renderTranscript(FIXTURE_LINES));
    await indexTranscript(db, good, { verifyContentHash: true });
    const first = hashOf(good.displayPath);

    const before = statSync(good.absolutePath);
    writeFileSync(
      good.absolutePath,
      renderTranscript(FIXTURE_LINES).replace('please build it', 'please build IT'),
      'utf8',
    );
    utimesSync(good.absolutePath, before.atime, before.mtime);
    await indexTranscript(db, good, { verifyContentHash: true });

    expect(hashOf(good.displayPath)).not.toBe(first);
  });

  it('ingests a transcript in chunks without changing the result', async () => {
    const good = write('good.jsonl', renderTranscript(FIXTURE_LINES));

    const outcome = await indexTranscript(db, good, { chunkBytes: 64 });

    expect(outcome).toMatchObject({ status: 'indexed', factsAdded: FIXTURE_LINES.length });
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual({
      n: FIXTURE_LINES.length,
    });
  });
});

function hashOf(displayPath: string): string | null {
  return (
    db
      .prepare<
        [string],
        { content_hash: string | null }
      >('SELECT content_hash FROM transcripts WHERE path = ?')
      .get(displayPath)?.content_hash ?? null
  );
}
