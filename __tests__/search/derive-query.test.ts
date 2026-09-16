import { describe, expect, it } from 'vitest';

import { deriveQuery, type DocumentFrequency } from '../../src/search/derive-query.js';

const frequencies =
  (counts: Record<string, number>): DocumentFrequency =>
  (term) =>
    counts[term] ?? 0;

describe('deriveQuery', () => {
  it('picks the rarest terms rather than the first ones', () => {
    const df = frequencies({ common: 900, usual: 500, rare: 3, rarer: 1 });

    const query = deriveQuery('common usual rare rarer', df, 2);

    expect(query.terms).toEqual(['rarer', 'rare']);
  });

  it('breaks rarity ties by first appearance, so the same text derives the same query', () => {
    expect(deriveQuery('zeta alpha mid', frequencies({ mid: 5 }), 2).terms).toEqual([
      'zeta',
      'alpha',
    ]);
  });

  it('never lets a commit hash win on rarity', () => {
    const query = deriveQuery('merged 9f3c2ab1 and deadbeef00 into main', frequencies({}), 2);

    expect(query.terms).toEqual(['merged', 'main']);
  });

  it('keeps a short hex-looking word, which is not a hash', () => {
    expect(deriveQuery('cafe decade', frequencies({}), 5).terms).toEqual(['cafe', 'decade']);
  });

  it('appends every task id even when rarity already filled the limit', () => {
    const query = deriveQuery('TP-84 scored recall; see AW-138 and ranker', frequencies({}), 1);

    expect(query.terms).toEqual(['scored', 'tp-84', 'aw-138']);
  });

  it('quotes terms into an OR expression FTS5 can parse', () => {
    expect(deriveQuery('TP-84 harness', frequencies({}), 5).expression).toBe(
      '"harness" OR "tp-84"',
    );
  });

  it('derives nothing from text that is all stop words and short tokens', () => {
    expect(deriveQuery('it is on the of a b', frequencies({}))).toEqual({
      terms: [],
      expression: '',
    });
  });
});
