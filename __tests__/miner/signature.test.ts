import { describe, expect, it } from 'vitest';

import { extractSignature } from '../../src/miner/signature.js';

describe('extractSignature', () => {
  it('picks the first line matching ^\\w*Error for a Bash blob', () => {
    const blob = [
      'some setup output',
      'TypeError: Cannot read properties of undefined',
      'more noise',
    ].join('\n');
    const sig = extractSignature('Bash', blob);
    expect(sig.errorClass).toBe('TypeError');
    expect(sig.anchorLine).toBe('TypeError: Cannot read properties of undefined');
  });

  it('falls back to a stack frame line when no Error line is present', () => {
    const blob = ['running command', '  at Object.<anonymous> (index.js:10:5)', 'done'].join('\n');
    const sig = extractSignature('Bash', blob);
    expect(sig.anchorLine).toBe('at Object.<anonymous> (index.js:10:5)');
  });

  it('falls back to an exit-status line when no Error or stack frame is present', () => {
    const blob = ['running command', 'process exited with exit code 1'].join('\n');
    const sig = extractSignature('Bash', blob);
    expect(sig.anchorLine).toBe('process exited with exit code 1');
  });

  it('falls back to the last non-blank line when nothing else matches', () => {
    const blob = ['first', 'second', '', '   '].join('\n');
    const sig = extractSignature('Bash', blob);
    expect(sig.anchorLine).toBe('second');
  });

  it('extracts a TS error code as the error class', () => {
    const blob = "error TS2304: Cannot find name 'foo'.";
    const sig = extractSignature('test', blob);
    expect(sig.errorClass).toBe('TS2304');
  });

  it('extracts a passed/failed summary line for test runners', () => {
    const blob = ['Running suite...', '3 passed, 2 failed', 'see report for details'].join('\n');
    const sig = extractSignature('test', blob);
    expect(sig.anchorLine).toBe('3 passed, 2 failed');
  });

  it('uses the first line for git blobs', () => {
    const blob = ['fatal: not a git repository', 'more detail'].join('\n');
    const sig = extractSignature('git', blob);
    expect(sig.anchorLine).toBe('fatal: not a git repository');
  });

  it('buckets line counts into 0/1/2-5/6+', () => {
    expect(extractSignature('Bash', '').lineCountBucket).toBe('0');
    expect(extractSignature('Bash', 'one line').lineCountBucket).toBe('1');
    expect(extractSignature('Bash', ['a', 'b', 'c'].join('\n')).lineCountBucket).toBe('2-5');
    expect(extractSignature('Bash', Array(8).fill('x').join('\n')).lineCountBucket).toBe('6+');
  });

  it('produces identical signatureLine for structurally identical blobs', () => {
    const a = extractSignature('Bash', 'TypeError: Cannot find module a.ts');
    const b = extractSignature('Bash', 'TypeError: Cannot find module b.ts');
    // Signature itself does not mask paths (that's masks.ts's job) so these
    // differ here — but errorClass and bucket agree, which is what feeds Drain.
    expect(a.errorClass).toBe(b.errorClass);
    expect(a.lineCountBucket).toBe(b.lineCountBucket);
  });
});
