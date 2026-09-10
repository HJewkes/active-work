import { describe, expect, it } from 'vitest';

import { toolTypeFor } from '../../src/drain/partition.js';

describe('toolTypeFor', () => {
  it('routes Bash to Bash', () => {
    expect(toolTypeFor('Bash')).toBe('Bash');
  });

  it('routes Read to Read', () => {
    expect(toolTypeFor('Read')).toBe('Read');
  });

  it('routes Edit and MultiEdit to Edit', () => {
    expect(toolTypeFor('Edit')).toBe('Edit');
    expect(toolTypeFor('MultiEdit')).toBe('Edit');
  });

  it('routes an unrecognized tool name to generic', () => {
    expect(toolTypeFor('Glob')).toBe('generic');
    expect(toolTypeFor('SomeFutureTool')).toBe('generic');
  });
});
