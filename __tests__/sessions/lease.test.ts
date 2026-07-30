import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireLease,
  leaseDir,
  readLiveLeases,
  releaseLease,
  releaseLeaseSync,
  sweepAllLeases,
  LAUNCHER_MAX_AGE_MS,
  ONESHOT_TTL_MS,
} from '../../src/sessions/lease.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';
const NOW = new Date('2026-05-12T16:00:00Z');

/** Never probe a real pid: liveness is always injected in these tests. */
const alive = (): boolean => true;
const dead = (): boolean => false;

function minutesBefore(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

async function writeRawLease(
  activeRoot: string,
  slug: string,
  filename: string,
  contents: string,
): Promise<void> {
  const dir = leaseDir(activeRoot, slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), contents, 'utf8');
}

async function leaseFiles(activeRoot: string, slug: string): Promise<string[]> {
  try {
    return (await fs.readdir(leaseDir(activeRoot, slug))).sort();
  } catch {
    return [];
  }
}

describe('acquireLease / releaseLease', () => {
  it('round-trips a launcher lease with every field persisted', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { leaseId, release } = await acquireLease({
        activeRoot,
        slug: SLUG,
        cwd: '/tmp/checkout',
        mode: 'launcher',
        pid: 4321,
        label: 'reviewer',
        now: NOW,
      });

      const file = path.join(leaseDir(activeRoot, SLUG), `${leaseId}.json`);
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      expect(parsed).toEqual({
        lease_id: leaseId,
        slug: SLUG,
        cwd: '/tmp/checkout',
        mode: 'launcher',
        pid: 4321,
        started: NOW.toISOString(),
        label: 'reviewer',
      });

      await release();
      expect(await leaseFiles(activeRoot, SLUG)).toEqual([]);
    });
  });

  it('writes leases under a dot-prefixed dir so they are not initiatives', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await acquireLease({ activeRoot, slug: SLUG, cwd: '/tmp/a', mode: 'oneshot' });
      const entries = await fs.readdir(activeRoot);
      expect(entries).toContain('.sessions');
      expect(entries.filter((e) => !e.startsWith('.'))).toEqual(['sample-initiative']);
    });
  });

  it('drops the pid on a oneshot lease — there is no process to probe', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { leaseId } = await acquireLease({
        activeRoot,
        slug: SLUG,
        cwd: '/tmp/a',
        mode: 'oneshot',
        pid: 999,
      });
      const file = path.join(leaseDir(activeRoot, SLUG), `${leaseId}.json`);
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      expect(parsed.pid).toBeUndefined();
    });
  });

  it('tolerates releasing a lease that is already gone', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await expect(releaseLease(activeRoot, SLUG, 'nope')).resolves.toBeUndefined();
      expect(() => releaseLeaseSync(activeRoot, SLUG, 'nope')).not.toThrow();
    });
  });

  it('releaseLeaseSync removes the file', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { leaseId } = await acquireLease({
        activeRoot,
        slug: SLUG,
        cwd: '/tmp/a',
        mode: 'launcher',
        pid: 1,
      });
      releaseLeaseSync(activeRoot, SLUG, leaseId);
      expect(await leaseFiles(activeRoot, SLUG)).toEqual([]);
    });
  });
});

describe('readLiveLeases', () => {
  it('returns [] when no lease directory exists', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      expect(await readLiveLeases({ activeRoot, slug: SLUG, now: NOW })).toEqual([]);
    });
  });

  it('keeps a launcher lease whose pid is alive', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { leaseId } = await acquireLease({
        activeRoot,
        slug: SLUG,
        cwd: '/tmp/a',
        mode: 'launcher',
        pid: 4321,
        now: minutesBefore(NOW, 10),
      });
      const live = await readLiveLeases({ activeRoot, slug: SLUG, now: NOW, isAlive: alive });
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ lease_id: leaseId, pid: 4321, mode: 'launcher' });
      expect(await leaseFiles(activeRoot, SLUG)).toHaveLength(1);
    });
  });

  it('filters AND unlinks a launcher lease whose pid is dead', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await acquireLease({
        activeRoot,
        slug: SLUG,
        cwd: '/tmp/a',
        mode: 'launcher',
        pid: 4321,
        now: minutesBefore(NOW, 10),
      });
      expect(
        await readLiveLeases({ activeRoot, slug: SLUG, now: NOW, isAlive: dead }),
      ).toEqual([]);
      expect(await leaseFiles(activeRoot, SLUG)).toEqual([]);
    });
  });

  // Pid reuse: on a long-uptime machine a crashed `aw`'s lease can name an
  // unrelated live process, and the warning would then never clear.
  it('filters a launcher lease past LAUNCHER_MAX_AGE_MS even when the pid is alive', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await acquireLease({
        activeRoot,
        slug: SLUG,
        cwd: '/tmp/a',
        mode: 'launcher',
        pid: 4321,
        now: new Date(NOW.getTime() - LAUNCHER_MAX_AGE_MS - 1000),
      });
      expect(
        await readLiveLeases({ activeRoot, slug: SLUG, now: NOW, isAlive: alive }),
      ).toEqual([]);
      expect(await leaseFiles(activeRoot, SLUG)).toEqual([]);
    });
  });

  it('keeps a oneshot lease inside the TTL and sweeps one outside it', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const fresh = await acquireLease({
        activeRoot,
        slug: SLUG,
        cwd: '/tmp/fresh',
        mode: 'oneshot',
        now: new Date(NOW.getTime() - ONESHOT_TTL_MS + 60_000),
      });
      await acquireLease({
        activeRoot,
        slug: SLUG,
        cwd: '/tmp/stale',
        mode: 'oneshot',
        now: new Date(NOW.getTime() - ONESHOT_TTL_MS - 60_000),
      });

      const live = await readLiveLeases({ activeRoot, slug: SLUG, now: NOW, isAlive: dead });
      expect(live.map((s) => s.cwd)).toEqual(['/tmp/fresh']);
      expect(await leaseFiles(activeRoot, SLUG)).toEqual([`${fresh.leaseId}.json`]);
    });
  });

  it('skips malformed lease files without throwing or losing the good ones', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeRawLease(activeRoot, SLUG, 'aaa-broken.json', '{not json at all');
      await writeRawLease(activeRoot, SLUG, 'bbb-wrong-shape.json', '{"lease_id":"x"}');
      await writeRawLease(activeRoot, SLUG, 'not-a-lease.txt', 'ignored');
      const good = await acquireLease({
        activeRoot,
        slug: SLUG,
        cwd: '/tmp/good',
        mode: 'oneshot',
        now: NOW,
      });

      const live = await readLiveLeases({ activeRoot, slug: SLUG, now: NOW, isAlive: dead });
      expect(live.map((s) => s.cwd)).toEqual(['/tmp/good']);
      // The garbage is swept; the non-JSON file is left strictly alone.
      expect(await leaseFiles(activeRoot, SLUG)).toEqual([
        `${good.leaseId}.json`,
        'not-a-lease.txt',
      ]);
    });
  });

  it('excludes the caller’s own lease', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const mine = await acquireLease({
        activeRoot,
        slug: SLUG,
        cwd: '/tmp/mine',
        mode: 'oneshot',
        now: NOW,
      });
      await acquireLease({
        activeRoot,
        slug: SLUG,
        cwd: '/tmp/theirs',
        mode: 'oneshot',
        now: NOW,
      });

      const live = await readLiveLeases({
        activeRoot,
        slug: SLUG,
        now: NOW,
        excludeLeaseId: mine.leaseId,
        isAlive: dead,
      });
      expect(live.map((s) => s.cwd)).toEqual(['/tmp/theirs']);
      // Excluded, not swept: the lease is still ours to hold.
      expect(await leaseFiles(activeRoot, SLUG)).toHaveLength(2);
    });
  });

  it('does not see leases filed against a different slug', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await acquireLease({
        activeRoot,
        slug: 'other-initiative',
        cwd: '/tmp/other',
        mode: 'oneshot',
        now: NOW,
      });
      expect(await readLiveLeases({ activeRoot, slug: SLUG, now: NOW })).toEqual([]);
    });
  });
});

describe('sweepAllLeases', () => {
  it('reports zero for an active root with no lease directory', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      expect(await sweepAllLeases(activeRoot)).toEqual({ live: 0, pruned: 0 });
    });
  });

  it('counts live and pruned leases across slugs', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await acquireLease({
        activeRoot,
        slug: SLUG,
        cwd: '/tmp/live',
        mode: 'oneshot',
        now: NOW,
      });
      await acquireLease({
        activeRoot,
        slug: 'other-initiative',
        cwd: '/tmp/stale',
        mode: 'oneshot',
        now: new Date(NOW.getTime() - ONESHOT_TTL_MS - 1000),
      });

      expect(await sweepAllLeases(activeRoot, { now: NOW, isAlive: dead })).toEqual({
        live: 1,
        pruned: 1,
      });
    });
  });
});
