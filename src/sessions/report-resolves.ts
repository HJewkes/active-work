/**
 * Task ids a worker's report names as closed (TP-1709). Deliberately
 * conservative: an id counts only when "closed", "done" or "merged" sits right
 * next to it, so a report that merely mentions a task does not close it.
 */

const TASK_ID = String.raw`[A-Z][A-Z0-9]*-\d+`;
const CLOSED_WORD = String.raw`(?:closed|done|merged)`;
// An id glued to a path, anchor or query ("/SX-1", "#SX-1") is part of a link.
const STANDALONE = String.raw`(?<![\w/#=.-])`;
// "until SX-1 is merged" names a condition, not a close.
const NOT_CONDITIONAL = String.raw`(?<!\b(?:until|once|after|when|if|unless|before|pending|awaiting|for)\s+)`;
const NOT_NEGATED = String.raw`(?<!(?:\bnot|\bnever|n't)\s+)`;
const ID_THEN_WORD = new RegExp(
  String.raw`${NOT_CONDITIONAL}${STANDALONE}(${TASK_ID})\b[\s:()\-–—]*(?:(?:is|was|now|also)\s+)?${CLOSED_WORD}\b`,
  'gi',
);
const WORD_THEN_ID = new RegExp(
  // "Status: DONE" reports the worker's own run, not that a task was closed.
  String.raw`${NOT_NEGATED}(?<!Status:\s{0,3})\b${CLOSED_WORD}[\s:]+${STANDALONE}(${TASK_ID})\b`,
  'gi',
);
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi;

function idsMatching(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(pattern)]
    .map((match) => match[1] ?? '')
    .filter((id) => /^[A-Z][A-Z0-9]*-\d+$/.test(id));
}

export function closedTaskIds(text: string): string[] {
  const prose = text.replace(URL, ' ');
  const ids = [...idsMatching(ID_THEN_WORD, prose), ...idsMatching(WORD_THEN_ID, prose)];
  return [...new Set(ids)];
}
