import { createReadStream } from 'node:fs';

export interface RawLine {
  /** Absolute byte offset of the line's first byte within the file. */
  byteOffset: number;
  /** Byte length of the line, excluding its terminating newline. */
  byteLength: number;
  text: string;
}

const NEWLINE = 0x0a;

/**
 * Stream complete newline-terminated lines from `startOffset`, carrying exact
 * byte offsets. Splitting the buffer by hand (rather than via `readline`) keeps
 * the offsets exact: `readline` hides the terminator and normalizes `\r\n`, so
 * a byte cursor derived from its output drifts on any transcript that isn't
 * pure LF.
 *
 * A trailing partial line — a transcript being appended to right now — is
 * deliberately not yielded, so the watermark never lands mid-record.
 * `startOffset` must therefore be a line boundary.
 */
export async function* readJsonLines(
  filePath: string,
  startOffset: number,
): AsyncGenerator<RawLine> {
  let pending = Buffer.alloc(0);
  let cursor = startOffset;

  for await (const chunk of createReadStream(filePath, { start: startOffset })) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    let newlineAt = pending.indexOf(NEWLINE);
    while (newlineAt !== -1) {
      const line = pending.subarray(0, newlineAt);
      yield { byteOffset: cursor, byteLength: line.length, text: line.toString('utf8') };
      cursor += newlineAt + 1;
      pending = pending.subarray(newlineAt + 1);
      newlineAt = pending.indexOf(NEWLINE);
    }
  }
}
