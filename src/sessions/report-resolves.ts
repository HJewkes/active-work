/**
 * Task ids a worker's report names as closed (TP-1709). Deliberately
 * conservative: an id counts only when "closed", "done" or "merged" sits right
 * next to it, so a report that merely mentions a task does not close it.
 */

const TASK_ID = String.raw`[A-Z][A-Z0-9]*-\d+`;
const CLOSED_WORD = String.raw`(?:closed|done|merged)`;
const ID_THEN_WORD = new RegExp(
  String.raw`\b(${TASK_ID})\b[\s:()\-–—]*(?:(?:is|was|now|also)\s+)?${CLOSED_WORD}\b`,
  'gi',
);
const WORD_THEN_ID = new RegExp(
  // "Status: DONE" reports the worker's own run, not that a task was closed.
  String.raw`(?<!\bnot\s)(?<!Status:\s{0,3})\b${CLOSED_WORD}[\s:]+(${TASK_ID})\b`,
  'gi',
);

function idsMatching(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(pattern)]
    .map((match) => match[1] ?? '')
    .filter((id) => /^[A-Z][A-Z0-9]*-\d+$/.test(id));
}

export function closedTaskIds(text: string): string[] {
  const ids = [...idsMatching(ID_THEN_WORD, text), ...idsMatching(WORD_THEN_ID, text)];
  return [...new Set(ids)];
}
