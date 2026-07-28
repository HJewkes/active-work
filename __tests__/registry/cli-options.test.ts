import { describe, expect, it } from 'vitest';
import { readCommanderOption } from '../../src/registry/cli-options.js';

/** Mirrors `flagToKey` in src/registry: `--tasks-filed` -> `tasks_filed`. */
const flagToKey = (long: string): string => long.replace(/^--/, '').replace(/-/g, '_');

const read = (opts: Record<string, unknown>, long: string): unknown =>
  readCommanderOption(opts, long, flagToKey);

describe('readCommanderOption', () => {
  describe('negated flags', () => {
    // `wrap --no-loops` shipped inert: commander stores the negation under the
    // positive key, so reading `no_loops` by its own name never saw it, and
    // wrap refused every ledger the flag was supposed to waive.
    it('reads --no-loops off the negated positive key', () => {
      expect(read({ loops: false }, '--no-loops')).toBe(true);
    });

    it('is undefined when the negation was not passed', () => {
      expect(read({ loops: true }, '--no-loops')).toBeUndefined();
      expect(read({}, '--no-loops')).toBeUndefined();
    });

    it('camelCases a multi-word stem before reading it', () => {
      expect(read({ tasksFiled: false }, '--no-tasks-filed')).toBe(true);
    });
  });

  describe('value flags', () => {
    it('reads a camelCased key', () => {
      expect(read({ tasksFiled: '["AW-1"]' }, '--tasks-filed')).toBe('["AW-1"]');
    });

    it('falls back to the snake_case key', () => {
      expect(read({ tasks_filed: '["AW-1"]' }, '--tasks-filed')).toBe('["AW-1"]');
    });

    // --notes and --no-notes share one commander key. Without this the
    // negation is handed to the value flag and fails schema validation.
    it('ignores the false a paired negation leaves behind', () => {
      expect(read({ notes: false }, '--notes')).toBeUndefined();
    });

    it('still reads a real value when the pair exists', () => {
      expect(read({ notes: '[]' }, '--notes')).toBe('[]');
    });

    it('is undefined when absent', () => {
      expect(read({}, '--body')).toBeUndefined();
    });
  });
});
