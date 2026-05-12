import { describe, expect, it } from 'vitest';
import { derivePrefix, validateSlug } from '../../src/utils/slug.js';

describe('validateSlug', () => {
  it.each([
    ['ec-personalization'],
    ['foo'],
    ['a-b-c-d'],
    ['inbox'],
    ['auth-service-v2'],
    ['a1'],
    ['ab'],
  ])('accepts %s', (slug) => {
    expect(validateSlug(slug)).toEqual({ ok: true });
  });

  it.each([
    ['', 'non-empty'],
    ['-foo', 'kebab-case'],
    ['foo-', 'kebab-case'],
    ['Foo', 'kebab-case'],
    ['foo--bar', 'consecutive dashes'],
    ['foo bar', 'kebab-case'],
    ['1foo', 'kebab-case'],
    ['a', 'at least 2'],
    ['a'.repeat(61), 'at most 60'],
  ])('rejects %s', (slug, hint) => {
    const result = validateSlug(slug);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain(hint.toLowerCase());
    }
  });

  it('returns descriptive errors for non-string input', () => {
    // @ts-expect-error – exercising runtime guard
    const result = validateSlug(undefined);
    expect(result).toEqual({ ok: false, error: 'slug must be a non-empty string' });
  });
});

describe('derivePrefix', () => {
  it.each([
    ['ec-personalization', 'EP'],
    ['inbox', 'I'],
    ['auth-service-v2', 'ASV'],
    ['a-b-c-d', 'ABCD'],
  ])('derives %s -> %s', (slug, expected) => {
    expect(derivePrefix(slug)).toBe(expected);
  });

  it('truncates to 8 characters', () => {
    const slug = 'a-b-c-d-e-f-g-h-i-j';
    expect(derivePrefix(slug)).toBe('ABCDEFGH');
    expect(derivePrefix(slug)).toHaveLength(8);
  });
});
