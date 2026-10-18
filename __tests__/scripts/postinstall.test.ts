import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_ENTRIES = ['scripts', 'skill', 'claude-commands'];

/** Copy the shippable parts of the package under `<base>/<relativeDir>`. */
function stagePackage(base: string, relativeDir: string): string {
  const packageDir = path.join(base, relativeDir);
  for (const entry of PACKAGE_ENTRIES) {
    cpSync(path.join(REPO_ROOT, entry), path.join(packageDir, entry), { recursive: true });
  }
  return packageDir;
}

function runPostinstall(homeDir: string, packageDir: string) {
  return spawnSync('node', [path.join(packageDir, 'scripts', 'postinstall.js')], {
    env: { ...process.env, HOME: homeDir },
    encoding: 'utf8',
  });
}

describe('scripts/postinstall.js', () => {
  let homeDir: string;
  let workDir: string;
  let installedDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'aw-postinstall-'));
    workDir = mkdtempSync(path.join(os.tmpdir(), 'aw-postinstall-pkg-'));
    installedDir = stagePackage(workDir, 'node_modules/@titan-design/active-work');
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('leaves ~/.claude untouched when the package dir has no node_modules segment', () => {
    mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    const checkoutDir = stagePackage(workDir, 'checkout/products/active-work');

    const result = runPostinstall(homeDir, checkoutDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(readdirSync(path.join(homeDir, '.claude'))).toEqual([]);
  });

  it('copies the skill and the command when the package dir sits under node_modules', () => {
    mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

    const result = runPostinstall(homeDir, installedDir);

    expect(result.status).toBe(0);
    expect(existsSync(path.join(homeDir, '.claude', 'skills', 'active-work', 'SKILL.md'))).toBe(
      true,
    );
    expect(existsSync(path.join(homeDir, '.claude', 'commands', 'aw-prompt.md'))).toBe(true);
  });

  it('exits 0 and does nothing when ~/.claude does not exist', () => {
    const result = runPostinstall(homeDir, installedDir);
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(existsSync(path.join(homeDir, '.claude'))).toBe(false);
  });

  it('copies the skill into ~/.claude/skills/active-work when ~/.claude exists', () => {
    mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

    const result = runPostinstall(homeDir, installedDir);
    expect(result.status).toBe(0);

    const installedSkill = path.join(homeDir, '.claude', 'skills', 'active-work', 'SKILL.md');
    expect(existsSync(installedSkill)).toBe(true);

    const content = readFileSync(installedSkill, 'utf8');
    expect(content).toContain('name: active-work');
    expect(content).toContain('description:');

    // References ship alongside SKILL.md.
    const referencesDir = path.join(homeDir, '.claude', 'skills', 'active-work', 'references');
    expect(existsSync(path.join(referencesDir, 'onboarding.md'))).toBe(true);
    expect(existsSync(path.join(referencesDir, 'auditing-existing-work.md'))).toBe(true);
    expect(existsSync(path.join(referencesDir, 'cli-dev.md'))).toBe(true);
  });

  it('cleanly replaces an existing install on re-run', () => {
    mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

    const first = runPostinstall(homeDir, installedDir);
    expect(first.status).toBe(0);

    const second = runPostinstall(homeDir, installedDir);
    expect(second.status).toBe(0);

    const installedSkill = path.join(homeDir, '.claude', 'skills', 'active-work', 'SKILL.md');
    expect(existsSync(installedSkill)).toBe(true);
    const content = readFileSync(installedSkill, 'utf8');
    expect(content).toContain('name: active-work');
  });
});
