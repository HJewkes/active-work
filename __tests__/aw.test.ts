import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NotFoundError } from '../src/errors.js';

const runMock = vi.fn();

vi.mock('../src/commands/open.js', () => ({
  default: {
    args: { parse: (input: unknown) => input },
    run: runMock,
  },
}));

const { openSlugOrInit } = await import('../src/aw.js');

describe('openSlugOrInit (TP-356 reviewer nit)', () => {
  let isTTY: boolean | undefined;

  beforeEach(() => {
    isTTY = process.stdin.isTTY;
    runMock.mockReset();
  });

  afterEach(() => {
    process.stdin.isTTY = isTTY;
  });

  it('rethrows a NotFoundError with the kebab-case hint appended for an invalid-slug miss on a TTY', async () => {
    process.stdin.isTTY = true;
    const original = "No initiative matches 'New_Thing'. Known: a, b";
    runMock.mockRejectedValue(new NotFoundError(original, { reason: 'no_match' }));

    await expect(openSlugOrInit('New_Thing', false)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).code).toBe(66);
      expect((err as Error).message).toContain(original);
      expect((err as Error).message).toContain(
        'To create it, use a lowercase kebab-case slug (e.g. my-new-thing).',
      );
      return true;
    });
  });
});
