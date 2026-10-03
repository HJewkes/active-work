/**
 * Which open PR loops point at a merged PR, asked of GitHub through `gh` (TP-913).
 *
 * Derivation stays offline, so this is the caller's half of `mergedPrs`. Every
 * failure (no network, no auth, no `gh`) leaves the loop unmarked and becomes
 * one warning: an unknown merge state must never fail a read of the ledger.
 *
 * The daemon serves every `loops` call from one process, so answers are cached
 * and each call asks about a bounded number of PRs. Without both, a caller that
 * polls the MCP tool spawns one `gh` per PR loop per call.
 */

import path from 'node:path';
import { ArtifactsSchema } from '../schemas/artifacts.js';
import { getGhRunner, resolveOrgRepo } from '../utils/git-gh.js';
import { readYaml } from '../utils/yaml-io.js';
import type { OpenLoop } from './open-loops.js';

const GH_TIMEOUT_MS = 5_000;
const CONCURRENCY = 4;
const CACHE_TTL_MS = 5 * 60 * 1000;
/** PRs asked of `gh` in one call. Cached answers are free and do not count. */
export const MAX_PR_CHECKS_PER_CALL = 10;

const URL_REF = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/;
const QUALIFIED_REF = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/;
const BARE_REF = /^#?(\d+)$/;

export interface MergedPrLoops {
  /** Refs of the loops whose PR GitHub reports merged. */
  merged: Set<string>;
  warnings: string[];
}

interface PrTarget {
  repo: string;
  number: string;
  /** Every loop waiting on this PR. */
  loopRefs: string[];
}

export interface MergedPrOptions {
  /** Clock for the cache; tests replace it. */
  now?: () => number;
}

type PrState = { merged: boolean } | { error: string };

/** A failure is cached like an answer: an offline daemon must not retry on every call. */
const cache = new Map<string, { at: number; state: PrState }>();

export function clearPrStateCache(): void {
  cache.clear();
}

function cacheKey(target: PrTarget): string {
  return `${target.repo}#${target.number}`.toLowerCase();
}

function cachedState(target: PrTarget, now: number): PrState | undefined {
  const hit = cache.get(cacheKey(target));
  return hit !== undefined && now - hit.at < CACHE_TTL_MS ? hit.state : undefined;
}

function dropExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
}

/** A PR ref names its repo, or is a bare number that only `soleRepo` can place. */
function parsePrRef(ref: string, soleRepo: string | null): { repo: string; number: string } | null {
  const trimmed = ref.trim();
  const named = URL_REF.exec(trimmed) ?? QUALIFIED_REF.exec(trimmed);
  if (named) return { repo: named[1]!, number: named[2]! };
  const bare = BARE_REF.exec(trimmed);
  return bare && soleRepo !== null ? { repo: soleRepo, number: bare[1]! } : null;
}

/**
 * The initiative's one GitHub repo, or null when it records none or several.
 * A bare `#57` in an initiative spanning two repos could be either PR, and
 * marking the wrong one merged is worse than marking neither.
 */
async function findSoleRepo(initiativeDir: string): Promise<string | null> {
  let recorded: string[];
  try {
    const artifacts = await readYaml(path.join(initiativeDir, 'artifacts.yml'), ArtifactsSchema);
    recorded = [...artifacts.worktrees, ...artifacts.branches].map((entry) => entry.repo);
  } catch {
    return null;
  }
  const resolved = await Promise.all([...new Set(recorded)].map((repo) => resolveOrgRepo(repo)));
  const repos = new Set(resolved.filter((repo): repo is string => repo !== null));
  return repos.size === 1 ? [...repos][0]! : null;
}

async function isMerged(target: PrTarget): Promise<boolean> {
  const args = ['pr', 'view', target.number, '--repo', target.repo, '--json', 'state'];
  const result = await getGhRunner()('gh', args, { timeoutMs: GH_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim().split('\n')[0] || `gh exited ${String(result.code)}`);
  }
  return (JSON.parse(result.stdout) as { state?: string }).state === 'MERGED';
}

function groupTargets(
  loops: OpenLoop[],
  soleRepo: string | null,
): { targets: PrTarget[]; unplaced: string[] } {
  const targets = new Map<string, PrTarget>();
  const unplaced: string[] = [];
  for (const loop of loops) {
    const parsed = parsePrRef(loop.targetRef ?? '', soleRepo);
    if (!parsed) {
      unplaced.push(loop.ref);
      continue;
    }
    const key = `${parsed.repo}#${parsed.number}`;
    const target = targets.get(key) ?? { ...parsed, loopRefs: [] };
    target.loopRefs.push(loop.ref);
    targets.set(key, target);
  }
  return { targets: [...targets.values()], unplaced };
}

async function askGitHub(target: PrTarget): Promise<PrState> {
  try {
    return { merged: await isMerged(target) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function refreshCache(targets: PrTarget[], clock: () => number): Promise<void> {
  const queue = [...targets];
  const worker = async (): Promise<void> => {
    for (let target = queue.shift(); target; target = queue.shift()) {
      const state = await askGitHub(target);
      cache.set(cacheKey(target), { at: clock(), state });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

interface Gaps {
  /** Loop refs whose PR names no repo. */
  unplaced: string[];
  failures: string[];
  /** PRs left unasked because the call had reached its cap. */
  overCap: number;
}

function describeGaps({ unplaced, failures, overCap }: Gaps): string[] {
  const warnings: string[] = [];
  if (unplaced.length > 0) {
    warnings.push(
      `Cannot tell which repo ${unplaced.length} pr loop(s) point at (${unplaced.join(', ')}), ` +
        'so their merge state was not checked. File a pr loop with the PR URL or owner/repo#number.',
    );
  }
  if (failures.length > 0) {
    warnings.push(
      `Could not check ${failures.length} PR(s) through gh; the loops waiting on them are ` +
        `left unmarked. First failure: ${failures[0]}`,
    );
  }
  if (overCap > 0) {
    warnings.push(
      `Asked gh about ${MAX_PR_CHECKS_PER_CALL} PRs, the limit for one call; the loops waiting ` +
        `on ${overCap} more are left unmarked. Answers are kept for 5 minutes, so the next ` +
        'call checks the rest.',
    );
  }
  return warnings;
}

/** Read every target's answer from the cache; a target the cap left unasked has none. */
function collect(targets: PrTarget[], now: number): { merged: Set<string>; failures: string[] } {
  const merged = new Set<string>();
  const failures: string[] = [];
  for (const target of targets) {
    const state = cachedState(target, now);
    if (state === undefined) continue;
    if ('error' in state) failures.push(`${target.repo}#${target.number}: ${state.error}`);
    else if (state.merged) target.loopRefs.forEach((ref) => merged.add(ref));
  }
  return { merged, failures };
}

export async function findMergedPrLoops(
  initiativeDir: string,
  loops: OpenLoop[],
  options: MergedPrOptions = {},
): Promise<MergedPrLoops> {
  const clock = options.now ?? Date.now;
  const prLoops = loops.filter((loop) => loop.kind === 'pr' && loop.targetRef !== undefined);
  if (prLoops.length === 0) return { merged: new Set(), warnings: [] };
  const needsSoleRepo = prLoops.some((loop) => BARE_REF.test(loop.targetRef!.trim()));
  const soleRepo = needsSoleRepo ? await findSoleRepo(initiativeDir) : null;
  const { targets, unplaced } = groupTargets(prLoops, soleRepo);

  dropExpired(clock());
  const unknown = targets.filter((target) => cachedState(target, clock()) === undefined);
  await refreshCache(unknown.slice(0, MAX_PR_CHECKS_PER_CALL), clock);
  const { merged, failures } = collect(targets, clock());
  const overCap = Math.max(0, unknown.length - MAX_PR_CHECKS_PER_CALL);
  return { merged, warnings: describeGaps({ unplaced, failures, overCap }) };
}
