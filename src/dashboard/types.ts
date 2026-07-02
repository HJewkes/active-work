/**
 * Response shapes for the three RPC commands the dashboard consumes.
 *
 * These mirror the zod result schemas in `src/commands/{list,task-list,
 * artifact-list}.ts`. Duplicated here so the dashboard bundle has no
 * cross-dependency on backend modules — vite would otherwise try to
 * pull in node-only code.
 */

// ---------------------------------------------------------------------------
// list (initiatives grouped by state)
// ---------------------------------------------------------------------------

export type InitiativeState = 'focused' | 'backburner' | 'paused' | 'done';

export interface InitiativeItem {
  slug: string;
  title: string;
  state: InitiativeState;
  rank?: number;
  ship_target?: string;
  paused_since?: string;
  updated: string;
}

export interface InitiativeSection {
  heading: string;
  items: InitiativeItem[];
}

export interface InitiativesResult {
  sections: InitiativeSection[];
  parse_errors: Array<{ slug: string; error: string }>;
}

// ---------------------------------------------------------------------------
// task.list (cross-initiative tasks)
// ---------------------------------------------------------------------------

export type TaskSeverity = 'critical' | 'high' | 'medium' | 'low';
export type TaskStatus = 'open' | 'done';

export interface TaskItem {
  id: string;
  slug: string;
  title: string;
  priority: number;
  severity?: TaskSeverity;
  estimate?: number;
  done_when?: string;
  status: TaskStatus;
  tags?: string[];
  notes?: string;
  created: string;
  updated: string;
  done_at: string | null;
}

export interface TasksResult {
  tasks: TaskItem[];
}

// ---------------------------------------------------------------------------
// artifact.list (cross-initiative artifacts)
//
// AW-15: PRs were removed from the persisted schema. PR state is now derived
// live via `gh` from `artifact.status`. The dashboard only sees what
// `artifacts.yml` actually stores: branches + stashes.
// ---------------------------------------------------------------------------

export interface BranchEntry {
  repo: string;
  name: string;
  note?: string;
}

export interface StashEntry {
  repo: string;
  label: string;
  sha?: string;
}

export interface ArtifactsBundle {
  branches: BranchEntry[];
  stashes: StashEntry[];
}

export interface ArtifactItem {
  slug: string;
  artifacts: ArtifactsBundle;
}

export interface ArtifactsResult {
  items: ArtifactItem[];
}

// ---------------------------------------------------------------------------
// JSON envelope (matches src/registry/json-envelope.ts)
// ---------------------------------------------------------------------------

export type JsonEnvelope<T> =
  | { ok: true; data: T; warnings?: string[] }
  | { ok: false; error: string; code: number };

/** Shared props for top-level views. `refreshToken` bumps on live-reload. */
export interface ViewProps {
  refreshToken: number;
}
