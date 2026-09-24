/**
 * Pure decisions behind `aw <unknown-slug>`: whether to offer scaffolding the
 * initiative, and the title to suggest (TP-356).
 */
import { NotFoundError } from './errors.js';
import { validateSlug } from './utils/slug.js';

export interface InitOfferInput {
  error: unknown;
  slug: string;
  isTTY: boolean;
}

/** Offer only when nothing matched (not ambiguous), someone can answer, and the slug is creatable. */
export function shouldOfferInit({ error, slug, isTTY }: InitOfferInput): boolean {
  if (!isTTY) return false;
  if (!(error instanceof NotFoundError) || error.reason !== 'no_match') return false;
  return validateSlug(slug).ok;
}

/** True when the offer was withheld only because the slug is not valid kebab-case. */
export function isInvalidSlugMiss({ error, slug }: Omit<InitOfferInput, 'isTTY'>): boolean {
  return error instanceof NotFoundError && error.reason === 'no_match' && !validateSlug(slug).ok;
}

export function defaultTitleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}
