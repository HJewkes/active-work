/**
 * Reading and writing the registered half of `artifacts.worktrees[]` (AW-67).
 *
 * Worktrees used to live in two places: `brief.worktrees` (curated, keyed by
 * name) and `artifacts.worktrees[]` (swept from git by `wrap`). They now share
 * one list, distinguished by whether an entry carries a `name` — see
 * `src/schemas/artifacts.ts`.
 *
 * Every caller that used to read `brief.worktrees` goes through here, so the
 * "registered means named" rule is stated once. A second implementation that
 * disagreed would make `aw` resolve a cwd the launcher never intended.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ArtifactsSchema, type Artifacts, type WorktreeEntry } from '../schemas/artifacts.js';
import { readYaml, writeYaml } from './yaml-io.js';

/** A worktree an operator registered: identical to an entry, but named. */
export type RegisteredWorktree = WorktreeEntry & { name: string };

export function artifactsPathFor(initiativeDir: string): string {
  return path.join(initiativeDir, 'artifacts.yml');
}

const EMPTY: Artifacts = { branches: [], stashes: [], worktrees: [] };

/** Missing file reads as empty; a malformed one still throws. */
export async function readArtifactsFile(initiativeDir: string): Promise<Artifacts> {
  const file = artifactsPathFor(initiativeDir);
  try {
    await fs.access(file);
  } catch {
    return { ...EMPTY, branches: [], stashes: [], worktrees: [] };
  }
  return readYaml(file, ArtifactsSchema);
}

export function registeredOf(artifacts: Artifacts): RegisteredWorktree[] {
  return artifacts.worktrees.filter(
    (entry): entry is RegisteredWorktree => entry.name !== undefined,
  );
}

/**
 * Registered worktrees for an initiative. Never throws for a missing or
 * unreadable artifacts.yml — a brief that cannot be paired with artifacts
 * simply has no registered worktrees, which is what callers scanning every
 * initiative need in order to skip it rather than abort the scan.
 */
export async function readRegisteredWorktrees(
  initiativeDir: string,
): Promise<RegisteredWorktree[]> {
  try {
    return registeredOf(await readArtifactsFile(initiativeDir));
  } catch {
    return [];
  }
}

/**
 * The worktree `aw <slug>` should start in: the explicit default, or the only
 * registered worktree when there is exactly one. Null when neither holds, so
 * the caller can fall back to the initiative directory.
 */
export function defaultWorktreePath(registered: RegisteredWorktree[]): string | null {
  const explicit = registered.find((entry) => entry.default === true);
  if (explicit) return explicit.path;
  return registered.length === 1 ? registered[0]!.path : null;
}

export async function writeArtifactsFile(
  initiativeDir: string,
  artifacts: Artifacts,
): Promise<void> {
  await writeYaml(artifactsPathFor(initiativeDir), artifacts, ArtifactsSchema);
}
