/**
 * Reduces a multi-line tool-result blob to one deterministic signature line
 * before it reaches Drain (§C1: "per-blob via an extracted signature line").
 * Drain is inherently per-line; stack traces and multi-line summaries break
 * it if fed whole, since line count varies with recursion depth. The
 * signature captures the blob's *shape* — the anchor line that identifies
 * the failure, plus a coarse line-count bucket — without ever touching the
 * full body.
 */

export type LineCountBucket = '0' | '1' | '2-5' | '6+';

export interface Signature {
  errorClass: string;
  anchorLine: string;
  lineCountBucket: LineCountBucket;
  /** `${errorClass} ${anchorLine} [${lineCountBucket}]` — the string Drain tokenizes. */
  signatureLine: string;
}

const BASH_ANCHOR_RULES: RegExp[] = [
  /^\w*Error\b.*$/,
  /^\s*at\s.*$/,
  /exit (?:code|status)[: ]+\d+/i,
];

const TEST_RUNNER_ANCHOR_RULES: RegExp[] = [
  /\d+\s+passed.*\d+\s+failed/i,
  /\d+\s+failed.*\d+\s+passed/i,
  /error TS\d+:.*$/,
  /^\s*✖?\s*[\w-]+\/[\w-]+(?:\/[\w-]+)*\s*$/, // eslint-style rule id, e.g. no-unused-vars
];

function bucketLineCount(count: number): LineCountBucket {
  if (count === 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2-5';
  return '6+';
}

function firstMatch(lines: string[], rules: RegExp[]): string | undefined {
  for (const rule of rules) {
    const line = lines.find((l) => rule.test(l));
    if (line !== undefined) return line.trim();
  }
  return undefined;
}

function lastNonBlank(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) return lines[i].trim();
  }
  return '';
}

function anchorForToolType(toolType: string, lines: string[]): string {
  if (toolType === 'git') return (lines[0] ?? '').trim();

  if (toolType === 'test') {
    const match = firstMatch(lines, TEST_RUNNER_ANCHOR_RULES);
    if (match) return match;
  }

  // Bash and generic is_error blobs share the same anchor priority.
  const match = firstMatch(lines, BASH_ANCHOR_RULES);
  return match ?? lastNonBlank(lines);
}

const ERROR_CLASS_RULES: [RegExp, (match: RegExpMatchArray) => string][] = [
  [/^(\w*Error)\b/, (m) => m[1]],
  [/error (TS\d+):/, (m) => m[1]],
  [/^([\w-]+\/[\w-]+(?:\/[\w-]+)*)\s*$/, (m) => m[1]], // eslint rule id
];

function classifyError(anchorLine: string): string {
  for (const [rule, extract] of ERROR_CLASS_RULES) {
    const m = anchorLine.match(rule);
    if (m) return extract(m);
  }
  return 'unknown';
}

/**
 * Reduce a raw tool-result blob to its `Signature` for a given `toolType`
 * (as routed by `src/miner/route.ts`). Never stores or returns the full
 * blob — only the anchor line survives.
 */
export function extractSignature(toolType: string, blobText: string): Signature {
  const lines = blobText.split('\n');
  const nonBlankCount = lines.filter((l) => l.trim().length > 0).length;

  const anchorLine = anchorForToolType(toolType, lines);
  const errorClass = classifyError(anchorLine);
  const lineCountBucket = bucketLineCount(nonBlankCount);

  return {
    errorClass,
    anchorLine,
    lineCountBucket,
    signatureLine: `${errorClass} ${anchorLine} [${lineCountBucket}]`,
  };
}
