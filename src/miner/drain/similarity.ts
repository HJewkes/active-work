import { WILDCARD } from './types.js';

/**
 * Token-position similarity between an existing cluster's template tokens
 * and a candidate line's tokens, per the Drain paper (ICWS 2017) / Drain3's
 * `fast_match`. Wildcard positions in `templateTokens` count as matches —
 * they generalize to anything — so a fully-wildcarded template still scores
 * 1.0 against any same-length line.
 *
 * Both arrays must be the same length; callers only ever compare same-length
 * token sequences (Drain partitions by token count before this is called).
 */
export function tokenSimilarity(templateTokens: string[], lineTokens: string[]): number {
  if (templateTokens.length !== lineTokens.length) {
    throw new Error(
      `tokenSimilarity: length mismatch (${templateTokens.length} vs ${lineTokens.length})`,
    );
  }
  if (templateTokens.length === 0) return 1;

  let matching = 0;
  for (let i = 0; i < templateTokens.length; i++) {
    if (templateTokens[i] === WILDCARD || templateTokens[i] === lineTokens[i]) {
      matching += 1;
    }
  }
  return matching / templateTokens.length;
}

/**
 * Merge a line's tokens into an existing template, generalizing (never
 * tightening) positions that disagree. A position already wildcarded stays
 * wildcarded regardless of what the new line has there.
 */
export function mergeTemplate(templateTokens: string[], lineTokens: string[]): string[] {
  if (templateTokens.length !== lineTokens.length) {
    throw new Error(
      `mergeTemplate: length mismatch (${templateTokens.length} vs ${lineTokens.length})`,
    );
  }
  return templateTokens.map((token, i) =>
    token === WILDCARD || token === lineTokens[i] ? token : WILDCARD,
  );
}
