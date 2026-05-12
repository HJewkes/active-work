/**
 * Shared types for the discovery pipeline.
 *
 * A `DiscoveryHit` is a single candidate work item surfaced by one of the
 * source scanners (gh PRs, local git, projects root, Claude sessions). The
 * orchestrator augments each hit with cross-reference metadata before
 * emitting the final list.
 */

export interface DiscoveryHit {
  /**
   * Source identifier — e.g. `gh:org/repo`, `branch:<repo>`,
   * `worktree:<repo>`, `stash:<repo>`, `projects`, `claude-session`.
   */
  source: string;
  /**
   * Canonical reference for the hit. Used by triage commands
   * (`fold`/`drop`/`track`) to identify a previously discovered item, and
   * by the orchestrator's substring slug match.
   */
  ref: string;
  /** Human-readable one-line description. */
  detail: string;
  /** Raw provider-specific data preserved for downstream callers. */
  metadata?: Record<string, unknown>;
  /**
   * Populated by the orchestrator when the hit's `ref` (or its
   * `metadata.cwd`) contains a known initiative slug as a substring.
   */
  slug_match?: string;
  /** True when the orchestrator could not match the hit to a known slug. */
  untracked?: boolean;
}

export interface DiscoverySourceError {
  source: string;
  error: string;
}

export interface DiscoveryConfig {
  github_repos?: string[];
  local_repos?: string[];
  projects_root?: string;
}

export interface DiscoveryResult {
  hits: DiscoveryHit[];
  errors: DiscoverySourceError[];
}
