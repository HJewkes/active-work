import { describe, expect, it } from 'vitest';
import { NOTE_READ_IF_MAX_LENGTH, NoteFrontmatterSchema } from '../../src/schemas/note.js';

const base = { kind: 'gotcha', title: 'Sample lesson', created: '2026-03-04' } as const;

describe('note frontmatter read_if', () => {
  it.each([
    { scenario: 'absent', input: {}, expected: undefined },
    {
      scenario: 'a short condition',
      input: { read_if: 'touching the widget cache' },
      expected: 'touching the widget cache',
    },
    {
      scenario: 'surrounding whitespace, trimmed',
      input: { read_if: '  editing sample config \n' },
      expected: 'editing sample config',
    },
    {
      scenario: 'exactly the maximum length',
      input: { read_if: 'x'.repeat(NOTE_READ_IF_MAX_LENGTH) },
      expected: 'x'.repeat(NOTE_READ_IF_MAX_LENGTH),
    },
  ])('accepts $scenario', ({ input, expected }) => {
    const result = NoteFrontmatterSchema.parse({ ...base, ...input });

    expect(result.read_if).toBe(expected);
  });

  it.each([
    {
      scenario: 'one character over the maximum',
      read_if: 'x'.repeat(NOTE_READ_IF_MAX_LENGTH + 1),
      message: `at most ${NOTE_READ_IF_MAX_LENGTH} characters`,
    },
    {
      scenario: 'a multi-line value',
      read_if: 'first line\nsecond line',
      message: 'single line',
    },
    { scenario: 'a carriage return', read_if: 'one\rtwo', message: 'single line' },
    { scenario: 'only whitespace', read_if: '   ', message: 'must not be empty' },
  ])('refuses $scenario with a clear message', ({ read_if, message }) => {
    const result = NoteFrontmatterSchema.safeParse({ ...base, read_if });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(message);
  });
});
