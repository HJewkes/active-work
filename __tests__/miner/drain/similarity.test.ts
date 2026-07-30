import { describe, expect, it } from 'vitest';

import { mergeTemplate, tokenSimilarity } from '../../../src/miner/drain/similarity.js';

describe('tokenSimilarity', () => {
  it('returns 1 for identical token sequences', () => {
    expect(tokenSimilarity(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
  });

  it('returns 0 for a fully disjoint sequence', () => {
    expect(tokenSimilarity(['a', 'b', 'c'], ['x', 'y', 'z'])).toBe(0);
  });

  it('counts wildcard positions in the template as matches', () => {
    expect(tokenSimilarity(['<*>', 'b', 'c'], ['anything', 'b', 'c'])).toBe(1);
  });

  it('scores partial overlap proportionally', () => {
    expect(tokenSimilarity(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'y'])).toBe(0.5);
  });

  it('returns 1 for two empty sequences', () => {
    expect(tokenSimilarity([], [])).toBe(1);
  });

  it('throws on mismatched lengths', () => {
    expect(() => tokenSimilarity(['a'], ['a', 'b'])).toThrow();
  });
});

describe('mergeTemplate', () => {
  it('keeps positions that already match', () => {
    expect(mergeTemplate(['a', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('generalizes disagreeing positions to the wildcard', () => {
    expect(mergeTemplate(['a', 'b'], ['a', 'x'])).toEqual(['a', '<*>']);
  });

  it('never tightens an already-wildcarded position', () => {
    expect(mergeTemplate(['<*>', 'b'], ['anything', 'b'])).toEqual(['<*>', 'b']);
  });

  it('throws on mismatched lengths', () => {
    expect(() => mergeTemplate(['a'], ['a', 'b'])).toThrow();
  });
});
