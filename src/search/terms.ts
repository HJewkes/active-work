/**
 * Turning prose into query terms, shared by every caller that builds an FTS
 * expression from text nobody wrote as a query.
 */

/**
 * Words that match everything and therefore rank nothing.
 *
 * The subject is a title rather than a deliberate query, and the FTS default
 * ORs every token — so `or`, `the` and `with` pull in the whole corpus and BM25
 * ends up ranking on document length. Dropping them is what makes a title
 * usable as a query at all.
 */
export const STOP_WORDS = new Set(
  (
    'a an and are as at be but by for from in into is it of on or the to with via than then that ' +
    'this these those over under new old add fix use using not no all any each per'
  ).split(' '),
);

/**
 * A task id, tried before the plain word so `TP-84` stays one token.
 *
 * Split on the hyphen, both halves fall under the length filter and the id
 * contributes nothing, although ids are exactly what the `mentions` relation
 * makes an exact hit (TP-86).
 */
const TOKEN = /[a-z]+-\d+|[\p{L}\p{N}_]+/gu;
const TASK_ID = /^[a-z]+-\d+$/;

export function isTaskId(token: string): boolean {
  return TASK_ID.test(token.toLowerCase());
}

/** Lowercased tokens in order, task ids intact, one- and two-character words dropped. */
export function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().match(TOKEN) ?? [];
  return tokens.filter((token) => isTaskId(token) || token.length > 2);
}

/** Distinct meaningful tokens, in first-seen order. */
export function meaningfulTerms(text: string): string[] {
  return [...new Set(tokenize(text).filter((token) => !STOP_WORDS.has(token)))];
}

/**
 * Quote each term and OR them.
 *
 * Quoting is what keeps a hyphen from reading as FTS5's NOT: `"tp-84"` is the
 * phrase `tp 84`, which is how the tokenizer indexed it.
 */
export function orExpression(terms: string[]): string {
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}
