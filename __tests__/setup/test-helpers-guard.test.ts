import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertSafeToRemove, withEmptyActiveRoot } from './test-helpers.js';

/**
 * The guard protects the one irreversible step in the helpers: the recursive
 * delete of the active root after each test. It cannot fire under normal
 * control flow — `mkdtempSync` always yields a fresh temp path — so these
 * tests drive it directly. AW-60: an agent that set `XDG_DATA_HOME` expecting
 * redirection wrote ten synthetic initiatives into the operator's live root,
 * because `env-paths` ignores that variable on darwin.
 */
describe('assertSafeToRemove', () => {
  const strays: string[] = [];

  afterAll(() => {
    for (const dir of strays) rmSync(dir, { recursive: true, force: true });
  });

  it('allows a temp dir the helpers themselves created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-test-'));
    strays.push(dir);
    expect(() => assertSafeToRemove(dir)).not.toThrow();
  });

  // The path is deliberately built without requiring it to exist: on Linux CI
  // there is no `~/Library`, and the guard must still refuse rather than die of
  // ENOENT — an opaque ENOENT would hide the mistake it exists to name.
  it('refuses the real active root, the exact AW-60 hazard', () => {
    const realRoot = join(homedir(), 'Library', 'Application Support', 'active-work');
    expect(() => assertSafeToRemove(realRoot)).toThrow(/refused to delete/);
  });

  it('refuses a path that does not exist instead of throwing ENOENT', () => {
    const missing = join(homedir(), 'no', 'such', 'place-' + Date.now());
    expect(() => assertSafeToRemove(missing)).toThrow(/refused to delete/);
    expect(() => assertSafeToRemove(missing)).not.toThrow(/ENOENT/);
  });

  it('refuses the home directory', () => {
    expect(() => assertSafeToRemove(homedir())).toThrow(/refused to delete/);
  });

  // Why the explicit home check earns its keep, even alongside the name-shape
  // rule: `sandbox-home.ts` puts the sandbox home at
  // `tmpdir()/aw-test-home-XXXX` — a direct child of the temp dir carrying the
  // `aw-test-` prefix. Shape alone would green-light deleting a home directory.
  it('refuses a directory that matches the aw-test- shape but is a home dir', () => {
    // Same shape the helpers' own temp dirs have, so it clears the name rule
    // and is refused only because it resolves to home.
    const shaped = mkdtempSync(join(tmpdir(), 'aw-test-home-'));
    strays.push(shaped);
    expect(() => assertSafeToRemove(shaped)).not.toThrow();
    const prevHome = process.env.HOME;
    process.env.HOME = shaped;
    try {
      expect(() => assertSafeToRemove(shaped)).toThrow(/refused to delete/);
    } finally {
      process.env.HOME = prevHome;
    }
  });

  // Being under the temp dir is not sufficient on its own: an unrelated temp
  // directory belonging to another tool must not be deleted either.
  it('refuses a temp dir that is not one of ours', () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-ours-'));
    strays.push(dir);
    expect(() => assertSafeToRemove(dir)).toThrow(/not an aw-test- temp dir/);
  });

  // Only a direct child qualifies; a nested path under one of our temp dirs is
  // not what the helpers ever create.
  it('refuses a nested directory inside one of our temp dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-test-'));
    strays.push(dir);
    expect(() => assertSafeToRemove(join(dir, 'nested'))).toThrow(/refused to delete/);
  });

  it('names ACTIVE_ROOT as the safe override, so the message teaches the fix', () => {
    expect(() => assertSafeToRemove(homedir())).toThrow(/ACTIVE_ROOT/);
    expect(() => assertSafeToRemove(homedir())).toThrow(/never XDG_DATA_HOME/);
  });

  // Guard-in-place regression: the helpers must still complete a normal cycle,
  // creating the root and cleaning it up without tripping their own guard.
  it('does not false-positive on a real helper cycle', async () => {
    let used = '';
    await withEmptyActiveRoot(async (root) => {
      used = root;
      mkdirSync(join(root, 'some-initiative'), { recursive: true });
    });
    expect(used).toContain('aw-test-');
  });
});
