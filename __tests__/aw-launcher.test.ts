import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildChannelArgs,
  buildClaudeArgs,
  parseLauncherFlags,
} from '../src/launcher-args.js';
import { buildLauncherEnv, withLauncherLease } from '../src/launcher-lease.js';
import { withTempActiveRoot } from './setup/test-helpers.js';

describe('buildChannelArgs', () => {
  it('returns no args when channels is undefined or empty', () => {
    expect(buildChannelArgs(undefined)).toEqual([]);
    expect(buildChannelArgs([])).toEqual([]);
  });

  it('normalizes a bare server name to server:<name>', () => {
    expect(buildChannelArgs(['voltras'])).toEqual([
      '--dangerously-load-development-channels',
      'server:voltras',
    ]);
  });

  it('passes explicit server:/plugin: targets through untouched', () => {
    expect(buildChannelArgs(['server:voltras', 'plugin:foo@market'])).toEqual([
      '--channels',
      'plugin:foo@market',
      '--dangerously-load-development-channels',
      'server:voltras',
    ]);
  });

  it('collects all targets under a single variadic flag', () => {
    const args = buildChannelArgs(['a', 'b', 'c']);
    const flags = args.filter(
      (a) => a === '--dangerously-load-development-channels',
    );
    expect(flags).toHaveLength(1);
  });

  // Regression: plugin targets used to be emitted under the dev flag, which
  // re-triggers the development-channels dialog that packaging a channel as an
  // allowlisted plugin exists to avoid. Only `--channels` takes the allowlist
  // path in Claude Code's channel gate.
  it('routes plugin targets under --channels, never the dev flag', () => {
    const args = buildChannelArgs(['plugin:voltras-channel@voltras-local']);
    expect(args).toEqual([
      '--channels',
      'plugin:voltras-channel@voltras-local',
    ]);
    expect(args).not.toContain('--dangerously-load-development-channels');
  });

  it('omits the dev flag entirely when every target is a plugin', () => {
    const args = buildChannelArgs(['plugin:a@m', 'plugin:b@m']);
    expect(args).toEqual(['--channels', 'plugin:a@m', 'plugin:b@m']);
  });

  it('omits --channels entirely when no target is a plugin', () => {
    const args = buildChannelArgs(['voltras', 'server:other']);
    expect(args).not.toContain('--channels');
    expect(args).toEqual([
      '--dangerously-load-development-channels',
      'server:voltras',
      'server:other',
    ]);
  });

  it('groups each kind under one flag when the kinds are interleaved', () => {
    const args = buildChannelArgs([
      'plugin:a@m',
      'bare',
      'plugin:b@m',
      'server:s',
    ]);
    expect(args.filter((a) => a === '--channels')).toHaveLength(1);
    expect(
      args.filter((a) => a === '--dangerously-load-development-channels'),
    ).toHaveLength(1);
    expect(args).toEqual([
      '--channels',
      'plugin:a@m',
      'plugin:b@m',
      '--dangerously-load-development-channels',
      'server:bare',
      'server:s',
    ]);
  });
});

describe('buildClaudeArgs', () => {
  // Regression: --dangerously-load-development-channels is variadic, so without
  // a `--` terminator the flag swallows the prompt as a channel target and the
  // real prompt collides. The prompt MUST come after `--`.
  it('places the prompt after a `--` terminator so channels cannot swallow it', () => {
    const args = buildClaudeArgs('the bootstrap prompt', ['voltras']);
    expect(args).toEqual([
      '--dangerously-load-development-channels',
      'server:voltras',
      '--',
      'the bootstrap prompt',
    ]);
    // The prompt is the final arg and is preceded immediately by `--`.
    expect(args.at(-1)).toBe('the bootstrap prompt');
    expect(args.at(-2)).toBe('--');
  });

  // Two variadic channel flags can now be present at once, so the `--`
  // terminator has to survive whichever one lands last in the argv.
  it('keeps the prompt behind `--` with both channel kinds present', () => {
    const args = buildClaudeArgs('the bootstrap prompt', [
      'plugin:foo@market',
      'voltras',
    ]);
    expect(args).toEqual([
      '--channels',
      'plugin:foo@market',
      '--dangerously-load-development-channels',
      'server:voltras',
      '--',
      'the bootstrap prompt',
    ]);
    expect(args.at(-2)).toBe('--');
  });

  it('still terminates with `--` when there are no channels', () => {
    expect(buildClaudeArgs('hello')).toEqual(['--', 'hello']);
  });

  it('keeps a prompt that starts with a dash from being parsed as a flag', () => {
    const args = buildClaudeArgs('-- not a flag', ['voltras']);
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('-- not a flag');
  });
});

describe('parseLauncherFlags', () => {
  it('parses a bare slug with no flags', () => {
    expect(parseLauncherFlags(['voltras-workspace'])).toEqual({
      pick: false,
      adhoc: false,
      positional: ['voltras-workspace'],
      usageError: false,
    });
  });

  it('accepts --adhoc (canonical spelling)', () => {
    const f = parseLauncherFlags(['voltras-workspace', '--adhoc']);
    expect(f.adhoc).toBe(true);
    expect(f.positional).toEqual(['voltras-workspace']);
    expect(f.usageError).toBe(false);
  });

  // Regression: `aw <slug> --ad-hoc` used to fall through to the unknown-flag
  // guard and error with "aw only launches a Claude session for an initiative".
  it('accepts --ad-hoc as an alias for --adhoc', () => {
    const f = parseLauncherFlags(['voltras-workspace', '--ad-hoc']);
    expect(f.adhoc).toBe(true);
    expect(f.positional).toEqual(['voltras-workspace']);
    expect(f.usageError).toBe(false);
  });

  it('combines --pick with an adhoc alias', () => {
    const f = parseLauncherFlags(['--pick', '--ad-hoc']);
    expect(f).toEqual({
      pick: true,
      adhoc: true,
      positional: [],
      usageError: false,
    });
  });

  it('still flags a genuinely unknown flag as a usage error', () => {
    expect(parseLauncherFlags(['voltras', '--bogus']).usageError).toBe(true);
  });

  it('still flags more than one slug as a usage error', () => {
    expect(parseLauncherFlags(['a', 'b']).usageError).toBe(true);
  });
});

describe('buildLauncherEnv', () => {
  it('adds the lease id so the spawned session can exclude itself', () => {
    const env = buildLauncherEnv({ PATH: '/usr/bin' }, 'abc123');
    expect(env.AW_LEASE_ID).toBe('abc123');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('copies the base env rather than mutating it', () => {
    const base = { PATH: '/usr/bin' };
    const env = buildLauncherEnv(base, 'abc123');
    expect(base).not.toHaveProperty('AW_LEASE_ID');
    expect(env).not.toBe(base);
  });

  it('omits the var entirely when no lease was acquired', () => {
    expect(buildLauncherEnv({ PATH: '/usr/bin' }, undefined)).not.toHaveProperty(
      'AW_LEASE_ID',
    );
  });
});

describe('withLauncherLease', () => {
  const SLUG = 'sample-initiative';

  async function leaseFiles(activeRoot: string): Promise<string[]> {
    try {
      return await fs.readdir(path.join(activeRoot, '.sessions', SLUG));
    } catch {
      return [];
    }
  }

  it('holds a launcher lease for the life of the child and releases it after', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      let duringRun: string[] = [];
      let seenLeaseId: string | undefined;

      // Stands in for `spawnClaude`: the lease must exist while the child runs.
      const code = await withLauncherLease(
        { activeRoot, slug: SLUG, cwd: '/tmp/checkout', pid: process.pid },
        async (leaseId) => {
          seenLeaseId = leaseId;
          duringRun = await leaseFiles(activeRoot);
          return 0;
        },
      );

      expect(code).toBe(0);
      expect(seenLeaseId).toBeTruthy();
      expect(duringRun).toEqual([`${seenLeaseId}.json`]);
      expect(await leaseFiles(activeRoot)).toEqual([]);
    });
  });

  it('records the launcher mode and the launcher pid', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await withLauncherLease(
        { activeRoot, slug: SLUG, cwd: '/tmp/checkout', pid: 4321 },
        async (leaseId) => {
          const raw = await fs.readFile(
            path.join(activeRoot, '.sessions', SLUG, `${leaseId}.json`),
            'utf8',
          );
          expect(JSON.parse(raw)).toMatchObject({
            mode: 'launcher',
            pid: 4321,
            cwd: '/tmp/checkout',
          });
          return 0;
        },
      );
    });
  });

  it('releases the lease even when the run throws', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await expect(
        withLauncherLease({ activeRoot, slug: SLUG, cwd: '/tmp/c' }, async () => {
          throw new Error('claude blew up');
        }),
      ).rejects.toThrow('claude blew up');
      expect(await leaseFiles(activeRoot)).toEqual([]);
    });
  });

  // The exit/signal handlers are the last-resort cleanup for a Ctrl-C that
  // kills `aw` before any promise gets a turn. They must not outlive the run.
  it('installs exit and signal handlers and removes them afterwards', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const before = {
        exit: process.listenerCount('exit'),
        sigint: process.listenerCount('SIGINT'),
        sigterm: process.listenerCount('SIGTERM'),
      };
      await withLauncherLease({ activeRoot, slug: SLUG, cwd: '/tmp/c' }, async () => {
        expect(process.listenerCount('exit')).toBe(before.exit + 1);
        expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
        expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
        return 0;
      });
      expect(process.listenerCount('exit')).toBe(before.exit);
      expect(process.listenerCount('SIGINT')).toBe(before.sigint);
      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    });
  });

  // Fail open: refusing to launch a session because a lease could not be
  // written would trade a whole session for an advisory warning.
  it('runs without a lease id when the lease cannot be written', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      // A file where the lease directory needs to go — mkdir fails with ENOTDIR.
      const blocked = path.join(activeRoot, 'blocked-root');
      await fs.writeFile(blocked, 'not a directory');

      let seen: string | undefined = 'unset';
      const code = await withLauncherLease(
        { activeRoot: blocked, slug: SLUG, cwd: '/tmp/c' },
        async (leaseId) => {
          seen = leaseId;
          return 7;
        },
      );
      expect(code).toBe(7);
      expect(seen).toBeUndefined();
    });
  });
});
