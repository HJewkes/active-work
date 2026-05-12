import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ColorModule from '../../src/utils/color.js';

/**
 * `color.ts` captures `NO_COLOR` and `process.stdout.isTTY` at module
 * load time, so each scenario must `vi.resetModules()` and re-import the
 * module with the env primed.
 */
async function loadColor(): Promise<typeof ColorModule.color> {
  vi.resetModules();
  const mod = (await import('../../src/utils/color.js')) as typeof ColorModule;
  return mod.color;
}

describe('color', () => {
  const prevNoColor = process.env.NO_COLOR;

  beforeEach(() => {
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
    vi.resetModules();
  });

  it('returns input unchanged when NO_COLOR is set', async () => {
    process.env.NO_COLOR = '1';
    const color = await loadColor();
    expect(color.enabled).toBe(false);
    expect(color.red('hi')).toBe('hi');
    expect(color.bold('hi')).toBe('hi');
    expect(color.green('hi')).toBe('hi');
    expect(color.yellow('hi')).toBe('hi');
    expect(color.cyan('hi')).toBe('hi');
    expect(color.gray('hi')).toBe('hi');
    expect(color.dim('hi')).toBe('hi');
  });

  it('returns input unchanged when stdout is not a TTY (default in tests)', async () => {
    delete process.env.NO_COLOR;
    const color = await loadColor();
    // Vitest workers run with stdout.isTTY === undefined.
    expect(color.enabled).toBe(false);
    expect(color.red('test')).toBe('test');
    expect(color.cyan('hi')).toBe('hi');
  });
});
