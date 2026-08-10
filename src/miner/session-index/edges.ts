import path from 'node:path';
import { resolveRepo } from './repo-root.js';
import { RELATIONS } from '../../schemas/session-index-relations.js';
import type { EdgeInput } from '../../schemas/session-index.js';

/**
 * Stable `*_ref` construction and the relation-emission rules. Refs are the
 * only join key between the per-asset tables and `edges`, so they must be
 * derived deterministically from transcript content alone — never from a
 * database autoincrement.
 */

export function sessionRef(sessionId: string): string {
  return `session:${sessionId}`;
}

export function fileRef(repo: string | null, filePath: string): string {
  return repo ? `file:${repo}/${filePath}` : `file:${filePath}`;
}

export function prRef(repo: string, prNumber: number): string {
  return `pr:${repo}#${prNumber}`;
}

export function branchRef(repo: string | null, name: string): string {
  return repo ? `branch:${repo}/${name}` : `branch:${name}`;
}

export function taskRef(taskId: string): string {
  return `task:${taskId}`;
}

export function agentRef(toolUseId: string): string {
  return `agent:${toolUseId}`;
}

export function artifactRef(id: string): string {
  return `artifact:${id}`;
}

export interface RepoRelativePath {
  repo: string | null;
  path: string;
}

/**
 * Resolve a touched file to `(repo, repo-relative path)`.
 *
 * The repo comes from the file's own nearest `.git` ancestor, not from
 * `basename(cwd)` (AW-91): name-guessing collapsed unrelated directories that
 * happened to share a last segment into one repo. A file with no `.git`
 * ancestor keeps its absolute form with a null repo, which query-time repo
 * filters treat as unattributed rather than mis-attributed.
 *
 * Paths are relative to the working-tree root, so they line up with
 * `git ls-files` regardless of which subdirectory the tool call ran in. A
 * non-absolute path has no resolvable anchor of its own and is left alone.
 */
export function toRepoRelative(filePath: string): RepoRelativePath {
  if (!path.isAbsolute(filePath)) return { repo: null, path: filePath };
  const repo = resolveRepo(path.dirname(filePath));
  if (!repo) return { repo: null, path: filePath };
  return { repo: repo.name, path: path.relative(repo.root, filePath) };
}

/** The repo a tool call ran in, for signals keyed by `cwd` (branches, PRs). */
export function repoForCwd(cwd: string | null): string | null {
  return resolveRepo(cwd)?.name ?? null;
}

export interface EdgeSpec {
  sourceRef: string;
  relation: string;
  targetRef: string;
  tValid: string;
  factByteOffset: number | null;
}

function edge(spec: EdgeSpec): EdgeInput {
  return { ...spec, confidence: 1 };
}

export function sessionTouchedFile(spec: Omit<EdgeSpec, 'relation'>): EdgeInput {
  return edge({ ...spec, relation: RELATIONS.TOUCHED });
}

export function sessionLinkedPr(spec: Omit<EdgeSpec, 'relation'>): EdgeInput {
  return edge({ ...spec, relation: RELATIONS.LINKED });
}

export function prBuiltOnBranch(spec: Omit<EdgeSpec, 'relation'>): EdgeInput {
  return edge({ ...spec, relation: RELATIONS.BUILT_ON });
}

export function sessionWorkedBranch(spec: Omit<EdgeSpec, 'relation'>): EdgeInput {
  return edge({ ...spec, relation: RELATIONS.WORKED });
}

export function sessionRanTask(spec: Omit<EdgeSpec, 'relation'>): EdgeInput {
  return edge({ ...spec, relation: RELATIONS.RAN });
}

export function sessionSpawnedSubagent(spec: Omit<EdgeSpec, 'relation'>): EdgeInput {
  return edge({ ...spec, relation: RELATIONS.SPAWNED });
}

export function subagentTranscribedIn(spec: Omit<EdgeSpec, 'relation'>): EdgeInput {
  return edge({ ...spec, relation: RELATIONS.TRANSCRIBED_IN });
}

export function sessionProducedArtifact(spec: Omit<EdgeSpec, 'relation'>): EdgeInput {
  return edge({ ...spec, relation: RELATIONS.PRODUCED });
}

export function humanEditedFile(spec: Omit<EdgeSpec, 'relation'>): EdgeInput {
  return edge({ ...spec, relation: RELATIONS.EDITED_BY_HUMAN });
}
