import { describe, expect, it } from 'vitest';

import { DrainTree } from '@titan-design/cluster';

/**
 * The package owns Drain's behaviour and tests it. What active-work still has
 * standing to assert is that the package's *default* cluster cap is sized for
 * this corpus: AW-92 raised it because the busiest partition evicted
 * continuously at the old 2000, and a default that drifts back down would
 * silently reintroduce order-dependent clustering here.
 */
describe('Drain capacity for the active-work corpus', () => {
  it('holds the real corpus steady state without evicting (AW-92)', () => {
    // The busiest partition (Bash) converges on ~2.3k clusters over the
    // operator's 23k-blob corpus.
    const tree = new DrainTree({ simTh: 0.99 });
    for (let i = 0; i < 2500; i++) tree.insert([`shape${i}`]);
    expect(tree.atCapacity).toBe(false);
    expect(tree.clusterCount).toBe(2500);
  });
});
