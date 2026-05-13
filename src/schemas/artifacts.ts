import { z } from 'zod';

/**
 * Schema v2 (AW-15): `artifacts.yml` carries only durable identifiers.
 *
 * - `prs[]` was dropped. PR state is derived live via `gh pr list --head <branch>`
 *   in `artifact.status` (see `src/commands/artifact-status.ts`); persisting it
 *   only led to stale snapshots that agents kept hand-editing.
 * - `branches[]` gained an optional `note` for "why this branch is worth
 *   tracking" context. The `last_commit` field is gone — it's derivable from
 *   git at read time.
 * - `stashes[].message` was renamed to `label` for consistency, `created` was
 *   dropped (stashes are ephemeral and the data lived in git anyway), and
 *   `sha` was added so callers can record it if known.
 */

export const BranchEntrySchema = z.object({
  repo: z.string().min(1),
  name: z.string().min(1),
  note: z.string().optional(),
});

export const StashEntrySchema = z.object({
  repo: z.string().min(1),
  label: z.string().min(1),
  sha: z.string().optional(),
});

export const ArtifactsSchema = z.object({
  branches: z.array(BranchEntrySchema).default([]),
  stashes: z.array(StashEntrySchema).default([]),
});

export type BranchEntry = z.infer<typeof BranchEntrySchema>;
export type StashEntry = z.infer<typeof StashEntrySchema>;
export type Artifacts = z.infer<typeof ArtifactsSchema>;
