import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDrainIngest } from '../../src/miner/transcript-reader.js';
import { loadTemplates, readOccurrences } from '../../src/miner/store.js';
import { loadReaderState } from '../../src/miner/reader-state.js';

let root: string;
let corpus: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'aw-drain-root-'));
  corpus = mkdtempSync(path.join(os.tmpdir(), 'aw-drain-corpus-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(corpus, { recursive: true, force: true });
});

let clock = 0;

function toolUse(id: string, name: string): Record<string, unknown> {
  return {
    type: 'assistant',
    sessionId: 'session-1',
    timestamp: `2026-07-30T00:00:${String(clock++).padStart(2, '0')}.000Z`,
    message: { content: [{ type: 'tool_use', id, name, input: { command: 'x' } }] },
  };
}

function commandResult(id: string, stdout: string): Record<string, unknown> {
  return {
    type: 'user',
    sessionId: 'session-1',
    timestamp: `2026-07-30T00:00:${String(clock++).padStart(2, '0')}.000Z`,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    toolUseResult: { stdout, stderr: '' },
  };
}

function writeTranscript(name: string, lines: unknown[]): string {
  const dir = path.join(corpus, '-project');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return file;
}

function appendLines(file: string, lines: unknown[]): void {
  appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

const ingest = (extra = {}) => runDrainIngest({ root, corpusRoot: corpus, ...extra });

describe('runDrainIngest', () => {
  beforeEach(() => {
    clock = 0;
  });

  it('clusters command output blobs and records occurrences', async () => {
    writeTranscript('a.jsonl', [
      toolUse('t1', 'Bash'),
      commandResult('t1', 'TypeError: Cannot find module a.ts'),
      toolUse('t2', 'Bash'),
      commandResult('t2', 'TypeError: Cannot find module b.ts'),
    ]);

    const summary = await ingest();
    expect(summary.blobs).toBe(2);
    expect(summary.ingested).toBe(2);
    expect(summary.malformedLines).toBe(0);

    const templates = await loadTemplates(root);
    expect(templates).toHaveLength(1);
    expect(templates[0].toolType).toBe('Bash');
    expect(templates[0].occurrenceCount).toBe(2);
  });

  it('writes locators that point at the exact source line', async () => {
    writeTranscript('a.jsonl', [toolUse('t1', 'Bash'), commandResult('t1', 'boom')]);
    await ingest();

    const occurrences = [];
    for await (const occurrence of readOccurrences(root)) occurrences.push(occurrence);
    expect(occurrences).toHaveLength(1);

    const [transcriptIndex, byteOffset, byteLength] = occurrences[0].locator;
    const state = await loadReaderState(root);
    expect(state.transcripts[transcriptIndex].path).toContain('a.jsonl');
    expect(byteOffset).toBeGreaterThan(0);
    expect(byteLength).toBeGreaterThan(0);
  });

  it('reads nothing on a second pass over an unchanged corpus', async () => {
    writeTranscript('a.jsonl', [toolUse('t1', 'Bash'), commandResult('t1', 'boom')]);
    await ingest();

    const second = await ingest();
    expect(second.scanned).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.linesRead).toBe(0);
    expect(second.blobs).toBe(0);
  });

  it('resumes at the watermark and only ingests appended blobs', async () => {
    const file = writeTranscript('a.jsonl', [toolUse('t1', 'Bash'), commandResult('t1', 'first')]);
    await ingest();

    appendLines(file, [toolUse('t2', 'Bash'), commandResult('t2', 'second')]);
    const second = await ingest();
    expect(second.scanned).toBe(1);
    expect(second.blobs).toBe(1);

    let total = 0;
    for await (const _ of readOccurrences(root)) total++;
    expect(total).toBe(2);
  });

  it('carries a pending tool name across a chunk boundary', async () => {
    // The chunk cut lands between the tool_use and its result, so the tool name
    // is only recoverable from persisted reader state.
    const first = JSON.stringify(toolUse('t1', 'Bash'));
    writeTranscript('a.jsonl', [JSON.parse(first), commandResult('t1', 'boom')]);

    await ingest({ chunkBytes: 1 });
    expect(await loadTemplates(root)).toHaveLength(0);

    await ingest();
    const templates = await loadTemplates(root);
    expect(templates).toHaveLength(1);
    expect(templates[0].toolType).toBe('Bash');
  });

  it('counts malformed lines instead of aborting the transcript', async () => {
    const dir = path.join(corpus, '-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'a.jsonl'),
      `${JSON.stringify(toolUse('t1', 'Bash'))}\n{ not json\n${JSON.stringify(commandResult('t1', 'boom'))}\n`,
      'utf8',
    );

    const summary = await ingest();
    expect(summary.malformedLines).toBe(1);
    expect(summary.ingested).toBe(1);
    expect(summary.errors).toEqual([]);
  });

  it('rewinds to byte 0 when a transcript shrinks below its watermark', async () => {
    const file = writeTranscript('a.jsonl', [toolUse('t1', 'Bash'), commandResult('t1', 'boom')]);
    await ingest();

    writeFileSync(file, `${JSON.stringify(toolUse('t2', 'Bash'))}\n`, 'utf8');
    const second = await ingest();
    expect(second.rewound).toBe(1);
    expect(second.scanned).toBe(1);
  });

  it('re-reads every transcript from byte 0 under full', async () => {
    writeTranscript('a.jsonl', [toolUse('t1', 'Bash'), commandResult('t1', 'boom')]);
    await ingest();

    const full = await runDrainIngest({ root, corpusRoot: corpus, full: true });
    expect(full.scanned).toBe(1);
    expect(full.blobs).toBe(1);
  });

  it('honours limit and keeps transcript indices stable as the corpus grows', async () => {
    writeTranscript('a.jsonl', [toolUse('t1', 'Bash'), commandResult('t1', 'a')]);
    writeTranscript('b.jsonl', [toolUse('t2', 'Bash'), commandResult('t2', 'b')]);

    const first = await ingest({ limit: 1 });
    expect(first.scanned).toBe(1);
    const before = (await loadReaderState(root)).transcripts.map((t) => t.path);

    await ingest();
    const after = (await loadReaderState(root)).transcripts.map((t) => t.path);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(2);
  });

  it('produces the same template set incrementally as in one pass', async () => {
    const lines = [];
    for (let i = 0; i < 40; i++) {
      lines.push(
        toolUse(`t${i}`, 'Bash'),
        commandResult(`t${i}`, `Error: item ${i} failed to load`),
      );
    }
    writeTranscript('a.jsonl', lines);

    const oneShot = mkdtempSync(path.join(os.tmpdir(), 'aw-drain-oneshot-'));
    try {
      await runDrainIngest({ root: oneShot, corpusRoot: corpus });
      for (let i = 0; i < 12; i++) await ingest({ chunkBytes: 400 });

      const ids = async (dir: string) => (await loadTemplates(dir)).map((t) => t.templateId).sort();
      expect(await ids(root)).toEqual(await ids(oneShot));
    } finally {
      rmSync(oneShot, { recursive: true, force: true });
    }
  });

  it('returns an empty summary for a corpus root that does not exist', async () => {
    const summary = await runDrainIngest({ root, corpusRoot: path.join(corpus, 'nope') });
    expect(summary.transcripts).toBe(0);
    expect(summary.blobs).toBe(0);
  });
});
