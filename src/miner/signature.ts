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
  /**
   * True when `anchorLine` came from a recognized failure-shape rule rather
   * than the positional fallback (last non-blank line, or a `git` blob's first
   * line). An unanchored signature's clustering key is arbitrary output text,
   * so `blob-extract.ts` uses this to screen successful command output — see
   * `hasErrorSignal`.
   */
  anchored: boolean;
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

interface Anchor {
  line: string;
  anchored: boolean;
}

function anchorForToolType(toolType: string, lines: string[]): Anchor {
  if (toolType === 'git') return { line: (lines[0] ?? '').trim(), anchored: false };

  if (toolType === 'test') {
    const match = firstMatch(lines, TEST_RUNNER_ANCHOR_RULES);
    if (match) return { line: match, anchored: true };
  }

  // Bash and generic is_error blobs share the same anchor priority.
  const match = firstMatch(lines, BASH_ANCHOR_RULES);
  return match === undefined
    ? { line: lastNonBlank(lines), anchored: false }
    : { line: match, anchored: true };
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

  const { line: anchorLine, anchored } = anchorForToolType(toolType, lines);
  const errorClass = classifyError(anchorLine);
  const lineCountBucket = bucketLineCount(nonBlankCount);

  return {
    errorClass,
    anchorLine,
    anchored,
    lineCountBucket,
    signatureLine: `${errorClass} ${anchorLine} [${lineCountBucket}]`,
  };
}

/**
 * Whether a blob carries a recognizable failure shape of its own — i.e. whether
 * `extractSignature` would anchor on a matched rule instead of falling back to
 * an arbitrary output line.
 *
 * AW-93: the miner exists to recognize *recurring failures* (§AW-28), and a
 * successful `git log`/`grep`/`cat` has no failure to recognize a repeat of.
 * Clustering it anyway keys on the literal last line of arbitrary stdout, whose
 * cardinality is unbounded — every distinct successful command minted its own
 * permanent singleton cluster, and the template count never flattened.
 */
export function hasErrorSignal(toolType: string, blobText: string): boolean {
  return anchorForToolType(toolType, blobText.split('\n')).anchored;
}
