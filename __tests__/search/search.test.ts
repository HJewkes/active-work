import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkspaceGraph } from '../../src/session-index/graph.js';
import { searchWorkspace } from '../../src/search/index.js';
import { SEARCH_CLASSES, capFor, classOf } from '../../src/search/classes.js';
import { refreshInto, scaffold, writeFile } from '../workspace-index/fixture.js';

/**
 * Search over the miniature active root.
 *
 * The properties worth asserting are the ones the design turns on: every
 * initiative is in scope by default, a class cannot fill the page on its own,
 * and a result names a real file with real text from it.
 */

let dir: string;
let root: string;
let graph: WorkspaceGraph;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-search-'));
  root = path.join(dir, 'active');
  scaffold(root);
  graph = await refreshInto(path.join(dir, 'graph.sqlite3'), root);
});

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const search = (query: string, options = {}) =>
  searchWorkspace(query, { graph, activeRoot: root, ...options });

describe('search', () => {
  it('reaches every initiative without being asked to', async () => {
    const { hits } = await search('lesson');
    const initiatives = new Set(hits.map((hit) => hit.initiative));

    expect(initiatives).toContain('alpha');
    expect(initiatives).toContain('beta');
  });

  it('resolves a hit to a real file and reads the excerpt back out of it', async () => {
    const { hits } = await search('Prose a search should find');
    const hit = hits.find((h) => h.path?.endsWith('design.md'));

    expect(hit).toBeDefined();
    expect(hit!.class).toBe('sources');
    expect(hit!.initiative).toBe('beta');
    // Read from the file through the span's locator; nothing stores text twice.
    expect(hit!.excerpt).toContain('Prose a search should find');
  });

  it('lets no single class fill the page', async () => {
    // Every class matches "index" in this fixture, so an uncapped run would
    // return one class's whole list — which is what it did before shares.
    for (let i = 0; i < 12; i++) {
      writeFile(
        root,
        `alpha/sources/notes/2026-09-04-filler-${i}.md`,
        `---\nkind: fyi\ntitle: Filler ${i}\ncreated: 2026-09-04\n---\n\nthe indexer converges\n`,
      );
    }
    graph.db.close();
    graph = await refreshInto(path.join(dir, 'graph.sqlite3'), root, true);

    const { hits } = await search('indexer converges', { limit: 10 });
    const notes = hits.filter((hit) => hit.class === 'notes');

    expect(hits.length).toBeGreaterThan(notes.length);
    expect(notes.length).toBeLessThanOrEqual(capFor(SEARCH_CLASSES[0]!, 10));
  });

  it('biases towards an initiative without excluding the others', async () => {
    const { hits } = await search('lesson', { initiative: 'beta' });

    expect(hits[0]!.initiative).toBe('beta');
    // A boost, never a filter: alpha still ranks.
    expect(hits.map((hit) => hit.initiative)).toContain('alpha');
  });

  it('scales a class cap with the requested limit', async () => {
    const notes = SEARCH_CLASSES[0]!;
    expect(capFor(notes, 10)).toBe(5);
    expect(capFor(notes, 50)).toBe(25);
    // Never zero, or a class silently stops participating in a small search.
    expect(capFor(SEARCH_CLASSES[1]!, 1)).toBe(1);
  });

  it('tells a session record from a transcript, which their shared prefix cannot', async () => {
    expect(classOf('session:abc', 'body')).toBe('sessions');
    expect(classOf('session:abc', 'tool_result')).toBe('transcripts');
    expect(classOf('note:a/b.md', 'body')).toBe('notes');
  });

  it('answers an empty query with nothing rather than everything', async () => {
    expect((await search('   ')).hits).toEqual([]);
  });

  it('reports no degradation when every retriever answers', async () => {
    const { degraded } = await search('lesson');
    expect(degraded).toEqual([]);
  });

  it('answers with nothing when there is no index, rather than failing', async () => {
    // The index is derived and disposable, so every reader of it has to survive
    // its absence. A search that throws would make the index load-bearing.
    const result = await searchWorkspace('lesson', {
      dbPath: path.join(dir, 'absent.sqlite3'),
      activeRoot: root,
    });

    expect(result.hits).toEqual([]);
    expect(result.degraded).toEqual([]);
  });

  it('survives a retriever that throws, naming it instead of failing', async () => {
    // Drop the table one retriever reads, so its query throws for real.
    graph.db.exec('DROP TABLE search_span');

    const result = await search('lesson');

    expect(result.degraded.length).toBe(SEARCH_CLASSES.length);
    expect(result.degraded.map((entry) => entry.retriever).sort()).toEqual(
      SEARCH_CLASSES.map((cls) => cls.name).sort(),
    );
    expect(result.hits).toEqual([]);
  });
});
