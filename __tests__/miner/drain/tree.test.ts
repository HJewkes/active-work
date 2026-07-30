import { describe, expect, it } from 'vitest';

import { DrainTree } from '../../../src/miner/drain/tree.js';

describe('DrainTree', () => {
  it('creates a new cluster for the first line', () => {
    const tree = new DrainTree();
    const result = tree.insert(['error', 'TS1234:', 'Cannot', 'find', 'module', 'a.ts']);
    expect(result.isNew).toBe(true);
    expect(result.cluster.size).toBe(1);
    expect(tree.clusterCount).toBe(1);
  });

  it('joins an identical line to the same cluster without generalizing', () => {
    const tree = new DrainTree();
    const line = ['error', 'TS1234:', 'Cannot', 'find', 'module', 'a.ts'];
    const first = tree.insert([...line]);
    const second = tree.insert([...line]);

    expect(second.isNew).toBe(false);
    expect(second.templateChanged).toBe(false);
    expect(second.cluster.clusterId).toBe(first.cluster.clusterId);
    expect(second.cluster.size).toBe(2);
    expect(tree.clusterCount).toBe(1);
  });

  it('generalizes a differing position to the wildcard on join', () => {
    const tree = new DrainTree({ simTh: 0.5 });
    tree.insert(['error', 'TS1234:', 'Cannot', 'find', 'module', 'a.ts']);
    const second = tree.insert(['error', 'TS1234:', 'Cannot', 'find', 'module', 'b.ts']);

    expect(second.isNew).toBe(false);
    expect(second.templateChanged).toBe(true);
    expect(second.cluster.tokens).toEqual(['error', 'TS1234:', 'Cannot', 'find', 'module', '<*>']);
  });

  it('never re-tightens a wildcarded position once generalized', () => {
    const tree = new DrainTree({ simTh: 0.5 });
    tree.insert(['error', 'TS1234:', 'a.ts']);
    tree.insert(['error', 'TS1234:', 'b.ts']);
    const third = tree.insert(['error', 'TS1234:', 'a.ts']);
    expect(third.cluster.tokens).toEqual(['error', 'TS1234:', '<*>']);
  });

  it('keeps lines of different token counts in separate clusters', () => {
    const tree = new DrainTree();
    tree.insert(['a', 'b']);
    tree.insert(['a', 'b', 'c']);
    expect(tree.clusterCount).toBe(2);
  });

  it('does not merge two dissimilar same-length lines below sim_th', () => {
    const tree = new DrainTree({ simTh: 0.6 });
    tree.insert(['error', 'TS1234:', 'Cannot', 'find', 'module', 'a.ts']);
    const second = tree.insert(['FAIL', 'suite', 'timeout', 'after', '30000', 'ms']);
    expect(second.isNew).toBe(true);
    expect(tree.clusterCount).toBe(2);
  });

  it('collapses high-cardinality branches to a wildcard overflow node', () => {
    const tree = new DrainTree({ maxChildren: 2, simTh: 0.99 });
    // Distinct first tokens beyond maxChildren should all route through the
    // same overflow branch and land in a shared leaf's cluster list rather
    // than growing the tree unboundedly.
    tree.insert(['alpha', 'x']);
    tree.insert(['bravo', 'x']);
    tree.insert(['charlie', 'x']);
    tree.insert(['delta', 'x']);
    // All four are distinct clusters (sim_th is strict), but they must not
    // throw or silently drop — the tree should still accept every insert.
    expect(tree.clusterCount).toBe(4);
  });

  it('evicts the least-recently-used cluster once maxClusters is exceeded', () => {
    const tree = new DrainTree({ maxClusters: 2, simTh: 0.99 });
    tree.insert(['one']);
    tree.insert(['two']);
    tree.insert(['three']);
    expect(tree.clusterCount).toBe(2);

    // 'one' should have been evicted (LRU); re-inserting it creates a new cluster.
    const result = tree.insert(['one']);
    expect(result.isNew).toBe(true);
  });

  it('refreshes recency on cluster join, protecting recently-used clusters from eviction', () => {
    const tree = new DrainTree({ maxClusters: 2, simTh: 0.99 });
    tree.insert(['one']);
    tree.insert(['two']);
    // Touch 'one' again so 'two' becomes the least-recently-used.
    tree.insert(['one']);
    tree.insert(['three']);

    const result = tree.insert(['one']);
    expect(result.isNew).toBe(false);
  });
});
