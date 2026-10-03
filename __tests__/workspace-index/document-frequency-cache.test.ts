import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { graphDocumentFrequency } from '../../src/search/document-frequency.js';
import { openGraph, type WorkspaceGraph } from '../../src/session-index/graph.js';
import { refreshWorkspace } from '../../src/workspace-index/refresh.js';
import { scaffold, writeFile } from './fixture.js';

let dir: string;
let root: string;
let graph: WorkspaceGraph;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-df-cache-'));
  root = path.join(dir, 'active-root');
  scaffold(root);
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
  await refreshWorkspace(graph, { activeRoot: root });
});

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fileDesign(name: string): void {
  writeFile(root, `beta/sources/${name}.md`, `# ${name}\n\nThe indexer has a ${name} marker.\n`);
}

describe('document frequency across workspace passes', () => {
  it('counts a term higher after a pass indexes more spans containing it', async () => {
    const frequency = graphDocumentFrequency(graph);
    const before = frequency('indexer');

    fileDesign('extra-one');
    await refreshWorkspace(graph, { activeRoot: root });

    expect(frequency('indexer')).toBeGreaterThan(before);
  });

  it('keeps the cached count when a pass writes no spans', async () => {
    const frequency = graphDocumentFrequency(graph);
    const before = frequency('indexer');
    graph.db.prepare('DELETE FROM search_span').run();

    await refreshWorkspace(graph, { activeRoot: root });

    expect(frequency('indexer')).toBe(before);
  });
});
