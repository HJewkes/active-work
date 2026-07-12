import { promises as fs, mkdtempSync, rmSync, existsSync } from 'node:fs';
import type { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  STEP_SUPERVISION,
  UNIT_NAME,
  getUnitPath,
  getUnitDir,
  renderUnit,
  stepInstallSupervision,
  uninstallSupervision,
  isUnitActive,
} from '../../src/setup/supervision-systemd.js';
import type { StepPaths } from '../../src/setup/steps.js';

interface FakeChild {
  stderr: { on: (event: string, cb: (chunk: Buffer | string) => void) => void };
  on: (event: string, cb: (arg?: unknown) => void) => void;
}

type SpawnCall = { cmd: string; args: string[] };

/**
 * Build a fake spawn that:
 *   - records every (cmd, args) it sees
 *   - exits 0 by default unless `exitCodes` returns something else
 *   - emits a synthetic ENOENT spawn error when `enoent` matches
 */
function makeFakeSpawn(opts: {
  exitCodes?: (call: SpawnCall) => number;
  enoent?: (call: SpawnCall) => boolean;
} = {}): {
  spawn: typeof nodeSpawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnFn = vi.fn((cmd: string, args: string[]) => {
    const call: SpawnCall = { cmd, args };
    calls.push(call);
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    const child: FakeChild = {
      stderr: { on: () => undefined },
      on: (event, cb) => {
        handlers[event] ??= [];
        handlers[event]!.push(cb);
      },
    };
    queueMicrotask(() => {
      if (opts.enoent?.(call)) {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        handlers.error?.forEach((cb) => cb(err));
        return;
      }
      const code = opts.exitCodes?.(call) ?? 0;
      handlers.close?.forEach((cb) => cb(code));
    });
    return child as unknown as ReturnType<typeof nodeSpawn>;
  });
  return { spawn: spawnFn as unknown as typeof nodeSpawn, calls };
}

function makeTempPaths(): { paths: StepPaths; cleanup: () => void } {
  const base = mkdtempSync(path.join(tmpdir(), 'aw-systemd-test-'));
  const paths: StepPaths = {
    activeRoot: path.join(base, 'active'),
    stateRoot: path.join(base, 'state'),
    configRoot: path.join(base, 'config'),
    homeDir: path.join(base, 'home'),
  };
  return { paths, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

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

describe('renderUnit', () => {
  it('produces a valid [Unit]/[Service]/[Install] structure', () => {
    const unit = renderUnit({ cliEntry: '/opt/aw/dist/cli.js', nodeBin: '/usr/bin/node' });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/aw/dist/cli.js mcp serve');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('appends --port when overridden', () => {
    const unit = renderUnit({
      cliEntry: '/x/cli.js',
      nodeBin: '/x/node',
      port: 7777,
    });
    expect(unit).toContain('ExecStart=/x/node /x/cli.js mcp serve --port 7777');
  });

  it('quotes paths containing spaces', () => {
    const unit = renderUnit({
      cliEntry: '/path with spaces/cli.js',
      nodeBin: '/usr/bin/node',
    });
    expect(unit).toContain('ExecStart=/usr/bin/node "/path with spaces/cli.js" mcp serve');
  });
});

describe('getUnitPath / getUnitDir', () => {
  it('points at ~/.config/systemd/user', () => {
    expect(getUnitDir('/home/foo')).toBe('/home/foo/.config/systemd/user');
    expect(getUnitPath('/home/foo')).toBe(
      `/home/foo/.config/systemd/user/${UNIT_NAME}`,
    );
  });
});

describe('stepInstallSupervision', () => {
  let paths: StepPaths;
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTempPaths();
    paths = t.paths;
    cleanup = t.cleanup;
  });
  afterEach(() => {
    cleanup();
    restorePlatform();
  });

  it('no-ops on darwin (and reports the platform)', async () => {
    setPlatform('darwin');
    const { spawn, calls } = makeFakeSpawn();
    const result = await stepInstallSupervision({
      paths,
      spawn,
      cliEntry: '/x/cli.js',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(false);
      expect(result.message).toMatch(/Linux/);
      expect(result.message).toMatch(/darwin/);
    }
    expect(calls).toHaveLength(0);
    expect(existsSync(getUnitPath(paths.homeDir))).toBe(false);
  });

  it('writes the unit + runs daemon-reload + enable --now on linux', async () => {
    setPlatform('linux');
    const { spawn, calls } = makeFakeSpawn();
    const result = await stepInstallSupervision({
      paths,
      spawn,
      cliEntry: '/x/cli.js',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(true);
      expect(result.message).toMatch(/installed/);
    }
    // daemon-reload, then enable-linger (username-agnostic), then enable --now.
    expect(calls[0]).toEqual({ cmd: 'systemctl', args: ['--user', 'daemon-reload'] });
    expect(calls[1]!.cmd).toBe('loginctl');
    expect(calls[1]!.args[0]).toBe('enable-linger');
    expect(calls[2]).toEqual({
      cmd: 'systemctl',
      args: ['--user', 'enable', '--now', UNIT_NAME],
    });
    if (result.ok) {
      expect(result.message).toMatch(/Lingering enabled/);
    }
    const unitPath = getUnitPath(paths.homeDir);
    expect(existsSync(unitPath)).toBe(true);
    const content = await fs.readFile(unitPath, 'utf8');
    expect(content).toContain('ExecStart=');
    expect(content).toContain('/x/cli.js mcp serve');
  });

  it('still succeeds but notes when enabling linger fails', async () => {
    setPlatform('linux');
    // loginctl fails (e.g. needs privileges); everything else exits 0.
    const { spawn } = makeFakeSpawn({
      exitCodes: (call) => (call.cmd === 'loginctl' ? 1 : 0),
    });
    const result = await stepInstallSupervision({
      paths,
      spawn,
      cliEntry: '/x/cli.js',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The unit still installs+enables; only the linger note changes.
      expect(result.done).toBe(true);
      expect(result.message).toMatch(/could not enable lingering/);
      expect(result.message).toMatch(/loginctl enable-linger/);
    }
  });

  it('is idempotent when the unit content already matches', async () => {
    setPlatform('linux');
    const first = makeFakeSpawn();
    await stepInstallSupervision({
      paths,
      spawn: first.spawn,
      cliEntry: '/x/cli.js',
    });

    const second = makeFakeSpawn();
    const result = await stepInstallSupervision({
      paths,
      spawn: second.spawn,
      cliEntry: '/x/cli.js',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(false);
      expect(result.message).toMatch(/refreshed/);
    }
  });

  it('falls back to manual instructions when systemctl is missing', async () => {
    setPlatform('linux');
    const { spawn } = makeFakeSpawn({ enoent: () => true });
    const result = await stepInstallSupervision({
      paths,
      spawn,
      cliEntry: '/x/cli.js',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(false);
      expect(result.message).toContain('systemctl');
      expect(result.message).toContain('daemon-reload');
    }
    // Unit file should still be written so a later manual run works.
    expect(existsSync(getUnitPath(paths.homeDir))).toBe(true);
  });

  it('returns a hard failure when daemon-reload exits non-zero', async () => {
    setPlatform('linux');
    const { spawn } = makeFakeSpawn({
      exitCodes: (call) => (call.args.includes('daemon-reload') ? 1 : 0),
    });
    const result = await stepInstallSupervision({
      paths,
      spawn,
      cliEntry: '/x/cli.js',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/daemon-reload/);
  });
});

describe('uninstallSupervision', () => {
  let paths: StepPaths;
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTempPaths();
    paths = t.paths;
    cleanup = t.cleanup;
  });
  afterEach(() => {
    cleanup();
    restorePlatform();
  });

  it('no-ops on darwin', async () => {
    setPlatform('darwin');
    const { spawn, calls } = makeFakeSpawn();
    const result = await uninstallSupervision({ paths, spawn });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.done).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('no-ops when the unit is absent', async () => {
    setPlatform('linux');
    const { spawn, calls } = makeFakeSpawn();
    const result = await uninstallSupervision({ paths, spawn });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(false);
      expect(result.message).toMatch(/No systemd unit/);
    }
    expect(calls).toHaveLength(0);
  });

  it('disables, removes the file, and reloads on linux', async () => {
    setPlatform('linux');
    // Place a unit file so the disable path activates.
    await fs.mkdir(getUnitDir(paths.homeDir), { recursive: true });
    await fs.writeFile(
      getUnitPath(paths.homeDir),
      renderUnit({ cliEntry: '/x/cli.js', nodeBin: '/usr/bin/node' }),
      'utf8',
    );
    const { spawn, calls } = makeFakeSpawn();
    const result = await uninstallSupervision({ paths, spawn });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done).toBe(true);
      expect(result.message).toMatch(/Disabled and removed/);
    }
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      `--user disable --now ${UNIT_NAME}`,
      '--user daemon-reload',
    ]);
    expect(existsSync(getUnitPath(paths.homeDir))).toBe(false);
  });
});

describe('isUnitActive', () => {
  afterEach(() => restorePlatform());

  it('returns false on non-linux without calling systemctl', async () => {
    setPlatform('darwin');
    const { spawn, calls } = makeFakeSpawn();
    const active = await isUnitActive({ spawn });
    expect(active).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('returns true when `systemctl is-active` exits 0', async () => {
    setPlatform('linux');
    const { spawn } = makeFakeSpawn({ exitCodes: () => 0 });
    expect(await isUnitActive({ spawn })).toBe(true);
  });

  it('returns false when `systemctl is-active` exits non-zero', async () => {
    setPlatform('linux');
    const { spawn } = makeFakeSpawn({ exitCodes: () => 3 });
    expect(await isUnitActive({ spawn })).toBe(false);
  });
});

describe('STEP_SUPERVISION constant', () => {
  it('matches the name used by setup/steps.ts', () => {
    expect(STEP_SUPERVISION).toBe('install-supervision');
  });
});
