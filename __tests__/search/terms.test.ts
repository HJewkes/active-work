import { describe, expect, it } from 'vitest';

import { isTaskId, meaningfulTerms, orExpression, tokenize } from '../../src/search/terms.js';

describe('tokenize', () => {
  it('keeps task ids whole and drops other short tokens', () => {
    expect(tokenize('TP-84 at k=10 on AW-138, see ui')).toEqual(['tp-84', 'aw-138', 'see']);
  });

  it('does not read a date as a task id', () => {
    expect(tokenize('2026-09-11')).toEqual(['2026']);
  });
});

describe('isTaskId', () => {
  it('accepts letters, a hyphen and digits, in either case', () => {
    expect(isTaskId('TP-84')).toBe(true);
    expect(isTaskId('tp-84')).toBe(true);
    expect(isTaskId('84-tp')).toBe(false);
  });
});

describe('meaningfulTerms', () => {
  it('drops stop words and duplicates', () => {
    expect(meaningfulTerms('the index and the index TP-1')).toEqual(['index', 'tp-1']);
  });
});

describe('orExpression', () => {
  it('quotes every term so a hyphen cannot read as an FTS5 operator', () => {
    expect(orExpression(['tp-84', 'say "hi"'])).toBe('"tp-84" OR "say ""hi"""');
  });
});
