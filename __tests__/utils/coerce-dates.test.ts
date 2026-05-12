import { describe, expect, it } from 'vitest';
import { coerceDates } from '../../src/utils/coerce-dates.js';

describe('coerceDates', () => {
  it('passes through primitives unchanged', () => {
    expect(coerceDates(null)).toBeNull();
    expect(coerceDates(undefined)).toBeUndefined();
    expect(coerceDates(42)).toBe(42);
    expect(coerceDates('hello')).toBe('hello');
    expect(coerceDates(true)).toBe(true);
  });

  it('converts midnight-UTC Date to YYYY-MM-DD', () => {
    const d = new Date('2026-05-10T00:00:00.000Z');
    expect(coerceDates(d)).toBe('2026-05-10');
  });

  it('converts non-midnight Date to full ISO 8601', () => {
    const d = new Date('2026-05-10T14:30:45.123Z');
    expect(coerceDates(d)).toBe('2026-05-10T14:30:45.123Z');
  });

  it('walks nested objects', () => {
    const input = {
      title: 'x',
      updated: new Date('2026-05-10T00:00:00.000Z'),
      nested: {
        started: new Date('2026-05-10T14:30:00.000Z'),
        count: 3,
      },
    };
    expect(coerceDates(input)).toEqual({
      title: 'x',
      updated: '2026-05-10',
      nested: {
        started: '2026-05-10T14:30:00.000Z',
        count: 3,
      },
    });
  });

  it('walks arrays', () => {
    const input = [
      { last_commit: new Date('2026-05-09T00:00:00.000Z') },
      { last_commit: new Date('2026-05-10T00:00:00.000Z') },
    ];
    expect(coerceDates(input)).toEqual([
      { last_commit: '2026-05-09' },
      { last_commit: '2026-05-10' },
    ]);
  });

  it('preserves the input shape (does not mutate)', () => {
    const date = new Date('2026-05-10T00:00:00.000Z');
    const input = { updated: date };
    coerceDates(input);
    expect(input.updated).toBe(date);
  });
});
