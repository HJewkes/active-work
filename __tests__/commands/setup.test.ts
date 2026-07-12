import { promises as fs, mkdtempSync, rmSync, existsSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import setupCmd from '../../src/commands/setup.js';
import uninstallCmd from '../../src/commands/uninstall.js';
import * as setupSteps from '../../src/setup/steps.js';

function ctxFor(activeRoot: string) {
  return {
    activeRoot,
    warnings: [] as string[],
    format: 'json' as const,
  };
}

describe('active-work setup', () => {
  let tempBase: string;
  let originalActiveRoot: string | undefined;
  let hadActiveRoot = false;
  let originalXdgData: string | undefined;
  let originalXdgConfig: string | undefined;
  let originalXdgState: string | undefined;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempBase = mkdtempSync(path.join(tmpdir(), 'aw-setup-cmd-'));
    hadActiveRoot = Object.prototype.hasOwnProperty.call(
      process.env,
      'ACTIVE_ROOT',
    );
    originalActiveRoot = process.env.ACTIVE_ROOT;
    originalXdgData = process.env.XDG_DATA_HOME;
    originalXdgConfig = process.env.XDG_CONFIG_HOME;
    originalXdgState = process.env.XDG_STATE_HOME;

    process.env.ACTIVE_ROOT = path.join(tempBase, 'active');
    process.env.XDG_DATA_HOME = path.join(tempBase, 'xdg-data');
    process.env.XDG_CONFIG_HOME = path.join(tempBase, 'xdg-config');
    process.env.XDG_STATE_HOME = path.join(tempBase, 'xdg-state');
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tempBase, 'home'));
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    rmSync(tempBase, { recursive: true, force: true });
    if (hadActiveRoot) {
      process.env.ACTIVE_ROOT = originalActiveRoot;
    } else {
      delete process.env.ACTIVE_ROOT;
    }
    if (originalXdgData !== undefined) process.env.XDG_DATA_HOME = originalXdgData;
    else delete process.env.XDG_DATA_HOME;
    if (originalXdgConfig !== undefined) process.env.XDG_CONFIG_HOME = originalXdgConfig;
    else delete process.env.XDG_CONFIG_HOME;
    if (originalXdgState !== undefined) process.env.XDG_STATE_HOME = originalXdgState;
    else delete process.env.XDG_STATE_HOME;
  });

  it('runs all steps and returns the report with --yes', async () => {
    // Force a supervisor-less platform so this end-to-end run never mutates the
    // developer's real systemd/launchd domain — the setup command does not
    // thread an injectable `spawn`, and `getSupervisor()` would otherwise drive
    // real `systemctl`/`launchctl`. The supervision step has its own dedicated
    // coverage (supervision-systemd/-launchd/-steps tests).
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'sunos',
      configurable: true,
    });
    try {
      const result = await setupCmd.run(
        { yes: true },
        ctxFor(process.env.ACTIVE_ROOT!),
      );
      expect(result.banner).toContain('active-work');
      expect(result.steps.length).toBeGreaterThanOrEqual(5);
      for (const step of result.steps) {
        expect(step.ok).toBe(true);
      }
      expect(existsSync(path.join(process.env.ACTIVE_ROOT!, '.schema-version'))).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('installs and removes the /aw-prompt command', async () => {
    const target = path.join(
      tempBase,
      'home',
      '.claude',
      'commands',
      'aw-prompt.md',
    );

    const install = await setupSteps.stepInstallCommand({});
    expect(install.ok).toBe(true);
    expect(install.done).toBe(true);
    expect(existsSync(target)).toBe(true);

    const remove = await setupSteps.uninstallCommand({});
    expect(remove.ok).toBe(true);
    expect(remove.done).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it('short-circuits at the first failure', async () => {
    const original = setupSteps.runSetup;
    const spy = vi.spyOn(setupSteps, 'runSetup').mockImplementation(async () => ({
      banner: 'active-work setup',
      steps: [
        { name: 'check-node', ok: true, done: true, message: 'OK' },
        { name: 'create-active-root', ok: false, error: 'simulated' },
      ],
    }));
    try {
      await expect(
        setupCmd.run({ yes: true }, ctxFor(process.env.ACTIVE_ROOT!)),
      ).rejects.toThrow(/create-active-root/);
    } finally {
      spy.mockRestore();
      void original;
    }
  });
});

describe('active-work uninstall', () => {
  let tempBase: string;
  let fakeHome: string;
  let originalActiveRoot: string | undefined;
  let hadActiveRoot = false;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempBase = mkdtempSync(path.join(tmpdir(), 'aw-uninstall-cmd-'));
    fakeHome = path.join(tempBase, 'home');
    hadActiveRoot = Object.prototype.hasOwnProperty.call(
      process.env,
      'ACTIVE_ROOT',
    );
    originalActiveRoot = process.env.ACTIVE_ROOT;
    process.env.ACTIVE_ROOT = path.join(tempBase, 'active');
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    await fs.mkdir(process.env.ACTIVE_ROOT, { recursive: true });
    await fs.writeFile(
      path.join(process.env.ACTIVE_ROOT, '.schema-version'),
      '1\n',
      'utf8',
    );
    const skillDir = path.join(fakeHome, '.claude', 'skills', 'active-work');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# skill\n', 'utf8');
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    rmSync(tempBase, { recursive: true, force: true });
    if (hadActiveRoot) {
      process.env.ACTIVE_ROOT = originalActiveRoot;
    } else {
      delete process.env.ACTIVE_ROOT;
    }
  });

  it('removes skill but preserves the active root with --yes', async () => {
    const result = await uninstallCmd.run(
      { yes: true },
      ctxFor(process.env.ACTIVE_ROOT!),
    );
    expect(result.activeRootPreservedAt).toBe(process.env.ACTIVE_ROOT);
    // Skill dir removed
    const skillMarker = path.join(
      fakeHome,
      '.claude',
      'skills',
      'active-work',
      'SKILL.md',
    );
    expect(existsSync(skillMarker)).toBe(false);
    // Active root preserved
    expect(existsSync(process.env.ACTIVE_ROOT!)).toBe(true);
    expect(
      existsSync(path.join(process.env.ACTIVE_ROOT!, '.schema-version')),
    ).toBe(true);
  });
});
