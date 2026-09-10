import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyDelta, indexTranscript, resetIndex } from '@titan-design/session-graph';
import { extractTranscript } from '@titan-design/session-read';
import { openGraph, type SessionGraph } from '../../src/session-index/graph.js';
import { FIXTURE_LINES, offsetAfterLine, renderTranscript } from './fixture.js';

let dir: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-fts-'));
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
});

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function index(): Promise<void> {
  const absolutePath = path.join(dir, 'session.jsonl');
  writeFileSync(absolutePath, renderTranscript(FIXTURE_LINES), 'utf8');
  await indexTranscript(graph, {
    projectDir: 'demo',
    absolutePath,
    displayPath: '~/demo/session.jsonl',
    subagentId: null,
  });
}

/** The same transcript applied as two chunks, so span ids are assigned in two batches. */
async function indexChunked(): Promise<void> {
  const absolutePath = path.join(dir, 'session.jsonl');
  writeFileSync(absolutePath, renderTranscript(FIXTURE_LINES), 'utf8');
  const transcriptId = graph.transcripts.ensure('~/demo/session.jsonl').sourceId;
  const first = await extractTranscript(absolutePath, {
    untilByteOffset: offsetAfterLine(FIXTURE_LINES, 4),
  });
  applyDelta(graph, transcriptId, first);
  applyDelta(
    graph,
    transcriptId,
    await extractTranscript(absolutePath, {
      fromByteOffset: first.lastByteOffset,
      priorPrefixHash: first.prefixHash,
    }),
  );
}

/** The mandatory read shape: FTS rowids are only meaningful through the join. */
function search(query: string): { span_id: number; field: string }[] {
  return graph.db
    .prepare<[string], { span_id: number; field: string }>(
      `SELECT s.span_id, s.field FROM search_fts f
         JOIN search_span s ON s.span_id = f.rowid
        WHERE search_fts MATCH ? ORDER BY s.span_id`,
    )
    .all(query);
}

const scalar = (sql: string): number =>
  (graph.db.prepare<[], { n: number }>(sql).get() as { n: number }).n;

describe('search_fts population', () => {
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
    const transcriptId = graph.transcripts.ensure('~/demo/session.jsonl').sourceId;
    const result = await extractTranscript(absolutePath);

    // Re-delivery of an identical batch is the crash-recovery path: the
    // locator insert hits DO NOTHING and the FTS insert must not fire.
    applyDelta(graph, transcriptId, result);
    const spans = scalar('SELECT COUNT(*) AS n FROM search_span');
    applyDelta(graph, transcriptId, result);

    expect(scalar('SELECT COUNT(*) AS n FROM search_span')).toBe(spans);
    expect(scalar('SELECT COUNT(*) AS n FROM search_fts')).toBe(spans);
    expect(search('build')).toHaveLength(1);
  });

  it('aligns rowids with span ids across chunk boundaries', async () => {
    await indexChunked();

    const matched = search('build');
    expect(matched).toHaveLength(1);
    const field = graph.db
      .prepare<[number], { field: string }>('SELECT field FROM search_span WHERE span_id = ?')
      .get(matched[0].span_id);
    expect(field?.field).toBe('prompt');
  });

  it('resetIndex clears the FTS rows the locator delete leaves behind', async () => {
    await index();

    resetIndex(graph);

    expect(scalar('SELECT COUNT(*) AS n FROM search_fts')).toBe(0);
  });
});
