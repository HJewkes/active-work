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
 *
 * `worktrees[]` follows the same rule. It persists identity (`path`, `repo`,
 * `branch`) plus the one thing git cannot tell you — `holding`, what work the
 * worktree is parked on. Dirty/clean, files changed, and ahead/behind are
 * deliberately absent: they are read live from git in `artifact.status` via
 * `src/utils/git-worktrees.ts`. A persisted copy is wrong the moment anyone
 * touches the tree.
 *
 * This field is additive with a default, so pre-existing `artifacts.yml`
 * files keep validating untouched — no migration needed.
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

/**
 * Schema v4 (AW-67): `brief.worktrees` collapsed into this list, so a worktree
 * has exactly one home.
 *
 * The two records had different jobs, and merging them without a marker would
 * have quietly changed launcher behavior: `brief.worktrees` was the *curated*
 * set an operator registered, and it is what `aw` resolves a cwd against, while
 * this list is *swept* automatically by `wrap` from whatever git reports.
 * Letting every swept worktree become a cwd-resolution target would make `aw`
 * ambiguous in repos it had never been told about.
 *
 * `name` is that marker. An entry with a `name` is registered — the operator
 * labelled it, it participates in cwd resolution, and it may be `default`. An
 * entry without one was merely observed. `worktree.set` promotes an observed
 * entry by giving it a name rather than creating a duplicate.
 */
export const WorktreeEntrySchema = z.object({
  path: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1).optional(),
  holding: z.string().min(1).optional(),
  pr: z.number().int().positive().optional(),
  note: z.string().optional(),
  /** Operator's label. Present only on registered worktrees. */
  name: z.string().min(1).optional(),
  /** The worktree `aw <slug>` starts in. Only meaningful alongside `name`. */
  default: z.boolean().optional(),
});

export const ArtifactsSchema = z
  .object({
    branches: z.array(BranchEntrySchema).default([]),
    stashes: z.array(StashEntrySchema).default([]),
    worktrees: z.array(WorktreeEntrySchema).default([]),
  })
  .superRefine((value, ctx) => {
    // Both invariants used to be free: names were object keys in the brief, and
    // only one entry could carry `default` because the writer rebuilt the map.
    // In a flat list they have to be enforced.
    const names = new Set<string>();
    let defaults = 0;
    value.worktrees.forEach((entry, i) => {
      if (entry.name !== undefined) {
        if (names.has(entry.name)) {
          ctx.addIssue({
            code: 'custom',
            path: ['worktrees', i, 'name'],
            message: `duplicate worktree name: ${entry.name}`,
          });
        }
        names.add(entry.name);
      }
      if (entry.default === true) {
        defaults += 1;
        if (entry.name === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['worktrees', i, 'default'],
            message: 'default requires a named worktree',
          });
        }
      }
    });
    if (defaults > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['worktrees'],
        message: 'at most one worktree may be default',
      });
    }
  });

export type BranchEntry = z.infer<typeof BranchEntrySchema>;
export type StashEntry = z.infer<typeof StashEntrySchema>;
export type WorktreeEntry = z.infer<typeof WorktreeEntrySchema>;
export type Artifacts = z.infer<typeof ArtifactsSchema>;
