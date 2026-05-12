import { describe, expect, it } from 'vitest';
import { nowIso, today } from '../../src/utils/today.js';

describe('today', () => {
  it('returns a zero-padded YYYY-MM-DD string', () => {
    const value = today();
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches the local calendar date', () => {
    const value = today();
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(value).toBe(expected);
  });
});

describe('nowIso', () => {
  it('returns a parseable ISO 8601 string with milliseconds', () => {
    const value = nowIso();
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(value))).toBe(false);
  });
});
