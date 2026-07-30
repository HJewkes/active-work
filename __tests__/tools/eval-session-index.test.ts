// Unit tests for the pure helpers of tools/eval-session-index.mjs. The full
// eval needs the operator's private ~/.claude corpus (not available in CI), but
// the digest/boundary/median math decides whether a real divergence is reported
// or silently swallowed — so it is exercised here, in CI.
import { describe, it, expect } from 'vitest';
import {
  median,
  lineBoundaries,
  truncationStages,
  digestRows,
  diffDigests,
  shortTranscriptPath,
  normalizeRows,
  // @ts-expect-error — importing a plain .mjs (no type declarations) from a test.
} from '../../tools/eval-session-index.mjs';

describe('median', () => {
  it('picks the middle of an odd sample regardless of input order', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('averages the two middles of an even sample', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('is 0 for an empty sample', () => {
    expect(median([])).toBe(0);
  });
});

describe('lineBoundaries', () => {
  it('returns the offset just past every newline', () => {
    expect(lineBoundaries(Buffer.from('ab\ncd\n'))).toEqual([3, 6]);
  });

  it('ignores a trailing partial line', () => {
    expect(lineBoundaries(Buffer.from('ab\ncd'))).toEqual([3]);
  });
});

describe('truncationStages', () => {
  it('spreads interior cuts across the lines, always on a boundary', () => {
    const buffer = Buffer.from('a\nb\nc\nd\ne\nf\n');
    const stages = truncationStages(buffer, 2);

    // Six lines, two interior cuts: after line 3 and after line 5.
    expect(stages).toEqual([6, 10]);
    for (const offset of stages) expect(buffer[offset - 1]).toBe(0x0a);
  });

  it('has nothing to stage for a single-line transcript', () => {
    expect(truncationStages(Buffer.from('a\n'), 2)).toEqual([]);
  });
});

describe('digestRows', () => {
  it('is stable for identical row sets and sensitive to any field change', () => {
    const rows = [{ a: 1, b: 'x' }];

    expect(digestRows(rows)).toBe(digestRows([{ a: 1, b: 'x' }]));
    expect(digestRows(rows)).not.toBe(digestRows([{ a: 1, b: 'y' }]));
  });

  it('is order-sensitive, so a query without a deterministic ORDER BY is caught', () => {
    expect(digestRows([{ a: 1 }, { a: 2 }])).not.toBe(digestRows([{ a: 2 }, { a: 1 }]));
  });
});

describe('diffDigests', () => {
  it('names only the tables that differ, sorted', () => {
    const a = { facts: 'h1', turns: 'h2', edges: 'h3' };
    const b = { facts: 'h1', turns: 'CHANGED', edges: 'ALSO' };

    expect(diffDigests(a, b)).toEqual(['edges', 'turns']);
  });

  it('treats a table present on one side only as a difference', () => {
    expect(diffDigests({ facts: 'h' }, { facts: 'h', spans: 'x' })).toEqual(['spans']);
  });
});

describe('shortTranscriptPath', () => {
  it('reduces any root to <project>/<session>.jsonl', () => {
    expect(shortTranscriptPath('~/.claude/projects/demo/s1.jsonl')).toBe('demo/s1.jsonl');
    expect(shortTranscriptPath('/tmp/replay-root/demo/s1.jsonl')).toBe('demo/s1.jsonl');
  });

  it('lets three replay roots agree on the same key', () => {
    const rows = [{ path: '/a/b/demo/s.jsonl', byte_offset: 0 }];
    const other = [{ path: '/x/y/demo/s.jsonl', byte_offset: 0 }];

    expect(digestRows(normalizeRows(rows))).toBe(digestRows(normalizeRows(other)));
  });

  it('leaves rows without a path column untouched', () => {
    expect(normalizeRows([{ session_id: 's' }])).toEqual([{ session_id: 's' }]);
  });
});
