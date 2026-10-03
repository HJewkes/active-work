import { describe, expect, it } from 'vitest';

import { createDirtySet } from '../../src/session-index/dirty-set.js';

describe('createDirtySet', () => {
  it('marks the root unknown when the watcher reports no file name', () => {
    const dirty = createDirtySet();

    dirty.add('/r', null);

    expect(dirty.size).toBe(1);
    expect(dirty.drain()).toEqual({ paths: [], unknownRoots: ['/r'] });
  });

  it('ignores paths that are not jsonl transcripts', () => {
    const dirty = createDirtySet();

    dirty.add('/r', 'demo/notes.txt');
    dirty.add('/r', 'demo');

    expect(dirty.size).toBe(0);
    expect(dirty.drain()).toEqual({ paths: [], unknownRoots: [] });
  });

  it('keeps one absolute path per file however often it changes', () => {
    const dirty = createDirtySet();

    dirty.add('/r', 'demo/a.jsonl');
    dirty.add('/r', 'demo/a.jsonl');

    expect(dirty.drain().paths).toEqual(['/r/demo/a.jsonl']);
  });

  it('is empty after a drain', () => {
    const dirty = createDirtySet();
    dirty.add('/r', 'demo/a.jsonl');
    dirty.add('/r', null);

    dirty.drain();

    expect(dirty.size).toBe(0);
    expect(dirty.drain()).toEqual({ paths: [], unknownRoots: [] });
  });
});
