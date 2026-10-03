import type { PrKey, PrResolution, PrResolver, ResolvedPr } from '@titan-design/session-graph';

import { runCommand, type RunCommand } from '../discover/run-command.js';
import type { WorkspaceGraph } from './graph.js';

/**
 * Resolve PR outcomes against GitHub through `gh` (TP-275, design G8).
 *
 * A transcript only sees a merge it ran itself; a merge done in the browser or
 * by another session, a close, and the review history exist only on the forge.
 * `@titan-design/session-graph` takes this as its `PrResolver` and hands it
 * every PR not yet known to be merged. This side narrows that to what can
 * still change, caps it per pass, and turns every `gh` failure into an error
 * line rather than a thrown pass: the PR is left out of the resolution, so its
 * row stays unchecked and the next pass asks again.
 */

export const PR_OUTCOME_BATCH = 50;
const CONCURRENCY = 5;
const DEFAULT_FAIL_BACKOFF_MS = 30 * 60 * 1000;
const GH_FIELDS = 'state,mergedAt,closedAt,reviews,commits';

export interface PrOutcomeOptions {
  /** Process boundary; tests replace it so the real `gh` never runs. */
  run?: RunCommand;
  /** PRs asked about per pass. */
  limit?: number;
  /** Receives one line per PR `gh` could not answer. */
  errors?: string[];
  /** Clock for the failure backoff; tests replace it. */
  now?: () => number;
}

/** Failure times outlive a resolver: each refresh pass builds a new one inside one daemon. */
const failedAt = new Map<string, number>();

export function clearPrFailureBackoff(): void {
  failedAt.clear();
}

function failBackoffMs(): number {
  const parsed = Number(process.env.AW_PR_FAIL_BACKOFF_MS);
  return process.env.AW_PR_FAIL_BACKOFF_MS && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_FAIL_BACKOFF_MS;
}

interface GhReview {
  state?: string;
  submittedAt?: string | null;
}

interface GhCommit {
  committedDate?: string | null;
}

interface GhPr {
  state?: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  reviews?: GhReview[];
  commits?: GhCommit[];
}

interface CheckedRow {
  pr_ref: string;
  state: string | null;
  outcome_checked_at: string | null;
}

/** The round rule lives in session-graph; this side only hands over what the forge said. */
function toResolved(pr: GhPr): ResolvedPr {
  return {
    state: pr.state ?? null,
    mergedAt: pr.mergedAt || null,
    closedAt: pr.closedAt || null,
    reviews: (pr.reviews ?? []).flatMap((r) =>
      r.state && r.submittedAt ? [{ state: r.state, submittedAt: r.submittedAt }] : [],
    ),
    // Sent even when empty, so the package stores [] instead of offering the PR again.
    commitTimes: (pr.commits ?? []).flatMap((c) => (c.committedDate ? [c.committedDate] : [])),
  };
}

/**
 * The package re-asks a checked PR until it is merged, which would re-query
 * every closed PR forever. Only open PRs and never-checked PRs can still
 * change, and the least recently checked go first so a long open tail is not
 * starved by the same fifty.
 */
function selectPrs(
  graph: WorkspaceGraph,
  prs: readonly PrKey[],
  limit: number,
  now: number,
): PrKey[] {
  const backoff = failBackoffMs();
  const rows = graph.db
    .prepare('SELECT pr_ref, state, outcome_checked_at FROM pr')
    .all() as CheckedRow[];
  const byRef = new Map(rows.map((row) => [row.pr_ref, row]));
  const checkedAt = (pr: PrKey): string => byRef.get(pr.prRef)?.outcome_checked_at ?? '';
  return prs
    .filter((pr) => {
      const failed = failedAt.get(pr.prRef);
      if (failed !== undefined && now - failed <= backoff) return false;
      const row = byRef.get(pr.prRef);
      return !row?.outcome_checked_at || row.state?.toLowerCase() === 'open';
    })
    .sort((a, b) => checkedAt(a).localeCompare(checkedAt(b)))
    .slice(0, limit);
}

async function viewPr(run: RunCommand, pr: PrKey): Promise<ResolvedPr> {
  const args = ['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', GH_FIELDS];
  const result = await run('gh', args);
  if (result.code !== 0) {
    const reason = result.stderr.trim().split('\n')[0] || `exit ${String(result.code)}`;
    throw new Error(reason);
  }
  return toResolved(JSON.parse(result.stdout) as GhPr);
}

export function ghPrResolver(graph: WorkspaceGraph, options: PrOutcomeOptions = {}): PrResolver {
  const run = options.run ?? runCommand;
  const now = options.now ?? Date.now;
  return async (prs: readonly PrKey[]): Promise<PrResolution> => {
    const queue = selectPrs(graph, prs, options.limit ?? PR_OUTCOME_BATCH, now());
    const resolved = new Map<string, ResolvedPr>();
    const worker = async (): Promise<void> => {
      for (let pr = queue.shift(); pr; pr = queue.shift()) {
        try {
          resolved.set(pr.prRef, await viewPr(run, pr));
          failedAt.delete(pr.prRef);
        } catch (err) {
          failedAt.set(pr.prRef, now());
          const reason = err instanceof Error ? err.message : String(err);
          options.errors?.push(`prs: ${pr.repo}#${String(pr.number)}: ${reason}`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return resolved;
  };
}
