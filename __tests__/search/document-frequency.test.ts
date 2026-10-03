import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countMatches } from '../../src/search/document-frequency.js';
import { openGraph, type SessionGraph } from '../../src/session-index/graph.js';

let dir: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-df-'));
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
});

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function indexSpans(word: string, count: number): void {
  for (let i = 0; i < count; i++) {
    graph.spans.index(
      {
        ownerRef: `session:${word}-${i}`,
        field: 'text',
        sourceId: 1,
        byteOffset: i,
        byteLength: 1,
      },
      `${word} filler`,
    );
  }
}

describe('countMatches', () => {
  it('counts every match when the term has fewer than the cap', () => {
    indexSpans('rare', 3);
    indexSpans('other', 4);

    expect(countMatches(graph as never, '"rare"', 10)).toBe(3);
  });

  it('stops at the cap when the term has more matches than it', () => {
    indexSpans('common', 15);

    expect(countMatches(graph as never, '"common"', 10)).toBe(10);
  });
});
