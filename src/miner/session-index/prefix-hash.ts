import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * sha256 over bytes `[0, byteLength)` of `filePath` — the same hashing
 * primitive AW-28's `template-id.ts` uses, applied to a byte range instead of
 * a string.
 *
 * Transcripts are append-only in normal operation, so a stored prefix hash
 * that still matches means the bytes we already indexed are untouched and we
 * can resume at the watermark. A mismatch means the file was rewritten (or
 * truncated) rather than grown, and the only correct response is a full
 * re-index from byte 0.
 */
export async function prefixHash(filePath: string, byteLength: number): Promise<string> {
  const hash = createHash('sha256');
  if (byteLength > 0) {
    const stream = createReadStream(filePath, { start: 0, end: byteLength - 1 });
    for await (const chunk of stream) hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
