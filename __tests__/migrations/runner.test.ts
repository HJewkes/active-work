import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../src/errors.js';
import {
  BASE_VERSION,
  CURRENT_VERSION,
  MIGRATIONS,
  chainProblems,
  runMigrations,
  type Migration,
} from '../../src/migrations/index.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

describe('runMigrations', () => {
  it('is a no-op when fromVersion equals CURRENT_VERSION', async () => {
    await withEmptyActiveRoot(async (root) => {
      const result = await runMigrations(root, CURRENT_VERSION);
      expect(result).toEqual({ ran: [] });
    });
  });

  it('throws ConfigError when fromVersion is newer than CURRENT_VERSION', async () => {
    await withEmptyActiveRoot(async (root) => {
      await expect(runMigrations(root, CURRENT_VERSION + 1)).rejects.toBeInstanceOf(ConfigError);
      await expect(runMigrations(root, CURRENT_VERSION + 1)).rejects.toThrow(
        /downgrade not supported/i,
      );
    });
  });

  it('ships a contiguous chain from v1 up to CURRENT_VERSION', () => {
    expect(chainProblems()).toEqual([]);
    expect(MIGRATIONS).toHaveLength(CURRENT_VERSION - BASE_VERSION);
    MIGRATIONS.forEach((m, i) => {
      expect(m.from).toBe(i + 1);
      expect(m.to).toBe(i + 2);
    });
  });

  it('runs every step when started from v1, via the injected registry', async () => {
    await withEmptyActiveRoot(async (root) => {
      const calls: string[] = [];
      const synthetic: Migration[] = MIGRATIONS.map((m) => ({
        from: m.from,
        to: m.to,
        description: `synthetic v${m.from} -> v${m.to}`,
        async run(target) {
          expect(target).toBe(root);
          calls.push(`${m.from}->${m.to}`);
        },
      }));

      const result = await runMigrations(root, 1, synthetic);
      expect(result.ran).toHaveLength(MIGRATIONS.length);
      expect(calls).toEqual(MIGRATIONS.map((m) => `${m.from}->${m.to}`));
    });
  });

  it('chains multiple synthetic migrations in order when target is reachable', async () => {
    // Drive the runner against a synthetic CURRENT_VERSION by providing
    // a chain whose last `to` exceeds today's CURRENT_VERSION. The
    // runner stops at CURRENT_VERSION, so build a chain that lands
    // exactly on it.
    if (CURRENT_VERSION < 1) {
      return; // unreachable in practice
    }

    await withEmptyActiveRoot(async (root) => {
      const calls: string[] = [];
      // Start from a version below CURRENT_VERSION so the chain runs.
      const startFrom = CURRENT_VERSION - 1;
      const synthetic: Migration[] = [
        {
          from: startFrom,
          to: CURRENT_VERSION,
          description: 'synthetic step to current',
          async run() {
            calls.push(`${startFrom}->${CURRENT_VERSION}`);
          },
        },
      ];

      if (startFrom < 1) {
        // CURRENT_VERSION is 1; startFrom would be 0. Use the v0 sentinel.
        const result = await runMigrations(root, 0, synthetic);
        expect(result.ran).toHaveLength(1);
        expect(result.ran[0]?.description).toBe('synthetic step to current');
        expect(calls).toEqual(['0->1']);
        return;
      }

      const result = await runMigrations(root, startFrom, synthetic);
      expect(result.ran).toHaveLength(1);
      expect(calls).toEqual([`${startFrom}->${CURRENT_VERSION}`]);
    });
  });

  it('throws ConfigError listing the gap when no migrator matches', async () => {
    await withEmptyActiveRoot(async (root) => {
      // Empty registry, target > from -> gap.
      await expect(runMigrations(root, 0, [])).rejects.toBeInstanceOf(ConfigError);
      await expect(runMigrations(root, 0, [])).rejects.toThrow(/Gap at v0 -> v1/);
    });
  });

  it('throws when a migrator does not advance the version', async () => {
    await withEmptyActiveRoot(async (root) => {
      const broken: Migration[] = [
        {
          from: 0,
          to: 0,
          description: 'broken self-loop',
          async run() {
            // no-op
          },
        },
      ];
      await expect(runMigrations(root, 0, broken)).rejects.toBeInstanceOf(ConfigError);
      await expect(runMigrations(root, 0, broken)).rejects.toThrow(/does not advance/);
    });
  });
});

/** The shapes a mis-resolved merge of two concurrent migrations produces (TP-35). */
describe('chainProblems', () => {
  const step = (from: number, to: number, description = `v${from} -> v${to}`): Migration => ({
    from,
    to,
    description,
    async run() {
      // no-op
    },
  });

  it('accepts a chain that walks from the base version in single steps', () => {
    expect(chainProblems([step(1, 2), step(2, 3)])).toEqual([]);
  });

  it('reports two migrations claiming the same source version', () => {
    const problems = chainProblems([step(1, 2), step(2, 3, 'worktrees'), step(2, 3, 'open loops')]);
    expect(problems).toContain('v2 has 2 migrations, expected one: worktrees, open loops');
  });

  it('reports a hole in the middle of the chain', () => {
    const problems = chainProblems([step(1, 2), step(3, 4)]);
    expect(problems).toEqual(['no migration from v2; the chain stops short of v4']);
  });

  it('reports a migrator that cannot advance rather than looping on it', () => {
    expect(chainProblems([step(1, 1), step(1, 2)])).toContain(
      'v1 -> v1 does not advance the version (from=1, to=1)',
    );
  });
});
