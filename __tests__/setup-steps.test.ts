import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import type { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as clackPrompts from '@clack/prompts';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  stepCheckNode,
  stepCreateActiveRoot,
  stepWriteSchemaVersion,
  stepWriteConfigStub,
  stepInstallSkill,
  stepRegisterMcp,
  stepStartDaemon,
  stepIngestion,
  stepSupervision,
  type StepPaths,
} from '../src/setup/steps.js';

function makeTempPaths(): {
  paths: StepPaths;
  cleanup: () => void;
} {
  const base = mkdtempSync(path.join(tmpdir(), 'aw-setup-test-'));
  const paths: StepPaths = {
    activeRoot: path.join(base, 'active'),
    stateRoot: path.join(base, 'state'),
    configRoot: path.join(base, 'config'),
    homeDir: path.join(base, 'home'),
  };
  return {
    paths,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describe('stepCheckNode', () => {
  it('passes on Node 22+', async () => {
    const result = await stepCheckNode();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toContain('OK');
    }
  });

  it('fails when process.versions.node is too low', async () => {
    const orig = process.versions.node;
    Object.defineProperty(process.versions, 'node', {
      value: '18.0.0',
      configurable: true,
    });
    try {
      const result = await stepCheckNode();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/Node 22\+ required/);
      }
    } finally {
      Object.defineProperty(process.versions, 'node', {
        value: orig,
        configurable: true,
      });
    }
  });
});

describe('stepCreateActiveRoot', () => {
  let paths: StepPaths;
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTempPaths();
    paths = t.paths;
    cleanup = t.cleanup;
  });
  afterEach(() => cleanup());

  it('creates all three dirs when missing', async () => {
    const result = await stepCreateActiveRoot({ paths });
    expect(result.ok).toBe(true);
    expect(existsSync(paths.activeRoot)).toBe(true);
    expect(existsSync(paths.stateRoot)).toBe(true);
    expect(existsSync(paths.configRoot)).toBe(true);
    if (result.ok) expect(result.done).toBe(true);
  });

  it('is idempotent', async () => {
    await stepCreateActiveRoot({ paths });
    const result = await stepCreateActiveRoot({ paths });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(false);
      expect(result.message).toMatch(/already present/);
    }
  });
});

describe('stepWriteSchemaVersion', () => {
  let paths: StepPaths;
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTempPaths();
    paths = t.paths;
    cleanup = t.cleanup;
  });
  afterEach(() => cleanup());

  it('stamps the schema version on a fresh active root', async () => {
    await fs.mkdir(paths.activeRoot, { recursive: true });
    const result = await stepWriteSchemaVersion({ paths });
    expect(result.ok).toBe(true);
    const stamped = await fs.readFile(
      path.join(paths.activeRoot, '.schema-version'),
      'utf8',
    );
    expect(stamped.trim()).toBe('2');
  });
});

describe('stepWriteConfigStub', () => {
  let paths: StepPaths;
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTempPaths();
    paths = t.paths;
    cleanup = t.cleanup;
  });
  afterEach(() => cleanup());

  it('writes a fresh stub when none exists', async () => {
    const result = await stepWriteConfigStub({ paths });
    expect(result.ok).toBe(true);
    const configPath = path.join(paths.configRoot, 'config.json');
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.discovery.githubRepos).toEqual([]);
    expect(raw.discovery.projectsRoot).toBe('~/Documents/projects');
  });

  it('skips when the file exists and --update is off', async () => {
    await fs.mkdir(paths.configRoot, { recursive: true });
    await fs.writeFile(
      path.join(paths.configRoot, 'config.json'),
      '{"discovery":{"githubRepos":["foo/bar"],"localRepos":[],"projectsRoot":"~/x"}}\n',
      'utf8',
    );
    const result = await stepWriteConfigStub({ paths });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(false);
      expect(result.message).toMatch(/left untouched/);
    }
    const raw = JSON.parse(
      await fs.readFile(path.join(paths.configRoot, 'config.json'), 'utf8'),
    );
    expect(raw.discovery.githubRepos).toEqual(['foo/bar']);
  });

  it('overwrites when --update is set', async () => {
    await fs.mkdir(paths.configRoot, { recursive: true });
    await fs.writeFile(
      path.join(paths.configRoot, 'config.json'),
      '{"old":true}\n',
      'utf8',
    );
    const result = await stepWriteConfigStub({ paths, update: true });
    expect(result.ok).toBe(true);
    const raw = JSON.parse(
      await fs.readFile(path.join(paths.configRoot, 'config.json'), 'utf8'),
    );
    expect(raw.discovery).toBeDefined();
  });
});

describe('stepInstallSkill', () => {
  let paths: StepPaths;
  let cleanup: () => void;
  let repoRoot: string;

  beforeEach(async () => {
    const t = makeTempPaths();
    paths = t.paths;
    cleanup = t.cleanup;
    repoRoot = path.join(paths.homeDir, '..', 'repo');
    await fs.mkdir(path.join(repoRoot, 'skill'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, 'skill', 'SKILL.md'),
      '# active-work skill\n',
      'utf8',
    );
  });
  afterEach(() => cleanup());

  it('copies the skill into ~/.claude/skills/active-work', async () => {
    const result = await stepInstallSkill({ paths, repoRoot });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.done).toBe(true);
    const target = path.join(
      paths.homeDir,
      '.claude',
      'skills',
      'active-work',
      'SKILL.md',
    );
    expect(existsSync(target)).toBe(true);
  });

  it('is idempotent when skill is already present', async () => {
    await stepInstallSkill({ paths, repoRoot });
    const result = await stepInstallSkill({ paths, repoRoot });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(false);
      expect(result.message).toMatch(/already installed/);
    }
  });
});

describe('stepRegisterMcp', () => {
  it('prints fallback instructions when `claude` is missing (ENOENT)', async () => {
    const fakeSpawn = vi.fn(() => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
      const child = {
        stderr: { on: () => undefined },
        on: (event: string, cb: (arg?: unknown) => void) => {
          handlers[event] ??= [];
          handlers[event]!.push(cb);
        },
      };
      queueMicrotask(() => {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        handlers.error?.forEach((cb) => cb(err));
      });
      return child as unknown as ReturnType<typeof nodeSpawn>;
    });
    const result = await stepRegisterMcp({
      spawn: fakeSpawn as unknown as typeof nodeSpawn,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(false);
      expect(result.message).toContain('~/.claude.json');
      expect(result.message).toContain('mcp');
    }
  });

  it('marks done when `claude mcp add` exits 0', async () => {
    const fakeSpawn = vi.fn(() => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
      const child = {
        stderr: { on: () => undefined },
        on: (event: string, cb: (arg?: unknown) => void) => {
          handlers[event] ??= [];
          handlers[event]!.push(cb);
        },
      };
      queueMicrotask(() => {
        handlers.close?.forEach((cb) => cb(0));
      });
      return child as unknown as ReturnType<typeof nodeSpawn>;
    });
    const result = await stepRegisterMcp({
      spawn: fakeSpawn as unknown as typeof nodeSpawn,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.done).toBe(true);
  });
});

describe('stepStartDaemon', () => {
  it('skips with --yes', async () => {
    const result = await stepStartDaemon({ yes: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(false);
      expect(result.message).toMatch(/--yes/);
    }
  });

  it('skips on cancel/no answer', async () => {
    const prompts = {
      confirm: vi.fn(async () => false),
      isCancel: vi.fn(() => false),
    } as unknown as typeof clackPrompts;
    const result = await stepStartDaemon({ prompts });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.done).toBe(false);
  });
});

describe('stepSupervision', () => {
  const ORIGINAL_PLATFORM = process.platform;
  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }
  function restorePlatform(): void {
    Object.defineProperty(process, 'platform', {
      value: ORIGINAL_PLATFORM,
      configurable: true,
    });
  }
  afterEach(() => restorePlatform());

  it('no-ops on platforms without a supervisor (win32)', async () => {
    setPlatform('win32');
    const result = await stepSupervision({ yes: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(false);
      expect(result.message).toMatch(/no daemon supervisor/i);
    }
  });

  it('installs a launchd agent on darwin', async () => {
    setPlatform('darwin');
    const { paths, cleanup } = makeTempPaths();
    // Fake launchctl: bootout may exit non-zero (not loaded), bootstrap exits 0.
    const calls: string[][] = [];
    const spawn = vi.fn((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
      const child = {
        stderr: { on: () => undefined },
        on: (event: string, cb: (arg?: unknown) => void) => {
          handlers[event] ??= [];
          handlers[event]!.push(cb);
        },
      };
      queueMicrotask(() => {
        const code = args.includes('bootout') ? 3 : 0;
        handlers.close?.forEach((cb) => cb(code));
      });
      return child as unknown as ReturnType<typeof nodeSpawn>;
    });
    try {
      const result = await stepSupervision({
        yes: true,
        paths,
        fs,
        spawn: spawn as unknown as typeof nodeSpawn,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.done).toBe(true);
        expect(result.message).toMatch(/launchd/);
      }
      expect(
        existsSync(
          path.join(
            paths.homeDir,
            'Library',
            'LaunchAgents',
            'dev.hjewkes.active-work.plist',
          ),
        ),
      ).toBe(true);
      expect(calls.some((c) => c.includes('bootstrap'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('respects a cancel/no answer on linux', async () => {
    setPlatform('linux');
    const prompts = {
      confirm: vi.fn(async () => false),
      isCancel: vi.fn(() => false),
    } as unknown as typeof clackPrompts;
    const result = await stepSupervision({ prompts });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(false);
      expect(result.message).toMatch(/skipped/i);
    }
  });

  // Regression: on a Linux host without a working user systemd session
  // (CI, containers, WSL-without-systemd), `systemctl --user enable` exits
  // non-zero. That must degrade to a non-fatal warning so `active-work setup`
  // completes, not abort the whole run at the supervision step.
  it('downgrades a systemctl enable failure to a non-fatal warning on linux', async () => {
    setPlatform('linux');
    const { paths, cleanup } = makeTempPaths();
    const spawn = vi.fn((cmd: string, args: string[]) => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
      const child = {
        stderr: {
          on: (event: string, cb: (chunk: Buffer | string) => void) => {
            handlers[event] ??= [];
            if (args.includes('enable')) cb('Failed to enable unit');
          },
        },
        on: (event: string, cb: (arg?: unknown) => void) => {
          handlers[event] ??= [];
          handlers[event]!.push(cb);
        },
      };
      queueMicrotask(() => {
        // daemon-reload succeeds; enable fails as it would with no user bus.
        const code = args.includes('enable') ? 1 : 0;
        handlers.close?.forEach((cb) => cb(code));
      });
      return child as unknown as ReturnType<typeof nodeSpawn>;
    });
    try {
      const result = await stepSupervision({
        yes: true,
        paths,
        fs,
        spawn: spawn as unknown as typeof nodeSpawn,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.done).toBe(false);
        expect(result.message).toMatch(/systemctl --user enable/);
      }
      // The unit file is still written so a later real session can enable it.
      expect(existsSync(path.join(paths.homeDir, '.config', 'systemd', 'user', 'active-work.service'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('stepStartDaemon (linux supervision detection)', () => {
  const ORIGINAL_PLATFORM = process.platform;
  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }
  function restorePlatform(): void {
    Object.defineProperty(process, 'platform', {
      value: ORIGINAL_PLATFORM,
      configurable: true,
    });
  }
  afterEach(() => restorePlatform());

  it('skips the manual spawn when `systemctl is-active` exits 0', async () => {
    setPlatform('linux');
    const fakeSpawn = vi.fn((cmd: string, args: string[]) => {
      void cmd;
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
      const child = {
        stderr: { on: () => undefined },
        on: (event: string, cb: (arg?: unknown) => void) => {
          handlers[event] ??= [];
          handlers[event]!.push(cb);
        },
      };
      queueMicrotask(() => {
        // Only the is-active probe is expected; reply 0 to signal active.
        if (args.includes('is-active')) {
          handlers.close?.forEach((cb) => cb(0));
        } else {
          handlers.close?.forEach((cb) => cb(0));
        }
      });
      return child as unknown as ReturnType<typeof nodeSpawn>;
    });
    const result = await stepStartDaemon({
      spawn: fakeSpawn as unknown as typeof nodeSpawn,
      yes: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(false);
      expect(result.message).toMatch(/systemd/);
    }
    // Only the is-active probe should have been invoked — no execPath spawn.
    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    expect(fakeSpawn.mock.calls[0]?.[0]).toBe('systemctl');
  });
});

describe('stepIngestion', () => {
  it('returns guidance when --yes', async () => {
    const result = await stepIngestion({ yes: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(false);
      expect(result.message).toMatch(/discover/);
    }
  });
});
