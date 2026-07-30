import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSessionIndex, type SessionIndexDb } from '../../../src/miner/session-index/db.js';
import { indexTranscript } from '../../../src/miner/session-index/quarantine.js';
import { extractTranscript } from '../../../src/miner/session-index/extract.js';
import { ensureTranscript } from '../../../src/miner/session-index/watermark.js';
import { applyExtractResult, resetIndex } from '../../../src/miner/session-index/writer.js';
import { FIXTURE_LINES, renderTranscript } from './fixture.js';

let dir: string;
let db: SessionIndexDb;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-fts-'));
  db = openSessionIndex(path.join(dir, 'index.sqlite3'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function index(chunkBytes?: number): Promise<void> {
  const absolutePath = path.join(dir, 'session.jsonl');
  writeFileSync(absolutePath, renderTranscript(FIXTURE_LINES), 'utf8');
  await indexTranscript(db, { absolutePath, displayPath: '~/demo/session.jsonl' }, { chunkBytes });
}

/** The mandatory read shape: FTS rowids are only meaningful through the join. */
function search(query: string): { span_id: number; field: string }[] {
  return db
    .prepare<[string], { span_id: number; field: string }>(
      `SELECT s.span_id, s.field FROM spans_fts f
         JOIN searchable_spans s ON s.span_id = f.rowid
        WHERE spans_fts MATCH ? ORDER BY s.span_id`,
    )
    .all(query);
}

const scalar = (sql: string): number =>
  (db.prepare<[], { n: number }>(sql).get() as { n: number }).n;

describe('spans_fts population', () => {
  it('finds a prompt by a word from its text', async () => {
    await index();

    expect(search('build').map((r) => r.field)).toEqual(['prompt']);
  });

  it('indexes assistant prose, tool inputs and tool results under their own fields', async () => {
    await index();

    expect(search('"on it"').map((r) => r.field)).toEqual(['assistant_response']);
    expect(search('boom').map((r) => r.field)).toEqual(['tool_result']);
    // A tool input's string leaves — here the Bash command — are searchable.
    expect(search('checkout').map((r) => r.field)).toEqual(['tool_input']);
  });

  it('does not index JSON field names', async () => {
    await index();

    expect(search('file_path')).toEqual([]);
    expect(search('subagent_type')).toEqual([]);
  });

  it('keeps one FTS row per span when a batch is re-applied', async () => {
    const absolutePath = path.join(dir, 'session.jsonl');
    writeFileSync(absolutePath, renderTranscript(FIXTURE_LINES), 'utf8');
    const row = ensureTranscript(db, '~/demo/session.jsonl');
    const result = await extractTranscript(absolutePath);

    // Re-delivery of an identical batch is the crash-recovery path: the
    // locator insert hits DO NOTHING and the FTS insert must not fire.
    applyExtractResult(db, row.transcriptId, result);
    const spans = scalar('SELECT COUNT(*) AS n FROM searchable_spans');
    applyExtractResult(db, row.transcriptId, result);

    expect(scalar('SELECT COUNT(*) AS n FROM searchable_spans')).toBe(spans);
    expect(scalar('SELECT COUNT(*) AS n FROM spans_fts')).toBe(spans);
    expect(search('build')).toHaveLength(1);
  });

  it('aligns rowids with span ids across chunk boundaries', async () => {
    await index(64);

    const matched = search('build');
    expect(matched).toHaveLength(1);
    const field = db
      .prepare<[number], { field: string }>('SELECT field FROM searchable_spans WHERE span_id = ?')
      .get(matched[0].span_id);
    expect(field?.field).toBe('prompt');
  });

  it('resetIndex clears the FTS rows the locator delete leaves behind', async () => {
    await index();

    resetIndex(db);

    expect(scalar('SELECT COUNT(*) AS n FROM spans_fts')).toBe(0);
  });
});
