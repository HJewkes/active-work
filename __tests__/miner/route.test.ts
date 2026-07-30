import { describe, expect, it } from 'vitest';

import { DrainTreeRegistry, toolTypeFor } from '../../src/miner/route.js';

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

describe('DrainTreeRegistry', () => {
  it('returns the same tree instance for repeated lookups of the same toolType', () => {
    const registry = new DrainTreeRegistry();
    const a = registry.getTree('Bash');
    const b = registry.getTree('Bash');
    expect(a).toBe(b);
  });

  it('returns distinct trees for distinct toolTypes', () => {
    const registry = new DrainTreeRegistry();
    const bash = registry.getTree('Bash');
    const read = registry.getTree('Read');
    expect(bash).not.toBe(read);
  });

  it('keeps clusters isolated per toolType partition', () => {
    const registry = new DrainTreeRegistry();
    registry.getTree('Bash').insert(['error', 'a']);
    registry.getTree('Read').insert(['error', 'a']);
    expect(registry.getTree('Bash').clusterCount).toBe(1);
    expect(registry.getTree('Read').clusterCount).toBe(1);
  });

  it('tracks which toolTypes have been partitioned', () => {
    const registry = new DrainTreeRegistry();
    registry.getTree('Bash');
    registry.getTree('generic');
    expect(registry.partitionedToolTypes.sort()).toEqual(['Bash', 'generic']);
  });
});
