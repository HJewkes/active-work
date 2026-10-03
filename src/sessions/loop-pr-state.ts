/**
 * Which open PR loops point at a merged PR, asked of GitHub through `gh` (TP-913).
 *
 * Derivation stays offline, so this is the caller's half of `mergedPrs`. Every
 * failure (no network, no auth, no `gh`) leaves the loop unmarked and becomes
 * one warning: an unknown merge state must never fail a read of the ledger.
 */

import path from 'node:path';
import { ArtifactsSchema } from '../schemas/artifacts.js';
import { getGhRunner, resolveOrgRepo } from '../utils/git-gh.js';
import { readYaml } from '../utils/yaml-io.js';
import type { OpenLoop } from './open-loops.js';

const GH_TIMEOUT_MS = 5_000;
const CONCURRENCY = 4;

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

async function askGitHub(targets: PrTarget[], merged: Set<string>): Promise<string[]> {
  const failures: string[] = [];
  const queue = [...targets];
  const worker = async (): Promise<void> => {
    for (let target = queue.shift(); target; target = queue.shift()) {
      try {
        if (await isMerged(target)) target.loopRefs.forEach((ref) => merged.add(ref));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failures.push(`${target.repo}#${target.number}: ${reason}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return failures;
}

function describeGaps(unplaced: string[], failures: string[]): string[] {
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
  return warnings;
}

export async function findMergedPrLoops(
  initiativeDir: string,
  loops: OpenLoop[],
): Promise<MergedPrLoops> {
  const merged = new Set<string>();
  const prLoops = loops.filter((loop) => loop.kind === 'pr' && loop.targetRef !== undefined);
  if (prLoops.length === 0) return { merged, warnings: [] };
  const needsSoleRepo = prLoops.some((loop) => BARE_REF.test(loop.targetRef!.trim()));
  const soleRepo = needsSoleRepo ? await findSoleRepo(initiativeDir) : null;
  const { targets, unplaced } = groupTargets(prLoops, soleRepo);
  const failures = await askGitHub(targets, merged);
  return { merged, warnings: describeGaps(unplaced, failures) };
}
