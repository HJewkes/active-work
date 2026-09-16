import { isTaskId, meaningfulTerms, orExpression } from './terms.js';

/**
 * Turning trigger text into a query nobody had to write.
 *
 * TP-84 measured two ways of choosing terms from a long text and the rarest
 * terms by document frequency doubled spawn-arm recall@10 over the opening
 * words (0.203 against 0.103): briefs front-load boilerplate, so position is
 * the least discriminating signal there is. Pure; the frequency source is
 * injected so this is testable without an index.
 */

/** How many terms rarity picks. TP-84's measured value. */
export const QUERY_TERMS = 12;

/**
 * How common a term is in the corpus. Only its order matters, so a capped count
 * is fine, but it must be a count of matches: distinct owners among the top N
 * matching spans misranks common words as rare when their best spans sit in a
 * few long transcripts (measured 2026-09-16; see `document-frequency.ts`).
 */
export type DocumentFrequency = (term: string) => number;

export interface DerivedQuery {
  /** Rarest terms first, then every task id the text names. */
  terms: string[];
  /** FTS5 MATCH expression; empty when no term survived. */
  expression: string;
}

/**
 * Commit hashes read as the rarest terms in the corpus and would crowd out the
 * words a hash-heavy brief is actually about (TP-84 review).
 */
const HEX_HASH = /^[0-9a-f]{7,}$/;

function candidates(text: string): { terms: string[]; ids: string[] } {
  const distinct = meaningfulTerms(text);
  return {
    terms: distinct.filter((term) => !isTaskId(term) && !HEX_HASH.test(term)),
    ids: distinct.filter(isTaskId),
  };
}

/**
 * The `limit` rarest terms. Ties keep first appearance, so the same text
 * always derives the same query.
 */
function rarest(terms: string[], df: DocumentFrequency, limit: number): string[] {
  if (terms.length <= limit) return terms;
  const counts = new Map(terms.map((term) => [term, df(term)]));
  return terms
    .map((term, index) => ({ term, index }))
    .sort((a, b) => counts.get(a.term)! - counts.get(b.term)! || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.term);
}

export function deriveQuery(
  text: string,
  df: DocumentFrequency,
  limit = QUERY_TERMS,
): DerivedQuery {
  const { terms, ids } = candidates(text);
  // Ids are always kept: the `mentions` relation makes them exact hits.
  const picked = [...rarest(terms, df, limit), ...ids];
  return { terms: picked, expression: orExpression(picked) };
}
