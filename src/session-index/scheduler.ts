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
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
export const DEFAULT_MIN_INTERVAL_MS = 15_000;

/** proper-lockfile gives up with ELOCKED once its retries run out: someone else is mid-pass. */
export function isLockContention(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ELOCKED';
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref?.());

export class RefreshScheduler {
  private running = false;
  private pending = false;
  private closed = false;
  private inFlight: Promise<void> | null = null;
  private last: RefreshSummary | null = null;
  private lastError: string | null = null;
  private consecutiveErrors = 0;
  private lockSkips = 0;
  private lastStartedAt: number | null = null;

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
      if (wait > 0) await (this.options.sleep ?? realSleep)(wait);
      if (this.closed) return;
      this.pending = false;
      this.lastStartedAt = this.now();
      await this.runOnce();
    } while (this.pending && !this.closed);
  }

  /** How long until `minIntervalMs` has passed since the last start; triggers meanwhile coalesce. */
  private windowWaitMs(): number {
    if (this.lastStartedAt === null) return 0;
    return this.lastStartedAt + this.minInterval() - this.now();
  }

  private async runOnce(): Promise<void> {
    try {
      this.last = await this.run();
      this.lastError = null;
      this.consecutiveErrors = 0;
    } catch (err) {
      if (isLockContention(err)) {
        this.lockSkips += 1;
        this.pending = true;
        this.options.onLockSkip?.(this.lockSkips);
        await (this.options.sleep ?? realSleep)(this.backoffMs(this.lockSkips));
        return;
      }
      this.consecutiveErrors += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.options.onError?.(err);
      // Back off so a permanently broken corpus cannot spin the daemon.
      await (this.options.sleep ?? realSleep)(this.backoffMs(this.consecutiveErrors));
    }
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
    await this.inFlight;
  }
}
