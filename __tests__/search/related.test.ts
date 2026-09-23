import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { relatedContext, withinBudget, type RelatedInput } from '../../src/search/related.js';
import { refreshInto, scaffold } from '../workspace-index/fixture.js';

/**
 * `context related` over the miniature active root.
 *
 * What matters is the contract the two callers depend on: excluded refs never
 * come back, the budget bounds what is printed, and every failure yields an
 * empty list with a reason instead of an exception.
 */

let dir: string;
let root: string;
let dbPath: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-related-'));
  root = path.join(dir, 'active');
  dbPath = path.join(dir, 'graph.sqlite3');
  scaffold(root);
  (await refreshInto(dbPath, root)).db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const related = (input: Partial<RelatedInput> & { text: string }) =>
  relatedContext({ dbPath, activeRoot: root, ...input });

describe('relatedContext', () => {
  it('returns openable hits and the query that found them', async () => {
    const result = await related({ text: 'the alpha lesson', initiative: 'alpha' });

    expect(result.degraded).toEqual([]);
    expect(result.query.terms).toEqual(['alpha', 'lesson']);
    expect(result.hits[0]).toMatchObject({
      ref: 'note:alpha/2026-09-02-alpha-lesson.md',
      class: 'notes',
      initiative: 'alpha',
      title: 'The alpha lesson',
      path: 'alpha/sources/notes/2026-09-02-alpha-lesson.md',
    });
    expect(result.hits[0]!.excerpt).toBeTruthy();
  });

  it('never returns an excluded ref, and fills its place from further down', async () => {
    const top = await related({ text: 'indexer converges', limit: 6 });
    const [first, second] = top.hits.map((hit) => hit.ref);

    const result = await related({ text: 'indexer converges', limit: 3, exclude: [first!] });

    expect(result.hits.map((hit) => hit.ref)).not.toContain(first);
    expect(result.hits[0]!.ref).toBe(second);
  });

  it('searches only the classes asked for', async () => {
    const result = await related({ text: 'indexer converges', classes: ['tasks'] });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(new Set(result.hits.map((hit) => hit.class))).toEqual(new Set(['tasks']));
  });

  it('leaves transcripts out unless a caller names them', async () => {
    const result = await related({ text: 'indexer written' });

    expect(result.hits.every((hit) => hit.class !== 'transcripts')).toBe(true);
  });

  it('stops at the first hit that would overflow the budget', async () => {
    const result = await related({ text: 'lesson', render: () => 'x'.repeat(40), budget: 100 });

    expect(result.hits).toHaveLength(2);
  });

  it('carries the winning span as a byte range into the file', async () => {
    const result = await related({ text: 'the alpha lesson', initiative: 'alpha' });
    const [top] = result.hits;
    const file = readFileSync(path.join(root, top!.path!));

    expect(top!.byteOffset).toBeGreaterThanOrEqual(0);
    expect(top!.byteLength).toBeGreaterThan(0);
    expect(top!.byteOffset! + top!.byteLength!).toBeLessThanOrEqual(file.length);
  });

  it('degrades to no hits when the index is missing, without creating it', async () => {
    const missing = path.join(dir, 'absent.sqlite3');

    const result = await related({ text: 'lesson', dbPath: missing });

    expect(result.hits).toEqual([]);
    expect(result.degraded).toEqual([
      expect.objectContaining({ source: 'index', reason: 'missing' }),
    ]);
    expect(existsSync(missing)).toBe(false);
  });

  it('degrades to no hits when the index cannot be opened', async () => {
    const corrupt = path.join(dir, 'corrupt.sqlite3');
    writeFileSync(corrupt, 'not a database');

    const result = await related({ text: 'lesson', dbPath: corrupt });

    expect(result.hits).toEqual([]);
    expect(result.degraded[0]).toMatchObject({ source: 'index', reason: 'error' });
  });

  it('degrades to no hits when every retriever throws', async () => {
    const db = new Database(dbPath);
    db.exec('DROP TABLE search_fts');
    db.close();

    const result = await related({ text: 'lesson' });

    expect(result.hits).toEqual([]);
    expect(result.degraded.length).toBeGreaterThan(0);
  });

  it('degrades to no hits on empty text and on text with no usable terms', async () => {
    for (const text of ['', '   ', 'it is the of']) {
      const result = await related({ text });
      expect(result.hits).toEqual([]);
      expect(result.degraded[0]).toMatchObject({ source: 'query', reason: 'empty' });
    }
  });
});

describe('withinBudget', () => {
  it('keeps rank order and cuts at the first overflow rather than skipping ahead', () => {
    const kept = withinBudget(['aaaa', 'bbbbbbbb', 'c'], 10, (hit) => hit);

    expect(kept).toEqual(['aaaa']);
  });
});
