import { promises as fs, mkdtempSync, rmSync, existsSync } from 'node:fs';
import type { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  PLIST_LABEL,
  getPlistPath,
  renderPlist,
  installLaunchAgent,
  uninstallLaunchAgent,
  isAgentLoaded,
} from '../../src/setup/supervision-launchd.js';
import type { StepPaths } from '../../src/setup/steps.js';

type SpawnCall = { cmd: string; args: string[] };

/**
 * Fake launchctl. NEVER touches real `launchctl` — that would mutate the
 * developer's real per-user launchd domain (the HOME sandbox does not cover
 * it). `exitCodes` maps a call to its exit code; `enoent` simulates a missing
 * binary.
 */
function makeFakeSpawn(
  opts: {
    exitCodes?: (call: SpawnCall) => number;
    enoent?: (call: SpawnCall) => boolean;
  } = {},
): { spawn: typeof nodeSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnFn = ((cmd: string, args: string[]) => {
    const call: SpawnCall = { cmd, args };
    calls.push(call);
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    const child = {
      stderr: { on: () => undefined },
      on: (event: string, cb: (arg?: unknown) => void) => {
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
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawn: spawnFn, calls };
}

function makeTempPaths(): { paths: StepPaths; cleanup: () => void } {
  const base = mkdtempSync(path.join(tmpdir(), 'aw-launchd-test-'));
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

describe('supervision-launchd', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: ORIGINAL_PLATFORM,
      configurable: true,
    });
  });

  describe('renderPlist', () => {
    it('emits a valid agent plist with absolute ProgramArguments', () => {
      const plist = renderPlist({
        cliEntry: '/opt/active-work/dist/cli.js',
        homeDir: '/Users/tester',
        nodeBin: '/usr/local/bin/node',
      });
      expect(plist).toContain(`<string>${PLIST_LABEL}</string>`);
      expect(plist).toContain('<string>/usr/local/bin/node</string>');
      expect(plist).toContain('<string>/opt/active-work/dist/cli.js</string>');
      expect(plist).toContain('<string>mcp</string>');
      expect(plist).toContain('<string>serve</string>');
      expect(plist).toContain('<key>RunAtLoad</key>');
      expect(plist).toContain('<key>KeepAlive</key>');
      expect(plist).toContain(
        '<string>/Users/tester/Library/Logs/active-work/daemon.out.log</string>',
      );
    });

    it('escapes XML metacharacters in paths', () => {
      const plist = renderPlist({
        cliEntry: '/tmp/a&b/cli.js',
        homeDir: '/Users/tester',
        nodeBin: '/usr/bin/node',
      });
      expect(plist).toContain('<string>/tmp/a&amp;b/cli.js</string>');
      expect(plist).not.toContain('a&b/cli.js');
    });

    it('includes --port when provided', () => {
      const plist = renderPlist({
        cliEntry: '/cli.js',
        homeDir: '/Users/tester',
        nodeBin: '/node',
        port: 7411,
      });
      expect(plist).toContain('<string>--port</string>');
      expect(plist).toContain('<string>7411</string>');
    });
  });

  describe('installLaunchAgent', () => {
    it('no-ops on non-macOS', async () => {
      setPlatform('linux');
      const { spawn, calls } = makeFakeSpawn();
      const { paths, cleanup } = makeTempPaths();
      try {
        const result = await installLaunchAgent({ paths, fs, spawn });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.done).toBe(false);
          expect(result.message).toMatch(/macOS/);
        }
        expect(calls).toHaveLength(0);
      } finally {
        cleanup();
      }
    });

    it('writes the plist and bootstraps it into the gui domain', async () => {
      setPlatform('darwin');
      const { spawn, calls } = makeFakeSpawn({
        exitCodes: (c) => (c.args.includes('bootout') ? 3 : 0),
      });
      const { paths, cleanup } = makeTempPaths();
      try {
        const result = await installLaunchAgent({ paths, fs, spawn });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.done).toBe(true);
        expect(existsSync(getPlistPath(paths.homeDir))).toBe(true);
        const bootstrap = calls.find((c) => c.args.includes('bootstrap'));
        expect(bootstrap).toBeDefined();
        expect(bootstrap!.args).toContain(getPlistPath(paths.homeDir));
      } finally {
        cleanup();
      }
    });

    it('reports an error when bootstrap exits non-zero', async () => {
      setPlatform('darwin');
      const { spawn } = makeFakeSpawn({
        exitCodes: (c) => (c.args.includes('bootstrap') ? 5 : 0),
      });
      const { paths, cleanup } = makeTempPaths();
      try {
        const result = await installLaunchAgent({ paths, fs, spawn });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/bootstrap/);
      } finally {
        cleanup();
      }
    });

    it('degrades gracefully when launchctl is missing', async () => {
      setPlatform('darwin');
      const { spawn } = makeFakeSpawn({ enoent: () => true });
      const { paths, cleanup } = makeTempPaths();
      try {
        const result = await installLaunchAgent({ paths, fs, spawn });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.done).toBe(false);
          expect(result.message).toMatch(/launchctl bootstrap/);
        }
        // Plist is still written so the user can load it by hand.
        expect(existsSync(getPlistPath(paths.homeDir))).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('is idempotent when the plist is unchanged and already loaded', async () => {
      setPlatform('darwin');
      // bootout→3, bootstrap→0, print→0 (loaded).
      const { spawn } = makeFakeSpawn({
        exitCodes: (c) => (c.args.includes('bootout') ? 3 : 0),
      });
      const { paths, cleanup } = makeTempPaths();
      try {
        await installLaunchAgent({ paths, fs, spawn });
        const second = await installLaunchAgent({ paths, fs, spawn });
        expect(second.ok).toBe(true);
        if (second.ok) {
          expect(second.done).toBe(false);
          expect(second.message).toMatch(/already loaded/);
        }
      } finally {
        cleanup();
      }
    });
  });

  describe('uninstallLaunchAgent', () => {
    it('boots out and removes the plist', async () => {
      setPlatform('darwin');
      const { spawn, calls } = makeFakeSpawn({
        exitCodes: (c) => (c.args.includes('bootout') ? 3 : 0),
      });
      const { paths, cleanup } = makeTempPaths();
      try {
        await installLaunchAgent({ paths, fs, spawn });
        const result = await uninstallLaunchAgent({ paths, fs, spawn });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.done).toBe(true);
        expect(existsSync(getPlistPath(paths.homeDir))).toBe(false);
        expect(calls.some((c) => c.args.includes('bootout'))).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('is a no-op when no plist is present', async () => {
      setPlatform('darwin');
      const { spawn, calls } = makeFakeSpawn();
      const { paths, cleanup } = makeTempPaths();
      try {
        const result = await uninstallLaunchAgent({ paths, fs, spawn });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.done).toBe(false);
        expect(calls).toHaveLength(0);
      } finally {
        cleanup();
      }
    });
  });

  describe('isAgentLoaded', () => {
    it('returns true when launchctl print exits 0', async () => {
      setPlatform('darwin');
      const { spawn } = makeFakeSpawn({ exitCodes: () => 0 });
      expect(await isAgentLoaded({ spawn })).toBe(true);
    });

    it('returns false when launchctl print exits non-zero', async () => {
      setPlatform('darwin');
      const { spawn } = makeFakeSpawn({ exitCodes: () => 1 });
      expect(await isAgentLoaded({ spawn })).toBe(false);
    });

    it('returns false on non-macOS without spawning', async () => {
      setPlatform('linux');
      const { spawn, calls } = makeFakeSpawn();
      expect(await isAgentLoaded({ spawn })).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });
});
