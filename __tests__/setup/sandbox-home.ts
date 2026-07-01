/**
 * Per-test-file sandbox for the user's home directory (AW-9).
 *
 * A past test deleted the developer's real `~/.claude/skills/active-work/`
 * because it derived the path from `os.homedir()` and ran a destructive fs
 * op without redirecting home to a temp dir first. This `setupFiles` hook is
 * the defense-in-depth backstop: any test that forgets to mock home resolves
 * to a throwaway directory under `os.tmpdir()`, so it can neither read nor
 * delete the operator's real files.
 *
 * Why override `os.homedir()` instead of only setting `$HOME`: under Vitest's
 * `threads` pool a runtime `process.env.HOME` write does not reliably reach
 * libuv's `os.homedir()`, so env-only redirection leaks the real home. The
 * override reads `process.env.HOME` dynamically, which (a) defaults to this
 * sandbox and (b) still honors any test that sets its own scratch `HOME`
 * (e.g. integration tests deriving a subprocess's state dir), keeping the
 * production behavior — `os.homedir()` tracks `$HOME` — intact and reliable.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const realHomedir = os.homedir.bind(os);
const sandboxHome = mkdtempSync(path.join(os.tmpdir(), 'aw-test-home-'));

process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

os.homedir = () =>
  process.env.HOME ?? process.env.USERPROFILE ?? realHomedir();

afterAll(() => {
  os.homedir = realHomedir;
  rmSync(sandboxHome, { recursive: true, force: true });
});
