// Unit tests for the pure scoring logic of tools/eval-miner.mjs. The full
// corpus eval needs the operator's private ~/.claude transcripts (not available
// in CI), but the precision/coverage/attribute math is deterministic and is the
// part that must stay correct — so it is exercised here, in CI.
import { describe, it, expect } from 'vitest';
// @ts-expect-error — importing a plain .mjs (no type declarations) from a test.
import { score, attrAccuracy, round } from '../../tools/eval-miner.mjs';

describe('score', () => {
  it('computes precision and coverage from the intersection', () => {
    const r = score([1, 2, 3], [2, 3, 4]);
    expect(r.reported).toBe(3);
    expect(r.truth).toBe(3);
    expect(r.hits).toBe(2);
    expect(r.precision).toBe(0.6667);
    expect(r.coverage).toBe(0.6667);
  });

  it('reports 1.0 precision for an all-real set and coverage < 1 when truth is larger', () => {
    const r = score([1, 2], [1, 2, 3, 4]);
    expect(r.precision).toBe(1);
    expect(r.coverage).toBe(0.5);
    expect(r.missesFromReported).toEqual([]);
  });

  it('lists reported items absent from truth', () => {
    const r = score(['a', 'b', '/'], ['a', 'b']);
    expect(r.precision).toBe(0.6667);
    expect(r.missesFromReported).toEqual(['/']);
  });

  it('treats an empty reported set as vacuously precise', () => {
    const r = score([], [1, 2]);
    expect(r.precision).toBe(1);
    expect(r.coverage).toBe(0);
  });

  it('normalizes types so numeric and string ids match', () => {
    expect(score([55], ['55']).hits).toBe(1);
  });
});

describe('attrAccuracy', () => {
  const truth = new Map([
    ['54', { branch: 'feat/a', merged: true }],
    ['55', { branch: 'feat/b', merged: false }],
  ]);

  it('scores branch + merged agreement over the shared PRs', () => {
    const r = attrAccuracy(
      [
        { number: 54, branch: 'feat/a', merged: true }, // match
        { number: 55, branch: 'feat/b', merged: true }, // merged mismatch
      ],
      truth,
    );
    expect(r.checked).toBe(2);
    expect(r.accurate).toBe(1);
    expect(r.accuracy).toBe(0.5);
  });

  it('is vacuously accurate when no PRs overlap ground truth', () => {
    expect(attrAccuracy([{ number: 999, branch: 'x', merged: false }], truth)).toEqual({
      checked: 0,
      accurate: 0,
      accuracy: 1,
    });
  });
});

describe('round', () => {
  it('rounds to four decimal places', () => {
    expect(round(0.666666)).toBe(0.6667);
    expect(round(1)).toBe(1);
  });
});
