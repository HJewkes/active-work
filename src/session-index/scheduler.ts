import type { RefreshSummary } from './refresh.js';

/**
 * Collapses a burst of change notifications into a bounded number of refresh
 * runs, without ever running two concurrently.
 *
 * The daemon's file watcher fires on every write under the transcripts root —
 * which, during an active session, is continuous. Queueing one run per event
 * would put the indexer permanently behind; running them concurrently would
 * have two writers fighting over the same SQLite file. So: at most one run in
 * flight, and at most one more queued behind it.
 */

export interface SchedulerStatus {
  running: boolean;
  pending: boolean;
  last: RefreshSummary | null;
  lastError: string | null;
  consecutiveErrors: number;
  /** Rounds skipped because another process held the refresh lock. */
  lockSkips: number;
}

export interface SchedulerOptions {
  onError?: (err: unknown) => void;
  /** Called instead of `onError` when the refresh lock stayed held; the round retries with backoff. */
  onLockSkip?: (skips: number) => void;
  /** Least time between the starts of two runs; a burst inside it collapses to one trailing run. */
  minIntervalMs?: number;
  /** Least idle time after a pass ends before the next starts; defaults to `minIntervalMs`. */
  minIdleMs?: number;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Checked before each pass; while it holds, the pass stays pending and the gate is asked again. */
  gate?: () => Promise<GateDecision>;
  /** How long to wait between gate checks while held; defaults to 60 s. */
  gateRecheckMs?: number;
  /** Called only when the gate flips between held and open, never on a recheck. */
  onHoldChange?: (held: boolean, reason?: string) => void;
}

export interface GateDecision {
  hold: boolean;
  reason?: string;
}

const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
export const DEFAULT_MIN_INTERVAL_MS = 15_000;
export const DEFAULT_GATE_RECHECK_MS = 60_000;

/** proper-lockfile gives up with ELOCKED once its retries run out: someone else is mid-pass. */
export function isLockContention(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ELOCKED';
}

/** A timer that `cancel` ends early, so `close()` never waits out a backoff. */
function cancellableSleep(ms: number): { done: Promise<void>; cancel: () => void } {
  let cancel = (): void => {};
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    cancel = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { done, cancel };
}

export class RefreshScheduler {
  private running = false;
  private pending = false;
  private closed = false;
  private inFlight: Promise<void> | null = null;
  private last: RefreshSummary | null = null;
  private lastError: string | null = null;
  private consecutiveErrors = 0;
  private lockSkips = 0;
  private held = false;
  private lastStartedAt: number | null = null;
  private lastEndedAt: number | null = null;
  private cancelSleep: () => void = () => {};

  constructor(
    private readonly run: () => Promise<RefreshSummary>,
    private readonly options: SchedulerOptions = {},
  ) {}

  /**
   * Ask for a refresh. Fire-and-forget and never rejects — a watcher callback
   * has nowhere to put a rejection, and an unhandled one would take the daemon
   * down.
   */
  trigger(): void {
    if (this.closed) return;
    this.pending = true;
    if (this.running) return;
    this.running = true;
    this.inFlight = this.drain().finally(() => {
      this.running = false;
      this.inFlight = null;
    });
  }

  /**
   * `pending` is a boolean, not a counter: N triggers arriving mid-run must
   * collapse to exactly one extra run, not N. It is cleared at the *start* of
   * each iteration — clearing it after the run would swallow a trigger that
   * landed while that run was in progress, losing the change that caused it.
   */
  private async drain(): Promise<void> {
    do {
      const wait = this.windowWaitMs();
      if (wait > 0) await this.pause(wait);
      if (this.closed) return;
      if (this.options.gate && !(await this.waitForGate(this.options.gate))) return;
      this.pending = false;
      this.lastStartedAt = this.now();
      await this.runOnce();
      this.lastEndedAt = this.now();
    } while (this.pending && !this.closed);
  }

  /** Resolves true once the gate is open, false if `close()` came first. `pending` stays set meanwhile. */
  private async waitForGate(gate: () => Promise<GateDecision>): Promise<boolean> {
    const { onHoldChange } = this.options;
    for (;;) {
      const decision = await gate().catch((): GateDecision => ({ hold: false }));
      if (this.held !== decision.hold) {
        this.held = decision.hold;
        onHoldChange?.(decision.hold, decision.reason);
      }
      if (!decision.hold) return true;
      await this.pause(this.options.gateRecheckMs ?? DEFAULT_GATE_RECHECK_MS);
      if (this.closed) return false;
    }
  }

  /** Sleep that `close()` cuts short; an injected `sleep` is raced against the close instead. */
  private async pause(ms: number): Promise<void> {
    if (this.closed) return;
    const timer = cancellableSleep(ms);
    this.cancelSleep = timer.cancel;
    await (this.options.sleep ? Promise.race([this.options.sleep(ms), timer.done]) : timer.done);
    timer.cancel();
  }

  /**
   * The later of `minIntervalMs` after the last start and `minIdleMs` after the
   * last end: a pass longer than the interval must still leave the loop idle
   * before the next one, or a cold index keeps a core pinned. Triggers meanwhile coalesce.
   */
  private windowWaitMs(): number {
    if (this.lastStartedAt === null || this.lastEndedAt === null) return 0;
    const fromStart = this.lastStartedAt + this.minInterval() - this.now();
    const fromEnd = this.lastEndedAt + this.minIdle() - this.now();
    return Math.max(fromStart, fromEnd);
  }

  private async runOnce(): Promise<void> {
    try {
      this.last = await this.run();
      this.lastError = null;
      this.consecutiveErrors = 0;
      this.lockSkips = 0;
    } catch (err) {
      if (isLockContention(err)) {
        this.lockSkips += 1;
        this.pending = true;
        this.options.onLockSkip?.(this.lockSkips);
        await this.pause(this.backoffMs(this.lockSkips));
        return;
      }
      this.consecutiveErrors += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.options.onError?.(err);
      // Back off so a permanently broken corpus cannot spin the daemon.
      await this.pause(this.backoffMs(this.consecutiveErrors));
    }
  }

  private minIdle(): number {
    return this.options.minIdleMs ?? this.minInterval();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private minInterval(): number {
    return this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  }

  private backoffMs(attempt: number): number {
    const base = this.options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    const max = this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    return Math.min(base * 2 ** (attempt - 1), max);
  }

  status(): SchedulerStatus {
    return {
      running: this.running,
      pending: this.pending,
      last: this.last,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
      lockSkips: this.lockSkips,
    };
  }

  /** Drop anything queued and wait for the in-flight run to commit. */
  async close(): Promise<void> {
    this.closed = true;
    this.pending = false;
    this.cancelSleep();
    await this.inFlight;
  }
}
