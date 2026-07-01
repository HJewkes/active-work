import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Proves the `sandbox-home` setupFile is wired in and active: during tests
 * `os.homedir()` must resolve inside the OS temp dir, never the real home.
 * If this fails, the home sandbox is not loaded and destructive tests could
 * reach the developer's real files (AW-9).
 */
describe('home sandbox', () => {
  it('redirects os.homedir() into the OS temp dir', () => {
    const home = os.homedir();
    const tmp = os.tmpdir();
    expect(home.startsWith(tmp + path.sep)).toBe(true);
    expect(path.basename(home)).toMatch(/^aw-test-home-/);
  });

  it('keeps HOME and USERPROFILE pointed at the same sandbox', () => {
    expect(process.env.HOME).toBe(os.homedir());
    expect(process.env.USERPROFILE).toBe(os.homedir());
  });
});
