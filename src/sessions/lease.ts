/**
 * Session leases — the t=0 signal that another session may already be live on
 * an initiative.
 *
 * A lease is a small JSON file under `<activeRoot>/.sessions/<slug>/`. The
 * directory is dot-prefixed on purpose: `listInitiativeSlugs` (both copies —
 * `src/commands/_open-helpers.ts` and `src/lint/index.ts`) skips dot entries,
 * so leases are invisible to the picker, the linter, doctor's initiative walk,
 * and the artifact hashing. They sit under the active root rather than the XDG
 * state root because `ACTIVE_ROOT` is the one path tests can redirect, which
 * makes every lease write hermetic by construction.
 *
 * Nothing here may ever throw at a caller: bootstrap runs on every launch, and
 * a warning that can fail the launch is worse than no warning. Every read path
 * degrades to "no siblings".
 *
 * This module imports nothing from `src/commands/` so the commands can depend
 * on it freely.
 */
import { promises as fs, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { LeaseSchema, type Lease, type LeaseMode } from '../schemas/lease.js';
import { isProcessAlive } from '../server/lifecycle.js';

/**
 * How long a `oneshot` lease is assumed to represent a live session.
 *
 * There is no process to probe on that path, so this is the whole liveness
 * rule. 90 minutes is a working-session length: long enough that a sibling
 * started before lunch still warns, short enough that yesterday's `open`
 * doesn't.
 */
export const ONESHOT_TTL_MS = 90 * 60_000;

/**
 * Backstop for `launcher` leases, whose liveness is otherwise a live pid.
 *
 * Pids are recycled. On a machine up for weeks, a lease left behind by a
 * crashed `aw` can end up naming an unrelated live process forever, and the
 * warning then never goes away. 36h is well past any real session.
 */
export const LAUNCHER_MAX_AGE_MS = 36 * 60 * 60_000;

const LEASE_DIR_NAME = '.sessions';

/** `<activeRoot>/.sessions/<slug>` — the lease directory for one initiative. */
export function leaseDir(activeRoot: string, slug: string): string {
  return path.join(activeRoot, LEASE_DIR_NAME, slug);
}

function leasePath(activeRoot: string, slug: string, leaseId: string): string {
  return path.join(leaseDir(activeRoot, slug), `${leaseId}.json`);
}

export interface AcquireLeaseInput {
  activeRoot: string;
  slug: string;
  cwd: string;
  mode: LeaseMode;
  /** Required in practice for `launcher` mode; ignored otherwise. */
  pid?: number;
  label?: string;
  /** Injectable clock for tests. */
  now?: Date;
}

export interface AcquiredLease {
  leaseId: string;
  release: () => Promise<void>;
}

/** Write a lease file and hand back its id plus a release handle. */
export async function acquireLease(input: AcquireLeaseInput): Promise<AcquiredLease> {
  const { activeRoot, slug, cwd, mode, pid, label, now = new Date() } = input;
  const leaseId = randomBytes(8).toString('hex');
  const lease: Lease = LeaseSchema.parse({
    lease_id: leaseId,
    slug,
    cwd,
    mode,
    ...(mode === 'launcher' && pid !== undefined ? { pid } : {}),
    started: now.toISOString(),
    ...(label ? { label } : {}),
  });
  await fs.mkdir(leaseDir(activeRoot, slug), { recursive: true });
  await fs.writeFile(leasePath(activeRoot, slug, leaseId), JSON.stringify(lease, null, 2), 'utf8');
  return {
    leaseId,
    release: () => releaseLease(activeRoot, slug, leaseId),
  };
}

function isIgnorableUnlinkError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT';
}

/** Remove a lease file. A lease that is already gone is a success. */
export async function releaseLease(
  activeRoot: string,
  slug: string,
  leaseId: string,
): Promise<void> {
  try {
    await fs.unlink(leasePath(activeRoot, slug, leaseId));
  } catch (err) {
    if (!isIgnorableUnlinkError(err)) throw err;
  }
}

/**
 * Synchronous release, for `process.on('exit')`.
 *
 * An exit handler cannot await, so the async form is unusable there — and that
 * handler is the only cleanup that still runs when `aw` is torn down by the
 * signal that Ctrl-C sends to the whole foreground process group. Swallows
 * everything: a failed unlink at exit must not change the exit code.
 */
export function releaseLeaseSync(activeRoot: string, slug: string, leaseId: string): void {
  try {
    unlinkSync(leasePath(activeRoot, slug, leaseId));
  } catch {
    // Already gone, or unwritable. Either way the process is leaving.
  }
}

/** A lease that currently looks live. What the bootstrap renderer consumes. */
export interface LiveSibling {
  lease_id: string;
  cwd: string;
  mode: LeaseMode;
  started: string;
  pid?: number;
  label?: string;
}

export interface ReadLiveLeasesInput {
  activeRoot: string;
  slug: string;
  now?: Date;
  /** The caller's own lease, which is never its own sibling. */
  excludeLeaseId?: string;
  /** Injectable liveness probe; defaults to a real `kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
}

export type SiblingProbe = (input: ReadLiveLeasesInput) => Promise<LiveSibling[]>;

function isLive(lease: Lease, now: Date, isAlive: (pid: number) => boolean): boolean {
  const ageMs = now.getTime() - new Date(lease.started).getTime();
  if (lease.mode === 'oneshot') return ageMs < ONESHOT_TTL_MS;
  if (lease.pid === undefined) return false;
  // Age check first: a stale lease whose pid has been recycled would otherwise
  // read as live forever.
  if (ageMs >= LAUNCHER_MAX_AGE_MS) return false;
  return isAlive(lease.pid);
}

function toSibling(lease: Lease): LiveSibling {
  return {
    lease_id: lease.lease_id,
    cwd: lease.cwd,
    mode: lease.mode,
    started: lease.started,
    ...(lease.pid !== undefined ? { pid: lease.pid } : {}),
    ...(lease.label !== undefined ? { label: lease.label } : {}),
  };
}

async function readOneLease(file: string): Promise<Lease | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = LeaseSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function unlinkQuietly(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch {
    // Another session may have swept it already; that is the desired end state.
  }
}

/**
 * Every lease for `slug` that still looks live, sweeping the ones that don't.
 *
 * Opportunistic pruning is what keeps the directory from growing without a
 * background job: whoever next bootstraps the initiative pays for the cleanup.
 * A malformed file is swept the same way — it can never become live, and
 * leaving it there means re-parsing garbage on every launch.
 *
 * Returns `[]` on any unexpected failure. Callers are on the bootstrap path.
 */
export async function readLiveLeases(input: ReadLiveLeasesInput): Promise<LiveSibling[]> {
  const { activeRoot, slug, now = new Date(), excludeLeaseId, isAlive = isProcessAlive } = input;
  try {
    const dir = leaseDir(activeRoot, slug);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const live: LiveSibling[] = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      const lease = await readOneLease(file);
      if (!lease || !isLive(lease, now, isAlive)) {
        await unlinkQuietly(file);
        continue;
      }
      if (lease.lease_id === excludeLeaseId) continue;
      live.push(toSibling(lease));
    }
    return live.sort((a, b) => a.started.localeCompare(b.started));
  } catch {
    return [];
  }
}

export interface LeaseSweepResult {
  live: number;
  pruned: number;
  /** Set when the sweep could not complete (e.g. the directory is unreadable). */
  error?: string;
}

/**
 * Sweep every slug's lease directory, reporting live vs. pruned counts.
 *
 * Used by `doctor`; the pruning is the same opportunistic pass `readLiveLeases`
 * makes, so running it here just moves the cleanup earlier.
 */
export async function sweepAllLeases(
  activeRoot: string,
  options: { now?: Date; isAlive?: (pid: number) => boolean } = {},
): Promise<LeaseSweepResult> {
  const root = path.join(activeRoot, LEASE_DIR_NAME);
  let slugs: string[];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { live: 0, pruned: 0 };
    return { live: 0, pruned: 0, error: (err as Error).message };
  }
  let live = 0;
  let before = 0;
  for (const slug of slugs) {
    try {
      const names = await fs.readdir(leaseDir(activeRoot, slug));
      before += names.filter((n) => n.endsWith('.json')).length;
      live += (await readLiveLeases({ activeRoot, slug, ...options })).length;
    } catch (err) {
      return { live, pruned: Math.max(before - live, 0), error: (err as Error).message };
    }
  }
  return { live, pruned: Math.max(before - live, 0) };
}
