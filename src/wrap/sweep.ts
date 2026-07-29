import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ArtifactsSchema,
  type Artifacts,
  type BranchEntry,
  type StashEntry,
  type WorktreeEntry,
} from '../schemas/artifacts.js';
import { registeredOf } from '../utils/registered-worktrees.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { expandTilde } from '../utils/paths.js';
import { resolveLocalRepoPath } from '../utils/git-gh.js';
import {
  discoverWorktrees,
  listStashes,
  readWorktreeState,
  type DiscoveredWorktree,
  type WorktreeState,
} from '../utils/git-worktrees.js';

/**
 * Pre-wrap sweep: the git state a session leaves behind that nobody recorded.
 *
 * The repo set is bounded and derived, never searched: the worktree paths in
 * `brief.md`, the `repo` values already in `artifacts.yml`, and the caller's
 * cwd. Everything else is read live through `getGitRunner()` (via
 * `src/utils/git-worktrees.ts`), so a repo that has moved contributes nothing
 * rather than aborting the sweep.
 */

export interface UnrecordedState {
  worktrees: WorktreeEntry[];
  branches: BranchEntry[];
  stashes: StashEntry[];
}

export interface DirtyTree {
  path: string;
  repo: string;
  /** Null when git could not say — the tree is unknown, not clean. */
  files_changed: number | null;
}

export interface UnpushedBranch {
  path: string;
  repo: string;
  branch: string;
  /** Commits that exist on no remote. */
  ahead: number;
  /**
   * True when the branch tracks nothing. Not a lesser case of `ahead > 0` but
   * the worse one: nothing about the branch exists anywhere but this disk.
   */
  no_upstream: boolean;
}

export interface SweepResult {
  repos: string[];
  unrecorded: UnrecordedState;
  dirty: DirtyTree[];
  unpushed: UnpushedBranch[];
}

interface LiveState {
  worktrees: WorktreeEntry[];
  branches: BranchEntry[];
  stashes: StashEntry[];
  dirty: DirtyTree[];
  unpushed: UnpushedBranch[];
}

interface RepoSweep extends LiveState {
  /** The path we swept from — a repo root or any worktree attached to it. */
  sweptPath: string;
  /**
   * The repository this path belongs to, as git reports it (the main worktree
   * of the set). Two swept paths sharing a root are one repository.
   */
  root: string | null;
}

const EMPTY_STATE = (): LiveState => ({
  worktrees: [],
  branches: [],
  stashes: [],
  dirty: [],
  unpushed: [],
});

const emptySweep = (sweptPath: string): RepoSweep => ({
  ...EMPTY_STATE(),
  sweptPath,
  root: null,
});

function normalizePath(value: string): string {
  return path.resolve(expandTilde(value));
}

/** Stable identity for a `repo` field, which may be a path or `org/repo`. */
function repoKey(repo: string): string {
  return resolveLocalRepoPath(repo) ?? repo;
}

function artifactsPath(initiativeDir: string): string {
  return path.join(initiativeDir, 'artifacts.yml');
}

/**
 * Missing `artifacts.yml` reads as empty; a malformed one still throws, so a
 * later append can never silently overwrite content it failed to parse.
 */
async function readArtifacts(initiativeDir: string): Promise<Artifacts> {
  const file = artifactsPath(initiativeDir);
  try {
    await fs.access(file);
  } catch {
    return { branches: [], stashes: [], worktrees: [] };
  }
  return readYaml(file, ArtifactsSchema);
}

/**
 * Registered worktree paths seed the repo set. Since v4 these live in
 * artifacts.yml alongside the swept ones (AW-67), so they arrive with the rest
 * of the artifacts read and need no separate file.
 */
function registeredWorktreePaths(artifacts: Artifacts): string[] {
  return registeredOf(artifacts).map((entry) => entry.path);
}

/**
 * Absolute repo path -> the label to write into new artifact entries. Seeded
 * from `artifacts.yml` first so recorded spellings (`~/code/sample`) win over
 * the resolved absolute path.
 */
function collectRepoLabels(
  artifacts: Artifacts,
  briefPaths: string[],
  cwd: string,
): Map<string, string> {
  const labels = new Map<string, string>();
  const add = (value: string): void => {
    const abs = resolveLocalRepoPath(value);
    if (abs && !labels.has(abs)) labels.set(abs, value);
  };
  for (const branch of artifacts.branches) add(branch.repo);
  for (const stash of artifacts.stashes) add(stash.repo);
  for (const worktree of artifacts.worktrees) add(worktree.repo);
  for (const worktreePath of briefPaths) add(worktreePath);
  add(cwd);
  return labels;
}

/**
 * Collect one worktree's contribution to the sweep. Every live worktree is
 * recorded — its path and purpose are identity, and git cannot re-derive what
 * it is parked on — while branches, dirt, and unpushed commits are filtered.
 */
function collectWorktree(
  discovered: DiscoveredWorktree,
  label: string,
  state: WorktreeState,
  into: RepoSweep,
): void {
  const branch = state.branch ?? discovered.branch ?? undefined;
  // Never `?? 0`: a failed probe means unknown, and defaulting it to zero
  // reports the most dangerous branch — one that exists on no remote — as the
  // safest. Unknown counts as unpushed.
  // A failed `--not --remotes` probe falls back to `ahead`, and only then to 1
  // as "unknown but non-zero" — a tracked branch 3 ahead must not read as clean
  // just because the remote-wide count could not be taken.
  const stranded = state.unpushed ?? state.ahead ?? 1;
  const isUnpushed = stranded > 0;
  into.worktrees.push({
    path: discovered.path,
    repo: label,
    ...(branch ? { branch } : {}),
  });
  // `dirty: null` means git could not answer, which is reported rather than
  // skipped: treating an unreadable tree as clean hides exactly the
  // uncommitted work this sweep exists to surface.
  const dirtyUnknown = state.dirty === null;
  if (state.dirty || dirtyUnknown) {
    into.dirty.push({
      path: discovered.path,
      repo: label,
      files_changed: state.files_changed,
    });
  }
  if (!branch) return;
  if (isUnpushed) {
    into.unpushed.push({
      path: discovered.path,
      repo: label,
      branch,
      ahead: stranded,
      no_upstream: !state.has_upstream,
    });
  }
  // A checked-out branch is worth recording only when it carries work that
  // lives nowhere else — unpushed commits or an uncommitted tree. Recording
  // every branch git happens to have checked out would bury the ones that
  // matter.
  if (state.dirty !== false || isUnpushed) {
    into.branches.push({ repo: label, name: branch });
  }
}

async function sweepRepo(repoPath: string, label: string): Promise<RepoSweep> {
  const [discovered, stashes] = await Promise.all([
    discoverWorktrees(repoPath),
    listStashes(repoPath),
  ]);
  const out = emptySweep(repoPath);
  // git lists the main worktree first; it identifies the repository the swept
  // path belongs to, whichever worktree of the set we were pointed at.
  out.root = discovered[0]?.path ?? null;
  for (const worktree of discovered) {
    if (worktree.bare) continue;
    const state = await readWorktreeState(worktree.path);
    if (!state.present) continue;
    collectWorktree(worktree, label, state, out);
  }
  out.stashes = stashes.map((stash) => ({
    repo: label,
    label: stash.label,
    sha: stash.sha,
  }));
  return out;
}

/** First occurrence wins, so the chosen `repo` label is stable across runs. */
function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const worktreeKey = (entry: { path: string }): string => normalizePath(entry.path);
const branchKey = (entry: BranchEntry): string => `${repoKey(entry.repo)} ${entry.name}`;
const stashKey = (entry: StashEntry): string =>
  `${repoKey(entry.repo)} ${entry.sha ?? entry.label}`;

/**
 * Which repository a sweep covered. Falls back to the swept path when git could
 * not say — a path that answers nothing cannot be merged with anything else.
 */
const repositoryOf = (sweep: RepoSweep): string => sweep.root ?? sweep.sweptPath;

/**
 * `git worktree list` and `git stash list` are per-repository, and the repo set
 * can legitimately hold two paths belonging to one repo — a main checkout plus
 * a registered linked worktree. Sweeping both yields every worktree and stash
 * twice under different labels, so candidates must be deduped against each
 * other and not merely against what is already recorded.
 */
function mergeSweeps(sweeps: RepoSweep[]): LiveState {
  const merged = EMPTY_STATE();
  for (const sweep of sweeps) {
    merged.worktrees.push(...sweep.worktrees);
    merged.branches.push(...sweep.branches);
    merged.stashes.push(...sweep.stashes);
    merged.dirty.push(...sweep.dirty);
    merged.unpushed.push(...sweep.unpushed);
  }
  return {
    worktrees: dedupeBy(merged.worktrees, worktreeKey),
    branches: dedupeBy(merged.branches, branchKey),
    stashes: dedupeBy(merged.stashes, stashKey),
    dirty: dedupeBy(merged.dirty, worktreeKey),
    unpushed: dedupeBy(merged.unpushed, worktreeKey),
  };
}

function unrecordedWorktrees(
  candidates: WorktreeEntry[],
  recorded: WorktreeEntry[],
): WorktreeEntry[] {
  const seen = new Set(recorded.map((entry) => normalizePath(entry.path)));
  return candidates.filter((entry) => !seen.has(normalizePath(entry.path)));
}

function unrecordedBranches(
  candidates: BranchEntry[],
  recorded: BranchEntry[],
): BranchEntry[] {
  const key = (repo: string, name: string): string => `${repoKey(repo)} ${name}`;
  const seen = new Set(recorded.map((entry) => key(entry.repo, entry.name)));
  return candidates.filter((entry) => !seen.has(key(entry.repo, entry.name)));
}

/**
 * Stashes are matched on `repo` + `sha`, falling back to `label` for entries
 * recorded before a sha was known — a recorded stash with no sha is otherwise
 * invisible to the sweep and gets appended a second time on every wrap.
 */
function unrecordedStashes(
  candidates: StashEntry[],
  recorded: StashEntry[],
): StashEntry[] {
  const key = (repo: string, tail: string): string => `${repoKey(repo)} ${tail}`;
  const shas = new Set<string>();
  const labels = new Set<string>();
  for (const entry of recorded) {
    if (entry.sha) shas.add(key(entry.repo, entry.sha));
    else labels.add(key(entry.repo, entry.label));
  }
  return candidates.filter(
    (entry) =>
      !(entry.sha && shas.has(key(entry.repo, entry.sha))) &&
      !labels.has(key(entry.repo, entry.label)),
  );
}

/** Read-only. Never writes. */
export async function sweepInitiative(
  slug: string,
  activeRoot: string,
  cwd: string,
): Promise<SweepResult> {
  const initiativeDir = path.join(activeRoot, slug);
  const artifacts = await readArtifacts(initiativeDir);
  const labels = collectRepoLabels(artifacts, registeredWorktreePaths(artifacts), cwd);
  const swept = await Promise.all(
    [...labels].map(([repoPath, label]) => sweepRepo(repoPath, label)),
  );
  const distinct = dedupeBy(swept, repositoryOf);
  const live = mergeSweeps(distinct);
  return {
    repos: distinct.map(repositoryOf),
    unrecorded: {
      worktrees: unrecordedWorktrees(live.worktrees, artifacts.worktrees),
      branches: unrecordedBranches(live.branches, artifacts.branches),
      stashes: unrecordedStashes(live.stashes, artifacts.stashes),
    },
    dirty: live.dirty,
    unpushed: live.unpushed,
  };
}

/**
 * Appends `unrecorded` into artifacts.yml and returns how many of each were
 * added. CALLER MUST ALREADY HOLD THE INITIATIVE LOCK — this function must NOT
 * call withFileLock itself or it will deadlock inside wrap's existing lock.
 */
export async function recordUnrecorded(
  slug: string,
  activeRoot: string,
  unrecorded: UnrecordedState,
): Promise<{ worktrees: number; branches: number; stashes: number }> {
  const initiativeDir = path.join(activeRoot, slug);
  const current = await readArtifacts(initiativeDir);
  const worktrees = unrecordedWorktrees(unrecorded.worktrees, current.worktrees);
  const branches = unrecordedBranches(unrecorded.branches, current.branches);
  const stashes = unrecordedStashes(unrecorded.stashes, current.stashes);
  const added = {
    worktrees: worktrees.length,
    branches: branches.length,
    stashes: stashes.length,
  };
  if (worktrees.length + branches.length + stashes.length === 0) return added;
  await writeYaml(
    artifactsPath(initiativeDir),
    {
      branches: [...current.branches, ...branches],
      stashes: [...current.stashes, ...stashes],
      worktrees: [...current.worktrees, ...worktrees],
    },
    ArtifactsSchema,
  );
  return added;
}
