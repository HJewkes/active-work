/**
 * Linux user-level systemd supervision for the active-work daemon.
 *
 * Installs a `~/.config/systemd/user/active-work.service` unit that runs
 * `active-work mcp serve` in the foreground; systemd handles restart on
 * crash. Also enables lingering (`loginctl enable-linger`) so the daemon
 * survives logout and starts at boot. On non-Linux platforms every step here
 * is a no-op.
 */
import { promises as fsp } from 'node:fs';
import nodePath from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import type { SetupDeps, StepPaths, StepResult } from './steps.js';

export const UNIT_NAME = 'active-work.service';
export const STEP_SUPERVISION = 'install-supervision';

function isLinux(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux';
}

function resolveLocalDeps(deps: SetupDeps): {
  fs: typeof fsp;
  spawn: typeof nodeSpawn;
  paths: StepPaths;
  cliEntry: string;
  platform: NodeJS.Platform;
} {
  const fs = deps.fs ?? fsp;
  const spawn = deps.spawn ?? nodeSpawn;
  const homeDir = deps.paths?.homeDir ?? os.homedir();
  const paths: StepPaths =
    deps.paths ??
    ({
      activeRoot: '',
      stateRoot: '',
      configRoot: '',
      homeDir,
    } as StepPaths);
  const cliEntry = deps.cliEntry ?? process.argv[1] ?? 'active-work';
  return { fs, spawn, paths, cliEntry, platform: process.platform };
}

export function getUnitDir(homeDir: string): string {
  return nodePath.join(homeDir, '.config', 'systemd', 'user');
}

export function getUnitPath(homeDir: string): string {
  return nodePath.join(getUnitDir(homeDir), UNIT_NAME);
}

export interface UnitOptions {
  cliEntry: string;
  port?: number;
  nodeBin?: string;
}

/** Render the systemd unit file content. */
export function renderUnit(opts: UnitOptions): string {
  const node = opts.nodeBin ?? process.execPath;
  const args = ['mcp', 'serve'];
  if (opts.port !== undefined) {
    args.push('--port', String(opts.port));
  }
  // ExecStart must use absolute paths. Quote the node binary and entrypoint
  // in case they contain spaces (common on macOS dev paths, less so on Linux,
  // but cheap insurance).
  const execStart = [
    quoteIfNeeded(node),
    quoteIfNeeded(opts.cliEntry),
    ...args,
  ].join(' ');
  return [
    '[Unit]',
    'Description=active-work HTTP daemon (MCP + REST + dashboard)',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart}`,
    'Restart=on-failure',
    'RestartSec=5',
    'Environment=NODE_ENV=production',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function quoteIfNeeded(value: string): string {
  if (!/\s/.test(value)) return value;
  // systemd unit files support double-quoted argv elements; escape any embedded
  // double quotes and backslashes.
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Spawn a process and capture its exit code + stderr. */
function runOnce(
  spawn: typeof nodeSpawn,
  cmd: string,
  args: string[],
): Promise<{ code: number | null; stderr: string; spawnError?: Error }> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ code: null, stderr, spawnError: err });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        resolve({ code, stderr });
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      resolve({ code: null, stderr, spawnError: err as Error });
    }
  });
}

/**
 * Probe whether the user-level systemd unit is currently active.
 * Returns false (without error) on non-Linux or when `systemctl` is missing.
 */
export async function isUnitActive(deps: SetupDeps = {}): Promise<boolean> {
  const { spawn, platform } = resolveLocalDeps(deps);
  if (!isLinux(platform)) return false;
  const result = await runOnce(spawn, 'systemctl', [
    '--user',
    'is-active',
    '--quiet',
    UNIT_NAME,
  ]);
  if (result.spawnError) return false;
  return result.code === 0;
}

export interface InstallSupervisionOptions {
  /** Override the port baked into the unit's ExecStart. */
  port?: number;
}

/**
 * Install (or refresh) the user-level systemd unit and enable+start it.
 *
 * No-op on non-Linux. On Linux it writes the unit, reloads the daemon,
 * and runs `enable --now`. Idempotent: if the unit is already active and
 * its content matches, returns done:false.
 */
export async function stepInstallSupervision(
  deps: SetupDeps = {},
  opts: InstallSupervisionOptions = {},
): Promise<StepResult> {
  const { fs, spawn, paths, cliEntry, platform } = resolveLocalDeps(deps);
  if (!isLinux(platform)) {
    return {
      ok: true,
      name: STEP_SUPERVISION,
      done: false,
      message: `Skipped: systemd supervision only applies on Linux (this host is ${platform})`,
    };
  }
  const unitDir = getUnitDir(paths.homeDir);
  const unitPath = getUnitPath(paths.homeDir);
  const desired = renderUnit({ cliEntry, port: opts.port });

  try {
    await fs.mkdir(unitDir, { recursive: true });
    let existing: string | null = null;
    try {
      existing = await fs.readFile(unitPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const unchanged = existing === desired;
    if (!unchanged) {
      await fs.writeFile(unitPath, desired, 'utf8');
    }

    const reload = await runOnce(spawn, 'systemctl', [
      '--user',
      'daemon-reload',
    ]);
    if (reload.spawnError) {
      return {
        ok: true,
        name: STEP_SUPERVISION,
        done: false,
        message: `Wrote ${unitPath} but \`systemctl\` is unavailable (${reload.spawnError.message}). Run \`systemctl --user daemon-reload && systemctl --user enable --now ${UNIT_NAME}\` manually.`,
      };
    }
    if (reload.code !== 0) {
      return {
        ok: false,
        name: STEP_SUPERVISION,
        error: `systemctl --user daemon-reload exited ${reload.code ?? 'null'}: ${reload.stderr.trim()}`,
      };
    }

    // Enable lingering so the user manager — and thus the daemon — persists
    // across logout and starts at boot. Without it a `--user` unit is torn down
    // when the user's last session ends, so the daemon would not survive logout.
    //
    // Pass the username explicitly: the bare `loginctl enable-linger` form needs
    // an active login session to resolve "self" (it errors "No such device" when
    // run outside one), whereas the explicit form still routes through polkit's
    // `set-self-linger` action when the target is the caller. Best-effort:
    // enabling linger can require privileges, so a failure degrades to a note
    // rather than failing the install.
    let lingerUser: string | undefined;
    try {
      lingerUser = os.userInfo().username;
    } catch {
      lingerUser = undefined;
    }
    const linger = await runOnce(spawn, 'loginctl', [
      'enable-linger',
      ...(lingerUser ? [lingerUser] : []),
    ]);
    const lingerEnabled = !linger.spawnError && linger.code === 0;

    const enable = await runOnce(spawn, 'systemctl', [
      '--user',
      'enable',
      '--now',
      UNIT_NAME,
    ]);
    if (enable.spawnError) {
      return {
        ok: false,
        name: STEP_SUPERVISION,
        error: `systemctl --user enable --now ${UNIT_NAME} failed to spawn: ${enable.spawnError.message}`,
      };
    }
    if (enable.code !== 0) {
      return {
        ok: false,
        name: STEP_SUPERVISION,
        error: `systemctl --user enable --now ${UNIT_NAME} exited ${enable.code ?? 'null'}: ${enable.stderr.trim()}`,
      };
    }

    const action = unchanged ? 'refreshed' : 'installed';
    const lingerCmd = `loginctl enable-linger${lingerUser ? ` ${lingerUser}` : ''}`;
    const lingerNote = lingerEnabled
      ? ' Lingering enabled — survives logout and starts at boot.'
      : ` NOTE: could not enable lingering; run \`sudo ${lingerCmd}\` so the daemon survives logout and starts at boot (without it, it stops when your session ends).`;
    return {
      ok: true,
      name: STEP_SUPERVISION,
      done: !unchanged,
      message: `Systemd unit ${action} at ${unitPath} and enabled.${lingerNote}`,
    };
  } catch (err) {
    return {
      ok: false,
      name: STEP_SUPERVISION,
      error: (err as Error).message,
    };
  }
}

/**
 * Disable the user-level unit and remove the file.
 * No-op on non-Linux or when the unit is absent.
 */
export async function uninstallSupervision(
  deps: SetupDeps = {},
): Promise<StepResult> {
  const { fs, spawn, paths, platform } = resolveLocalDeps(deps);
  if (!isLinux(platform)) {
    return {
      ok: true,
      name: STEP_SUPERVISION,
      done: false,
      message: `Skipped: systemd supervision only applies on Linux (this host is ${platform})`,
    };
  }
  const unitPath = getUnitPath(paths.homeDir);
  try {
    let present = true;
    try {
      await fs.stat(unitPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') present = false;
      else throw err;
    }
    if (!present) {
      return {
        ok: true,
        name: STEP_SUPERVISION,
        done: false,
        message: `No systemd unit at ${unitPath}`,
      };
    }
    const disable = await runOnce(spawn, 'systemctl', [
      '--user',
      'disable',
      '--now',
      UNIT_NAME,
    ]);
    if (disable.spawnError) {
      // systemctl missing — still try to remove the file so re-install is clean.
      await fs.rm(unitPath, { force: true });
      return {
        ok: true,
        name: STEP_SUPERVISION,
        done: true,
        message: `Removed ${unitPath} (systemctl unavailable: ${disable.spawnError.message})`,
      };
    }
    // Non-zero exit from `disable` is non-fatal (unit may already be inactive).
    await fs.rm(unitPath, { force: true });
    const reload = await runOnce(spawn, 'systemctl', [
      '--user',
      'daemon-reload',
    ]);
    if (reload.code !== 0 && !reload.spawnError) {
      return {
        ok: true,
        name: STEP_SUPERVISION,
        done: true,
        message: `Removed ${unitPath}; daemon-reload exited ${reload.code ?? 'null'}`,
      };
    }
    return {
      ok: true,
      name: STEP_SUPERVISION,
      done: true,
      message: `Disabled and removed ${unitPath}`,
    };
  } catch (err) {
    return {
      ok: false,
      name: STEP_SUPERVISION,
      error: (err as Error).message,
    };
  }
}
