import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendOccurrence,
  loadTemplates,
  readOccurrences,
  rewriteOccurrences,
  saveTemplates,
} from '../../src/miner/store.js';
import type { Occurrence, Template } from '../../src/schemas/template.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-miner-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sampleTemplate: Template = {
  templateId: 'tpl-1',
  toolType: 'Bash',
  maskedSignature: 'error TS<NUM>',
  createdAt: '2026-07-30T00:00:00.000Z',
  occurrenceCount: 1,
  exemplarLocator: [0, 0, 10],
};

const sampleOccurrence: Occurrence = {
  templateId: 'tpl-1',
  locator: [0, 0, 10],
  sessionId: 'session-1',
  timestamp: '2026-07-30T00:00:00.000Z',
};

describe('templates.yml', () => {
  it('returns an empty array when no file exists yet', async () => {
    expect(await loadTemplates(dir)).toEqual([]);
  });

  it('round-trips templates through save/load', async () => {
    await saveTemplates([sampleTemplate], dir);
    expect(await loadTemplates(dir)).toEqual([sampleTemplate]);
  });

  it('creates the miner root directory if missing', async () => {
    const nested = path.join(dir, 'nested', 'miner');
    await saveTemplates([sampleTemplate], nested);
    expect(await loadTemplates(nested)).toEqual([sampleTemplate]);
  });
});

describe('occurrences.jsonl', () => {
  it('yields nothing when no file exists yet', async () => {
    const results: Occurrence[] = [];
    for await (const occ of readOccurrences(dir)) results.push(occ);
    expect(results).toEqual([]);
  });

  it('appends and reads back occurrences in order', async () => {
    await appendOccurrence(sampleOccurrence, dir);
    await appendOccurrence({ ...sampleOccurrence, sessionId: 'session-2' }, dir);

    const results: Occurrence[] = [];
    for await (const occ of readOccurrences(dir)) results.push(occ);

    expect(results).toHaveLength(2);
    expect(results[0].sessionId).toBe('session-1');
    expect(results[1].sessionId).toBe('session-2');
  });

  it('rejects an invalid occurrence before appending', async () => {
    // @ts-expect-error – exercising runtime guard
    await expect(appendOccurrence({ templateId: 'tpl-1' }, dir)).rejects.toThrow();
  });

  it('rewrites the log wholesale via rewriteOccurrences', async () => {
    await appendOccurrence(sampleOccurrence, dir);
    await appendOccurrence(sampleOccurrence, dir);
    await rewriteOccurrences([sampleOccurrence], dir);

    const results: Occurrence[] = [];
    for await (const occ of readOccurrences(dir)) results.push(occ);
    expect(results).toHaveLength(1);
  });

  it('rewriting to an empty list leaves an empty, readable log', async () => {
    await appendOccurrence(sampleOccurrence, dir);
    await rewriteOccurrences([], dir);

    const results: Occurrence[] = [];
    for await (const occ of readOccurrences(dir)) results.push(occ);
    expect(results).toEqual([]);
  });
});
