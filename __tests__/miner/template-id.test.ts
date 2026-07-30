import { describe, expect, it } from 'vitest';

import { templateId } from '../../src/miner/template-id.js';

describe('templateId', () => {
  it('is deterministic for the same inputs', () => {
    const a = templateId('Bash', 'error TS<NUM>: Cannot find module <PATH>');
    const b = templateId('Bash', 'error TS<NUM>: Cannot find module <PATH>');
    expect(a).toBe(b);
  });

  it('differs when toolType differs', () => {
    const a = templateId('Bash', 'error TS<NUM>');
    const b = templateId('test', 'error TS<NUM>');
    expect(a).not.toBe(b);
  });

  it('differs when maskedSignature differs', () => {
    const a = templateId('Bash', 'error TS<NUM>');
    const b = templateId('Bash', 'error TS<NUM>: other');
    expect(a).not.toBe(b);
  });

  it('is a hex string', () => {
    expect(templateId('Bash', 'x')).toMatch(/^[0-9a-f]+$/);
  });
});
