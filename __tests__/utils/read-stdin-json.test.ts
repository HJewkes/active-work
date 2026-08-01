import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readStdinJson } from '../../src/utils/read-stdin-json.js';

function streamOf(text: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(text, 'utf8')]) as unknown as NodeJS.ReadableStream;
}

describe('readStdinJson', () => {
  it('parses a JSON object piped in across multiple chunks', async () => {
    const stream = Readable.from([Buffer.from('{"a":1,'), Buffer.from('"b":"two"}')]);
    const result = await readStdinJson(stream as unknown as NodeJS.ReadableStream);
    expect(result).toEqual({ a: 1, b: 'two' });
  });

  it('returns null for empty input', async () => {
    expect(await readStdinJson(streamOf(''))).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    expect(await readStdinJson(streamOf('{ not json'))).toBeNull();
  });

  it('returns null for a JSON array or scalar, not just an object', async () => {
    expect(await readStdinJson(streamOf('[1,2,3]'))).toBeNull();
    expect(await readStdinJson(streamOf('"just a string"'))).toBeNull();
  });
});
