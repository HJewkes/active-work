import { ExtractAccumulator } from './accumulator.js';
import { readJsonLines } from './json-lines.js';
import { LineHandler } from './line-handler.js';
import { prefixHash } from './prefix-hash.js';
import type { ExtractResult } from '../../schemas/session-index.js';

export interface ExtractOptions {
  /** Resume point from `transcripts.last_byte_offset`; must be a line boundary. */
  fromByteOffset?: number;
  /** `transcripts.prefix_hash`; a mismatch forces a full re-index from byte 0. */
  priorPrefixHash?: string | null;
  /** Stop after this offset — used by tests to simulate a partially-grown file. */
  untilByteOffset?: number;
}

/** A malformed JSON line aborts the transcript so `quarantine.ts` can isolate it. */
export class TranscriptParseError extends Error {
  constructor(
    readonly filePath: string,
    readonly byteOffset: number,
    cause: unknown,
  ) {
    super(`malformed JSON at ${filePath}:${byteOffset}: ${String(cause)}`);
    this.name = 'TranscriptParseError';
  }
}

async function resolveStartOffset(
  filePath: string,
  options: ExtractOptions,
): Promise<{ start: number; restartedFromZero: boolean }> {
  const requested = options.fromByteOffset ?? 0;
  if (requested === 0) return { start: 0, restartedFromZero: false };
  const expected = options.priorPrefixHash;
  if (expected && (await prefixHash(filePath, requested)) !== expected) {
    return { start: 0, restartedFromZero: true };
  }
  return { start: requested, restartedFromZero: false };
}

/**
 * Read one transcript from `fromByteOffset` forward and produce the typed row
 * batch for everything after it, plus the new watermark.
 *
 * The result is a *delta*: applying successive chunks through
 * `applyExtractResult` yields exactly the same database as one whole-file pass
 * (see `line-handler.ts` for why the per-line rules are stateless).
 */
export async function extractTranscript(
  filePath: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const { start, restartedFromZero } = await resolveStartOffset(filePath, options);
  const accumulator = new ExtractAccumulator();
  const handler = new LineHandler(accumulator);
  let lastByteOffset = start;

  for await (const line of readJsonLines(filePath, start)) {
    const end = line.byteOffset + line.byteLength + 1;
    if (options.untilByteOffset !== undefined && end > options.untilByteOffset) break;
    lastByteOffset = end;
    if (line.text.trim().length === 0) continue;
    handler.handle(parseLine(filePath, line.byteOffset, line.text), line);
  }

  return accumulator.toResult({
    restartedFromZero,
    startByteOffset: start,
    lastByteOffset,
    prefixHash: await prefixHash(filePath, lastByteOffset),
  });
}

function parseLine(filePath: string, byteOffset: number, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new TranscriptParseError(filePath, byteOffset, err);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TranscriptParseError(filePath, byteOffset, 'line is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}
