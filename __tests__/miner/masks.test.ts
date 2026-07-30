import { describe, expect, it } from 'vitest';

import { applyMasks } from '../../src/miner/masks.js';

describe('applyMasks', () => {
  it('masks a path-like token', () => {
    const result = applyMasks('generic', "Cannot find module 'src/foo/bar.ts'");
    expect(result.maskedSignature).toContain('<PATH>');
    expect(result.extractedParams.PATH).toBe('src/foo/bar.ts');
  });

  it('masks a digit run as NUM', () => {
    const result = applyMasks('generic', 'error TS2304: Cannot find name');
    expect(result.maskedSignature).toBe('error TS<NUM>: Cannot find name');
    expect(result.extractedParams.NUM).toBe('2304');
  });

  it('masks a UUID before it can be caught by looser rules', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const result = applyMasks('generic', `request ${uuid} failed`);
    expect(result.maskedSignature).toBe('request <UUID> failed');
  });

  it('masks a duration', () => {
    const result = applyMasks('generic', 'test timed out after 30000 ms');
    expect(result.maskedSignature).toBe('test timed out after <DURATION>');
  });

  it('only records the first occurrence of a repeated mask name', () => {
    const result = applyMasks('generic', 'retry 1 then retry 2 then retry 3');
    expect(result.maskedSignature).toBe('retry <NUM> then retry <NUM> then retry <NUM>');
    expect(result.extractedParams.NUM).toBe('1');
  });

  it('falls back to the generic config for an unregistered tool type', () => {
    const registered = applyMasks('generic', 'code 404');
    const fallback = applyMasks('SomeFutureTool', 'code 404');
    expect(fallback.maskedSignature).toBe(registered.maskedSignature);
  });

  it('produces identical masked signatures for structurally identical blobs', () => {
    const a = applyMasks('generic', "Cannot find module 'src/a/foo.ts'");
    const b = applyMasks('generic', "Cannot find module 'src/b/bar.ts'");
    expect(a.maskedSignature).toBe(b.maskedSignature);
  });
});
