import path from 'node:path';
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
 * Resolve a touched file against the session's `cwd`. The production index is
 * cross-initiative, so there is no configured repo to resolve against (unlike
 * the AW-22 prototype's `--repo` flag) — `cwd` is the only in-transcript
 * signal. A path outside `cwd` keeps its absolute form with a null repo, which
 * query-time repo filters treat as unattributed rather than mis-attributed.
 */
export function toRepoRelative(cwd: string | null, filePath: string): RepoRelativePath {
  if (!cwd || !filePath.startsWith(`${cwd}/`)) return { repo: null, path: filePath };
  return { repo: path.basename(cwd), path: filePath.slice(cwd.length + 1) };
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

export function sessionProducedArtifact(spec: Omit<EdgeSpec, 'relation'>): EdgeInput {
  return edge({ ...spec, relation: RELATIONS.PRODUCED });
}

export function humanEditedFile(spec: Omit<EdgeSpec, 'relation'>): EdgeInput {
  return edge({ ...spec, relation: RELATIONS.EDITED_BY_HUMAN });
}
