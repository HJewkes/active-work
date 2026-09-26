import type { PickType } from './schema.js';

/**
 * Reading the human's answers out of an `AskUserQuestion` tool result.
 *
 * The result is prose: `The user answered: "<q>"="<a>", "<q2>"="<a2>". ...`
 * (older builds say `Your questions have been answered:`). An answer may
 * itself contain quotes, so a quote only closes it when followed by `, "` or
 * `. `, which is the separator the harness writes.
 */

const PAIR = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.|"(?!,\s*"|\.\s))*)"/g;
const REJECTED = "doesn't want to proceed";

export interface ParsedResult {
  rejected: boolean;
  answers: Map<string, string>;
}

function unescape(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/** A JSON result carrying `{answers: {question: answer}}`, the structured form some builds emit. */
function jsonAnswers(text: string): Map<string, string> | null {
  if (!text.trimStart().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text) as { answers?: unknown };
    if (typeof parsed.answers !== 'object' || parsed.answers === null) return null;
    const entries = Object.entries(parsed.answers as Record<string, unknown>);
    return new Map(entries.map(([q, a]) => [q, String(a)]));
  } catch {
    return null;
  }
}

export function parseAnswerText(text: string): ParsedResult {
  const structured = jsonAnswers(text);
  if (structured) return { rejected: false, answers: structured };
  const answers = new Map<string, string>();
  for (const match of text.matchAll(PAIR)) {
    answers.set(unescape(match[1]), unescape(match[2]));
  }
  return { rejected: text.includes(REJECTED), answers };
}

/** Exact question first; the harness truncates long questions, so fall back to a 40-char prefix. */
export function answerFor(answers: Map<string, string>, question: string): string | null {
  const exact = answers.get(question);
  if (exact !== undefined) return exact;
  const prefix = question.slice(0, 40);
  for (const [q, a] of answers) if (q.slice(0, 40) === prefix) return a;
  return null;
}

export function recommendedOption(options: string[]): string | null {
  return options.find((o) => o.toLowerCase().includes('recommend')) ?? null;
}

function isListed(answer: string, options: string[]): boolean {
  const labels = options.map((o) => o.trim());
  if (labels.includes(answer)) return true;
  // Multi-select answers join the picked labels with ", ".
  return answer.split(', ').every((part) => labels.includes(part.trim()));
}

export function pickTypeOf(answer: string | null, options: string[], rejected: boolean): PickType {
  if (rejected) return 'rejected';
  if (answer === null) return 'unparsed';
  const trimmed = answer.trim();
  const recommended = recommendedOption(options);
  if (recommended !== null && trimmed === recommended.trim()) return 'recommended';
  return isListed(trimmed, options) ? 'other_option' : 'free_text';
}
