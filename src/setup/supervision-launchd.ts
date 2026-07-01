/**
 * macOS user-level launchd supervision for the active-work daemon (AW-2).
 *
 * Installs a `~/Library/LaunchAgents/dev.hjewkes.active-work.plist` LaunchAgent
 * that runs `active-work mcp serve`; launchd handles restart on crash and
 * relaunch at login. On non-macOS platforms every step here is a no-op — the
 * Linux equivalent lives in `supervision-systemd.ts`.
 */
import { promises as fsp } from 'node:fs';
import nodePath from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import { STEP_SUPERVISION } from './supervision-systemd.js';
import type { SetupDeps, StepPaths, StepResult } from './steps.js';

export const PLIST_LABEL = 'dev.hjewkes.active-work';
export const PLIST_NAME = `${PLIST_LABEL}.plist`;

function isDarwin(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

function resolveLocalDeps(deps: SetupDeps): {
  fs: typeof fsp;
  spawn: typeof nodeSpawn;
  paths: StepPaths;
  cliEntry: string;
  uid: number;
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
  const uid = process.getuid?.() ?? 0;
  return { fs, spawn, paths, cliEntry, uid, platform: process.platform };
}

export function getAgentDir(homeDir: string): string {
  return nodePath.join(homeDir, 'Library', 'LaunchAgents');
}

export function getPlistPath(homeDir: string): string {
  return nodePath.join(getAgentDir(homeDir), PLIST_NAME);
}

function getLogDir(homeDir: string): string {
  return nodePath.join(homeDir, 'Library', 'Logs', 'active-work');
}

/** The `gui/<uid>/<label>` service target used by `launchctl`. */
function serviceTarget(uid: number): string {
  return `gui/${uid}/${PLIST_LABEL}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface PlistOptions {
  cliEntry: string;
  homeDir: string;
  port?: number;
  nodeBin?: string;
}

/** Render the launchd plist for the daemon. */
export function renderPlist(opts: PlistOptions): string {
  const node = opts.nodeBin ?? process.execPath;
  const argv = [node, opts.cliEntry, 'mcp', 'serve'];
  if (opts.port !== undefined) argv.push('--port', String(opts.port));
  const logDir = getLogDir(opts.homeDir);
  const programArgs = argv
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${PLIST_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    programArgs,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>NODE_ENV</key>',
    '    <string>production</string>',
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(nodePath.join(logDir, 'daemon.out.log'))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(nodePath.join(logDir, 'daemon.err.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
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
 * Probe whether the launchd agent is currently loaded.
 * Returns false (without error) on non-macOS or when `launchctl` is missing.
 */
export async function isAgentLoaded(deps: SetupDeps = {}): Promise<boolean> {
  const { spawn, uid, platform } = resolveLocalDeps(deps);
  if (!isDarwin(platform)) return false;
  const result = await runOnce(spawn, 'launchctl', [
    'print',
    serviceTarget(uid),
  ]);
  if (result.spawnError) return false;
  return result.code === 0;
}

export interface InstallLaunchAgentOptions {
  /** Override the port baked into the plist's ProgramArguments. */
  port?: number;
}

/**
 * Install (or refresh) the user LaunchAgent and load it.
 *
 * No-op on non-macOS. On macOS it writes the plist, boots out any stale copy,
 * and bootstraps it into the `gui/<uid>` domain. Idempotent: if the plist is
 * unchanged and already loaded, returns done:false.
 */
export async function installLaunchAgent(
  deps: SetupDeps = {},
  opts: InstallLaunchAgentOptions = {},
): Promise<StepResult> {
  const { fs, spawn, paths, cliEntry, uid, platform } = resolveLocalDeps(deps);
  if (!isDarwin(platform)) {
    return {
      ok: true,
      name: STEP_SUPERVISION,
      done: false,
      message: `Skipped: launchd supervision only applies on macOS (this host is ${platform})`,
    };
  }
  const plistPath = getPlistPath(paths.homeDir);
  const desired = renderPlist({ cliEntry, homeDir: paths.homeDir, port: opts.port });

  try {
    await fs.mkdir(getAgentDir(paths.homeDir), { recursive: true });
    await fs.mkdir(getLogDir(paths.homeDir), { recursive: true });

    let existing: string | null = null;
    try {
      existing = await fs.readFile(plistPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const unchanged = existing === desired;
    if (unchanged && (await isAgentLoaded(deps))) {
      return {
        ok: true,
        name: STEP_SUPERVISION,
        done: false,
        message: `launchd agent already loaded from ${plistPath}`,
      };
    }
    if (!unchanged) {
      await fs.writeFile(plistPath, desired, 'utf8');
    }

    // Boot out any stale instance first so bootstrap is idempotent. A missing
    // service exits non-zero ("No such process") — that is expected, not fatal.
    const bootout = await runOnce(spawn, 'launchctl', [
      'bootout',
      serviceTarget(uid),
    ]);
    if (bootout.spawnError) {
      return {
        ok: true,
        name: STEP_SUPERVISION,
        done: false,
        message: `Wrote ${plistPath} but \`launchctl\` is unavailable (${bootout.spawnError.message}). Load it manually with \`launchctl bootstrap gui/${uid} ${plistPath}\`.`,
      };
    }

    const bootstrap = await runOnce(spawn, 'launchctl', [
      'bootstrap',
      `gui/${uid}`,
      plistPath,
    ]);
    if (bootstrap.spawnError) {
      return {
        ok: false,
        name: STEP_SUPERVISION,
        error: `launchctl bootstrap failed to spawn: ${bootstrap.spawnError.message}`,
      };
    }
    if (bootstrap.code !== 0) {
      return {
        ok: false,
        name: STEP_SUPERVISION,
        error: `launchctl bootstrap gui/${uid} exited ${bootstrap.code ?? 'null'}: ${bootstrap.stderr.trim()}`,
      };
    }

    return {
      ok: true,
      name: STEP_SUPERVISION,
      done: true,
      message: `launchd agent installed at ${plistPath} and loaded`,
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
 * Boot out the LaunchAgent and remove the plist.
 * No-op on non-macOS or when the plist is absent.
 */
export async function uninstallLaunchAgent(
  deps: SetupDeps = {},
): Promise<StepResult> {
  const { fs, spawn, paths, uid, platform } = resolveLocalDeps(deps);
  if (!isDarwin(platform)) {
    return {
      ok: true,
      name: STEP_SUPERVISION,
      done: false,
      message: `Skipped: launchd supervision only applies on macOS (this host is ${platform})`,
    };
  }
  const plistPath = getPlistPath(paths.homeDir);
  try {
    let present = true;
    try {
      await fs.stat(plistPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') present = false;
      else throw err;
    }
    if (!present) {
      return {
        ok: true,
        name: STEP_SUPERVISION,
        done: false,
        message: `No launchd agent at ${plistPath}`,
      };
    }
    // Best-effort bootout; a not-loaded agent exits non-zero, which is fine.
    const bootout = await runOnce(spawn, 'launchctl', [
      'bootout',
      serviceTarget(uid),
    ]);
    await fs.rm(plistPath, { force: true });
    if (bootout.spawnError) {
      return {
        ok: true,
        name: STEP_SUPERVISION,
        done: true,
        message: `Removed ${plistPath} (launchctl unavailable: ${bootout.spawnError.message})`,
      };
    }
    return {
      ok: true,
      name: STEP_SUPERVISION,
      done: true,
      message: `Booted out and removed ${plistPath}`,
    };
  } catch (err) {
    return {
      ok: false,
      name: STEP_SUPERVISION,
      error: (err as Error).message,
    };
  }
}
