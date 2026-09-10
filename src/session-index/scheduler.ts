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
}

export interface SchedulerOptions {
  onError?: (err: unknown) => void;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

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
      this.pending = false;
      try {
        this.last = await this.run();
        this.lastError = null;
        this.consecutiveErrors = 0;
      } catch (err) {
        this.consecutiveErrors += 1;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.options.onError?.(err);
        // Back off so a permanently broken corpus cannot spin the daemon.
        await (this.options.sleep ?? realSleep)(this.backoffMs());
      }
    } while (this.pending && !this.closed);
  }

  private backoffMs(): number {
    const base = this.options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    const max = this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    return Math.min(base * 2 ** (this.consecutiveErrors - 1), max);
  }

  status(): SchedulerStatus {
    return {
      running: this.running,
      pending: this.pending,
      last: this.last,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  /** Drop anything queued and wait for the in-flight run to commit. */
  async close(): Promise<void> {
    this.closed = true;
    this.pending = false;
    await this.inFlight;
  }
}
