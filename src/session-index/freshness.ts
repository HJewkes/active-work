/**
 * On-demand refresh before an index read (TP-787).
 *
 * The daemon no longer indexes on every transcript write, so a reader asks for
 * the index to catch up first. The daemon installs its scheduler's `runNow`;
 * in the CLI nothing installs, so `ensure` resolves at once and the reader sees
 * whatever the last pass wrote.
 */
import type { Freshness } from './scheduler.js';

export type { Freshness } from './scheduler.js';

export type EnsureFresh = (budgetMs: number) => Promise<Freshness>;

/** `context related` sits on the spawn path, so it waits least. */
export const RELATED_FRESH_BUDGET_MS = 800;
/** Bootstrap and liveness are interactive reads that can afford a little more. */
export const READ_FRESH_BUDGET_MS = 1_500;

export interface IndexFreshness {
  /** Make `refresh` the hook; returns a function that uninstalls it. */
  install(refresh: EnsureFresh): () => void;
  /** Refresh within `budgetMs`; never rejects, a failed hook reads as `'stale'`. */
  ensure(budgetMs: number): Promise<Freshness>;
}

const alreadyFresh: EnsureFresh = () => Promise.resolve('fresh');

export function createIndexFreshness(): IndexFreshness {
  let refresh = alreadyFresh;
  return {
    install(next) {
      refresh = next;
      return () => {
        if (refresh === next) refresh = alreadyFresh;
      };
    },
    ensure(budgetMs) {
      return refresh(budgetMs).catch((): Freshness => 'stale');
    },
  };
}

/** The process's one hook: the daemon's watcher installs it, readers call `ensure`. */
export const indexFreshness = createIndexFreshness();
