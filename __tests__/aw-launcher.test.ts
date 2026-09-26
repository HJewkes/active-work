import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildChannelArgs,
  buildClaudeArgs,
  mergeChannels,
  parseLauncherFlags,
} from '../src/launcher-args.js';
import { buildLauncherEnv, withLauncherLease } from '../src/launcher-lease.js';
import { defaultTitleFromSlug, isInvalidSlugMiss, shouldOfferInit } from '../src/launcher-init.js';
import { NotFoundError, ValidationError } from '../src/errors.js';
import { withTempActiveRoot } from './setup/test-helpers.js';

const DEFAULTS = ['plugin:agent-chat@agent-chat-local'];

describe('mergeChannels', () => {
  it('returns the given defaults when a brief declares no channels', () => {
    expect(mergeChannels(DEFAULTS, undefined)).toEqual(DEFAULTS);
    expect(mergeChannels(DEFAULTS, [])).toEqual(DEFAULTS);
  });

  it('returns brief channels unchanged when no defaults are configured', () => {
    expect(mergeChannels(undefined, ['plugin:voltras-channel@voltras-local'])).toEqual([
      'plugin:voltras-channel@voltras-local',
    ]);
    expect(mergeChannels([], ['plugin:voltras-channel@voltras-local'])).toEqual([
      'plugin:voltras-channel@voltras-local',
    ]);
  });

  it('appends brief-declared channels after the defaults', () => {
    expect(mergeChannels(DEFAULTS, ['plugin:voltras-channel@voltras-local'])).toEqual([
      ...DEFAULTS,
      'plugin:voltras-channel@voltras-local',
    ]);
  });

  // Regression: a brief that redundantly lists a default (e.g. copied from
  // another initiative) must not double it up on the claude command line.
  it('de-duplicates a brief channel that repeats a default', () => {
    expect(mergeChannels(DEFAULTS, DEFAULTS)).toEqual(DEFAULTS);
  });
});

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
    const flags = args.filter((a) => a === '--dangerously-load-development-channels');
    expect(flags).toHaveLength(1);
  });

  // Regression: plugin targets used to be emitted under the dev flag, which
  // re-triggers the development-channels dialog that packaging a channel as an
  // allowlisted plugin exists to avoid. Only `--channels` takes the allowlist
  // path in Claude Code's channel gate.
  it('routes plugin targets under --channels, never the dev flag', () => {
    const args = buildChannelArgs(['plugin:voltras-channel@voltras-local']);
    expect(args).toEqual(['--channels', 'plugin:voltras-channel@voltras-local']);
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
    const args = buildChannelArgs(['plugin:a@m', 'bare', 'plugin:b@m', 'server:s']);
    expect(args.filter((a) => a === '--channels')).toHaveLength(1);
    expect(args.filter((a) => a === '--dangerously-load-development-channels')).toHaveLength(1);
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
      '--remote-control',
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
    const args = buildClaudeArgs('the bootstrap prompt', ['plugin:foo@market', 'voltras']);
    expect(args).toEqual([
      '--channels',
      'plugin:foo@market',
      '--dangerously-load-development-channels',
      'server:voltras',
      '--remote-control',
      '--',
      'the bootstrap prompt',
    ]);
    expect(args.at(-2)).toBe('--');
  });

  it('still terminates with `--` when there are no channels', () => {
    expect(buildClaudeArgs('hello')).toEqual(['--remote-control', '--', 'hello']);
  });

  it('keeps a prompt that starts with a dash from being parsed as a flag', () => {
    const args = buildClaudeArgs('-- not a flag', ['voltras']);
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('-- not a flag');
  });

  // `--remote-control [name]` takes an optional name: anywhere but directly
  // before `--` it would swallow a channel target or the prompt as that name.
  it('enables Remote Control by default, directly before the `--` terminator', () => {
    const args = buildClaudeArgs('the bootstrap prompt', ['voltras']);
    expect(args.slice(-3)).toEqual(['--remote-control', '--', 'the bootstrap prompt']);
  });

  it('omits --remote-control when the caller opts out', () => {
    const args = buildClaudeArgs('the bootstrap prompt', ['voltras'], { remoteControl: false });
    expect(args).toEqual([
      '--dangerously-load-development-channels',
      'server:voltras',
      '--',
      'the bootstrap prompt',
    ]);
  });
});

describe('parseLauncherFlags', () => {
  it('parses a bare slug with no flags', () => {
    expect(parseLauncherFlags(['voltras-workspace'])).toEqual({
      pick: false,
      adhoc: false,
      remoteControl: true,
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
      remoteControl: true,
      positional: [],
      usageError: false,
    });
  });

  it.each(['--no-rc', '--no-remote-control'])(
    'accepts %s as a Remote Control opt-out, not a usage error',
    (flag) => {
      const f = parseLauncherFlags(['voltras-workspace', '--adhoc', flag]);
      expect(f.remoteControl).toBe(false);
      expect(f.adhoc).toBe(true);
      expect(f.positional).toEqual(['voltras-workspace']);
      expect(f.usageError).toBe(false);
    },
  );

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
    expect(buildLauncherEnv({ PATH: '/usr/bin' }, undefined)).not.toHaveProperty('AW_LEASE_ID');
  });

  it('exports the facet alias a session opened through', () => {
    const env = buildLauncherEnv({ PATH: '/usr/bin' }, 'abc123', 'active-work');
    expect(env.AW_FACET).toBe('active-work');
    expect(env.AW_LEASE_ID).toBe('abc123');
  });

  it('omits the facet var for a plain slug', () => {
    expect(buildLauncherEnv({ PATH: '/usr/bin' }, 'abc123')).not.toHaveProperty('AW_FACET');
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
  //
  // SIGHUP is in the set alongside SIGINT/SIGTERM: it is what a closed
  // terminal/iTerm pane sends the foreground process group, and without a
  // listener the default disposition kills `aw` before 'exit' can fire,
  // orphaning the lease (see the SIGHUP comment on CLEANUP_SIGNALS).
  it('installs exit and signal handlers and removes them afterwards', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const before = {
        exit: process.listenerCount('exit'),
        sigint: process.listenerCount('SIGINT'),
        sigterm: process.listenerCount('SIGTERM'),
        sighup: process.listenerCount('SIGHUP'),
      };
      await withLauncherLease({ activeRoot, slug: SLUG, cwd: '/tmp/c' }, async () => {
        expect(process.listenerCount('exit')).toBe(before.exit + 1);
        expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
        expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
        expect(process.listenerCount('SIGHUP')).toBe(before.sighup + 1);
        return 0;
      });
      expect(process.listenerCount('exit')).toBe(before.exit);
      expect(process.listenerCount('SIGINT')).toBe(before.sigint);
      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
      expect(process.listenerCount('SIGHUP')).toBe(before.sighup);
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

describe('shouldOfferInit (TP-356)', () => {
  const noMatch = new NotFoundError("No initiative matches 'new-thing'. Known: a, b", {
    reason: 'no_match',
  });

  it('offers when nothing matched, a TTY is attached and the slug is valid', () => {
    expect(shouldOfferInit({ error: noMatch, slug: 'new-thing', isTTY: true })).toBe(true);
  });

  it('does not offer for an ambiguous prefix', () => {
    const ambiguous = new NotFoundError("Ambiguous slug 'a'. Candidates: ab, ac");
    expect(shouldOfferInit({ error: ambiguous, slug: 'ab', isTTY: true })).toBe(false);
  });

  it('does not offer without a TTY', () => {
    expect(shouldOfferInit({ error: noMatch, slug: 'new-thing', isTTY: false })).toBe(false);
  });

  it('does not offer for a slug that is not kebab-case', () => {
    expect(shouldOfferInit({ error: noMatch, slug: 'New_Thing', isTTY: true })).toBe(false);
    expect(isInvalidSlugMiss({ error: noMatch, slug: 'New_Thing' })).toBe(true);
    expect(isInvalidSlugMiss({ error: noMatch, slug: 'new-thing' })).toBe(false);
  });

  it('does not offer for errors other than a not-found miss', () => {
    const invalid = new ValidationError('bad brief');
    expect(shouldOfferInit({ error: invalid, slug: 'new-thing', isTTY: true })).toBe(false);
    expect(shouldOfferInit({ error: new Error('boom'), slug: 'new-thing', isTTY: true })).toBe(
      false,
    );
  });
});

describe('defaultTitleFromSlug (TP-356)', () => {
  it('title-cases each dash-separated word', () => {
    expect(defaultTitleFromSlug('my-new-thing')).toBe('My New Thing');
  });

  it('keeps digits and single-word slugs intact', () => {
    expect(defaultTitleFromSlug('v2-migration')).toBe('V2 Migration');
    expect(defaultTitleFromSlug('inbox')).toBe('Inbox');
  });
});
