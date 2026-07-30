import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MinerIngestor, type IngestBlobInput } from '../../src/miner/index.js';
import { loadTemplates, readOccurrences } from '../../src/miner/store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-miner-index-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function blob(overrides: Partial<IngestBlobInput> = {}): IngestBlobInput {
  return {
    toolType: 'Bash',
    rawText: 'TypeError: Cannot find module a.ts',
    locator: [0, 0, 10],
    sessionId: 'session-1',
    timestamp: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('MinerIngestor.ingestBlob', () => {
  it('creates a new template for the first blob of a shape', async () => {
    const ingestor = await MinerIngestor.create(dir);
    const result = await ingestor.ingestBlob(blob());
    expect(result.isNewTemplate).toBe(true);

    const templates = await loadTemplates(dir);
    expect(templates).toHaveLength(1);
    expect(templates[0].occurrenceCount).toBe(1);
  });

  it('reuses the same template for structurally identical blobs and bumps occurrenceCount', async () => {
    const ingestor = await MinerIngestor.create(dir);
    const first = await ingestor.ingestBlob(
      blob({ rawText: 'TypeError: Cannot find module a.ts' }),
    );
    const second = await ingestor.ingestBlob(
      blob({ rawText: 'TypeError: Cannot find module b.ts' }),
    );

    expect(second.isNewTemplate).toBe(false);
    expect(second.templateId).toBe(first.templateId);

    const templates = await loadTemplates(dir);
    expect(templates).toHaveLength(1);
    expect(templates[0].occurrenceCount).toBe(2);
  });

  it('keeps distinct toolTypes as distinct templates even with the same body', async () => {
    const ingestor = await MinerIngestor.create(dir);
    const bash = await ingestor.ingestBlob(blob({ toolType: 'Bash' }));
    const read = await ingestor.ingestBlob(blob({ toolType: 'Read' }));
    expect(bash.templateId).not.toBe(read.templateId);
  });

  it('appends one occurrence per ingested blob', async () => {
    const ingestor = await MinerIngestor.create(dir);
    await ingestor.ingestBlob(blob({ sessionId: 'session-1' }));
    await ingestor.ingestBlob(blob({ sessionId: 'session-2' }));

    const occurrences = [];
    for await (const occ of readOccurrences(dir)) occurrences.push(occ);
    expect(occurrences).toHaveLength(2);
    expect(occurrences.map((o) => o.sessionId)).toEqual(['session-1', 'session-2']);
  });

  it('records extractedParams on the occurrence when masking captures params', async () => {
    const ingestor = await MinerIngestor.create(dir);
    await ingestor.ingestBlob(blob({ rawText: 'error TS2304: Cannot find name' }));

    const occurrences = [];
    for await (const occ of readOccurrences(dir)) occurrences.push(occ);
    expect(occurrences[0].extractedParams?.NUM).toBe('2304');
  });

  it('produces identical templateIds across two independent runs over the same corpus (determinism)', async () => {
    const dirA = mkdtempSync(path.join(os.tmpdir(), 'aw-miner-index-a-'));
    const dirB = mkdtempSync(path.join(os.tmpdir(), 'aw-miner-index-b-'));
    try {
      const corpus = [
        blob({ rawText: 'TypeError: Cannot find module a.ts', sessionId: 's1' }),
        blob({ rawText: 'FAIL suite timeout after 30000 ms', sessionId: 's2' }),
        blob({ rawText: 'TypeError: Cannot find module b.ts', sessionId: 's3' }),
      ];

      const ingestorA = await MinerIngestor.create(dirA);
      const resultsA = [];
      for (const b of corpus) resultsA.push(await ingestorA.ingestBlob(b));

      const ingestorB = await MinerIngestor.create(dirB);
      const resultsB = [];
      for (const b of corpus) resultsB.push(await ingestorB.ingestBlob(b));

      expect(resultsA.map((r) => r.templateId)).toEqual(resultsB.map((r) => r.templateId));

      const templatesA = await loadTemplates(dirA);
      const templatesB = await loadTemplates(dirB);
      expect(templatesA).toEqual(templatesB);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('recognizes a previously-seen template shape after a fresh restart', async () => {
    const first = await MinerIngestor.create(dir);
    const firstResult = await first.ingestBlob(
      blob({ rawText: 'TypeError: Cannot find module a.ts' }),
    );

    const restarted = await MinerIngestor.create(dir);
    const secondResult = await restarted.ingestBlob(
      blob({ rawText: 'TypeError: Cannot find module a.ts' }),
    );

    expect(secondResult.templateId).toBe(firstResult.templateId);
    expect(secondResult.isNewTemplate).toBe(false);

    const templates = await loadTemplates(dir);
    expect(templates).toHaveLength(1);
    expect(templates[0].occurrenceCount).toBe(2);
  });
});
