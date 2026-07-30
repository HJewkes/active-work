/**
 * Lease lifecycle for the `aw` launcher.
 *
 * Kept out of `src/aw.ts` because that module calls `main()` on import and so
 * cannot be pulled into a unit test — the same reason `launcher-args.ts` and
 * `registry/cli-options.ts` exist.
 *
 * `aw` spawns `claude` with `stdio: 'inherit'` and awaits its exit, so the
 * launcher's own process lifetime brackets the session exactly. That is what
 * makes a `launcher` lease a fact rather than a guess — and it is also what
 * makes cleanup fiddly: an inherited stdio child shares the foreground process
 * group, so Ctrl-C is delivered to `aw` as well, and `aw` may be gone before
 * any promise-based cleanup gets a turn. Hence three layers:
 *
 *  1. the normal path — `finally`, async unlink after the child exits;
 *  2. signals — release synchronously, then re-raise so the default action
 *     still terminates the process (installing a handler suppresses it);
 *  3. `process.on('exit')` — the last-resort synchronous sweep, which is the
 *     only thing that runs under `process.exit()` from an error path.
 *
 * Every layer tolerates the lease already being gone.
 */
import {
  acquireLease,
  releaseLease,
  releaseLeaseSync,
} from './sessions/lease.js';

/** Env var carrying this session's lease id into the spawned `claude`. */
export const LEASE_ENV_VAR = 'AW_LEASE_ID';

/**
 * The child's environment, with the lease id added.
 *
 * The child is the Claude session this lease describes, so any `open` /
 * `prompt` run *inside* it must exclude this lease rather than report the
 * session as its own sibling.
 */
export function buildLauncherEnv(
  base: NodeJS.ProcessEnv,
  leaseId: string | undefined,
): NodeJS.ProcessEnv {
  if (!leaseId) return { ...base };
  return { ...base, [LEASE_ENV_VAR]: leaseId };
}

const CLEANUP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

export interface LauncherLeaseInput {
  activeRoot: string;
  slug: string;
  cwd: string;
  /** Defaults to this process — the one whose lifetime brackets the session. */
  pid?: number;
}

/**
 * Hold a `launcher` lease for the duration of `run`.
 *
 * A lease that cannot be written is not an error: `run` is invoked with
 * `undefined` and the session proceeds without a lease. The warning it would
 * have produced is advisory, and refusing to launch over it would be absurd.
 */
export async function withLauncherLease<T>(
  input: LauncherLeaseInput,
  run: (leaseId: string | undefined) => Promise<T>,
): Promise<T> {
  const { activeRoot, slug, cwd, pid = process.pid } = input;
  let leaseId: string | undefined;
  try {
    ({ leaseId } = await acquireLease({
      activeRoot,
      slug,
      cwd,
      mode: 'launcher',
      pid,
    }));
  } catch {
    return run(undefined);
  }

  const id = leaseId;
  const onExit = (): void => releaseLeaseSync(activeRoot, slug, id);
  const onSignal = (signal: NodeJS.Signals): void => {
    releaseLeaseSync(activeRoot, slug, id);
    // Restore the default action and re-raise: swallowing the signal here would
    // leave `aw` alive after a Ctrl-C that already killed the session below it.
    process.removeListener(signal, onSignal);
    process.kill(process.pid, signal);
  };

  process.on('exit', onExit);
  for (const signal of CLEANUP_SIGNALS) process.on(signal, onSignal);

  try {
    return await run(id);
  } finally {
    process.removeListener('exit', onExit);
    for (const signal of CLEANUP_SIGNALS) process.removeListener(signal, onSignal);
    await releaseLease(activeRoot, slug, id).catch(() => {});
  }
}
