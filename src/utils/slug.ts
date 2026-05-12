const SLUG_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const MIN_LEN = 2;
const MAX_LEN = 60;
const MAX_PREFIX_LEN = 8;

export type SlugValidation = { ok: true } | { ok: false; error: string };

/**
 * Validate a kebab-case slug.
 *
 * Rules:
 *  - 2-60 characters long
 *  - lowercase letters, digits, and `-` only
 *  - starts with a letter, ends with a letter or digit
 *  - no consecutive dashes
 */
export function validateSlug(s: string): SlugValidation {
  if (typeof s !== 'string' || s.length === 0) {
    return { ok: false, error: 'slug must be a non-empty string' };
  }
  if (s.length < MIN_LEN) {
    return { ok: false, error: `slug must be at least ${MIN_LEN} characters` };
  }
  if (s.length > MAX_LEN) {
    return { ok: false, error: `slug must be at most ${MAX_LEN} characters` };
  }
  if (s.includes('--')) {
    return { ok: false, error: 'slug must not contain consecutive dashes' };
  }
  if (!SLUG_PATTERN.test(s)) {
    return {
      ok: false,
      error:
        'slug must be lowercase kebab-case: start with a letter, end with a letter or digit, allow [a-z0-9-]',
    };
  }
  return { ok: true };
}

/**
 * Derive a Jira-style task prefix from a slug.
 *
 * Takes the first character of each `-`-separated segment, uppercases each,
 * and concatenates. Truncates to 8 characters.
 *
 * @example
 *   derivePrefix('ec-personalization') // 'EP'
 *   derivePrefix('inbox')              // 'I'
 *   derivePrefix('auth-service-v2')    // 'ASV'
 */
export function derivePrefix(slug: string): string {
  const letters = slug
    .split('-')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0]!.toUpperCase())
    .join('');
  return letters.slice(0, MAX_PREFIX_LEN);
}
