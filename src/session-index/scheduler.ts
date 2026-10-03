import type { RefreshSummary } from './refresh.js';

/**
 * Collapses a burst of refresh requests into a bounded number of runs, without
 * ever running two concurrently.
 *
 * Full passes come from the startup trigger and the backstop poll; delta passes
 * come from readers through `runNow` (TP-787). Running two at once would have
 * two writers fighting over the same SQLite file. So: at most one run in
 * flight, and at most one more full pass queued behind it.
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

/** A full pass walks the corpus; a delta pass indexes only what the watcher reported. */
export type PassKind = 'full' | 'delta';

/** Whether an on-demand refresh finished inside the caller's budget. */
export type Freshness = 'fresh' | 'stale';

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

/** Resolves `'fresh'` if `pass` succeeds within `budgetMs`, else `'stale'` at the budget. */
async function withinBudget(pass: Promise<boolean>, budgetMs: number): Promise<Freshness> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), budgetMs);
    timer.unref?.();
  });
  const ok = await Promise.race([pass, expired]);
  clearTimeout(timer);
  return ok ? 'fresh' : 'stale';
}

/** Lets a pass tell the scheduler its index writes are committed before it finishes. */
export type PassRun = (kind: PassKind, onIndexed: () => void) => Promise<RefreshSummary>;

interface Execution {
  /** Resolves true when the pass succeeded. */
  done: Promise<boolean>;
  /** Resolves true once readers can read the pass's writes; false if it failed first. */
  indexed: Promise<boolean>;
}

export class RefreshScheduler {
  private running = false;
  private pending = false;
  private closed = false;
  private inFlight: Promise<void> | null = null;
  /** The pass executing right now, of either kind. */
  private executing: Execution | null = null;
  private last: RefreshSummary | null = null;
  private lastError: string | null = null;
  private consecutiveErrors = 0;
  private lockSkips = 0;
  private held = false;
  private lastStartedAt: number | null = null;
  private lastEndedAt: number | null = null;
  private cancelSleep: () => void = () => {};
  /** Started by a failed full pass; the drain loop waits it out before the next. */
  private backoff: Promise<void> | null = null;

  constructor(
    private readonly run: PassRun,
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
   * Refresh before a read. Waits up to `budgetMs` for the pass already running
   * to index, or starts a delta pass at once, ignoring the min-interval window.
   * The pass's later work, such as episodes, runs on after the reader returns
   * (TP-873). Never rejects: a pass that fails, or outlasts the budget, reads as `'stale'`.
   */
  runNow(budgetMs: number): Promise<Freshness> {
    if (this.closed || this.held) return Promise.resolve('stale');
    return withinBudget((this.executing ?? this.execute('delta')).indexed, budgetMs);
  }

  /** Run one pass of `kind` and track it, so the other kind waits instead of overlapping it. */
  private execute(kind: PassKind): Execution {
    let markIndexed = (): void => {};
    const marked = new Promise<true>((resolve) => (markIndexed = () => resolve(true)));
    const done = this.attempt(kind, markIndexed).finally(() => {
      if (this.executing === execution) this.executing = null;
    });
    const execution: Execution = { done, indexed: Promise.race([marked, done]) };
    this.executing = execution;
    return execution;
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
      while (this.executing) await this.executing.done;
      if (this.closed) return;
      this.lastStartedAt = this.now();
      await this.execute('full').done;
      await this.backoff;
      this.backoff = null;
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

  /**
   * One pass; never rejects. A failed full pass starts `backoff` at once, for
   * the drain loop to wait out, while `executing` already reads it as done. A
   * delta pass that meets the lock held elsewhere just reports failure: the
   * reader it serves must not wait, and the poll retries.
   */
  private async attempt(kind: PassKind, onIndexed: () => void): Promise<boolean> {
    try {
      this.last = await this.run(kind, onIndexed);
      this.lastError = null;
      this.consecutiveErrors = 0;
      this.lockSkips = 0;
      return true;
    } catch (err) {
      if (isLockContention(err)) {
        if (kind === 'delta') return false;
        this.lockSkips += 1;
        this.pending = true;
        this.options.onLockSkip?.(this.lockSkips);
        this.backoff = this.pause(this.backoffMs(this.lockSkips));
        return false;
      }
      this.consecutiveErrors += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.options.onError?.(err);
      // Back off so a permanently broken corpus cannot spin the daemon.
      if (kind === 'full') this.backoff = this.pause(this.backoffMs(this.consecutiveErrors));
      return false;
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
      running: this.running || this.executing !== null,
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
    await Promise.all([this.inFlight, this.executing?.done]);
  }
}
