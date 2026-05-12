import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POSTINSTALL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'postinstall.js');

function runPostinstall(homeDir: string) {
  return spawnSync('node', [POSTINSTALL_SCRIPT], {
    env: { ...process.env, HOME: homeDir },
    encoding: 'utf8',
  });
}

describe('scripts/postinstall.js', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'aw-postinstall-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('exits 0 and does nothing when ~/.claude does not exist', () => {
    const result = runPostinstall(homeDir);
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(existsSync(path.join(homeDir, '.claude'))).toBe(false);
  });

  it('copies the skill into ~/.claude/skills/active-work when ~/.claude exists', () => {
    mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

    const result = runPostinstall(homeDir);
    expect(result.status).toBe(0);

    const installedSkill = path.join(
      homeDir,
      '.claude',
      'skills',
      'active-work',
      'SKILL.md',
    );
    expect(existsSync(installedSkill)).toBe(true);

    const content = readFileSync(installedSkill, 'utf8');
    expect(content).toContain('name: active-work');
    expect(content).toContain('description:');

    // References ship alongside SKILL.md.
    const referencesDir = path.join(
      homeDir,
      '.claude',
      'skills',
      'active-work',
      'references',
    );
    expect(existsSync(path.join(referencesDir, 'onboarding.md'))).toBe(true);
    expect(existsSync(path.join(referencesDir, 'auditing-existing-work.md'))).toBe(true);
    expect(existsSync(path.join(referencesDir, 'cli-dev.md'))).toBe(true);
  });

  it('cleanly replaces an existing install on re-run', () => {
    mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

    const first = runPostinstall(homeDir);
    expect(first.status).toBe(0);

    const second = runPostinstall(homeDir);
    expect(second.status).toBe(0);

    const installedSkill = path.join(
      homeDir,
      '.claude',
      'skills',
      'active-work',
      'SKILL.md',
    );
    expect(existsSync(installedSkill)).toBe(true);
    const content = readFileSync(installedSkill, 'utf8');
    expect(content).toContain('name: active-work');
  });
});
