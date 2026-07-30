import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SessionFrontmatterSchema, type SessionFrontmatter } from '../schemas/session.js';
import { readRawFrontmatter, writeFrontmatter } from '../utils/gray-matter-io.js';

/**
 * Two session files in the live data predate the schema and fail it. v3 turns
 * unreadable session files into a standing `doctor` warning, so unless these
 * are repaired in the same pass the new integrity check starts life crying
 * wolf — and a permanent false positive masks the real reports it exists for.
 *
 * They are addressed by exact path rather than by a general rule: "any session
 * with an out-of-enum `track` becomes adhoc" would silently rewrite files the
 * operator has not looked at. Each repair re-checks its precondition, so a
 * file already fixed by hand is left alone and a re-run is a no-op.
 */

export type RepairAction = 'retrack' | 'relocate' | 'skip';

export interface RepairPlan {
  action: RepairAction;
  /** Path relative to the active root. */
  file: string;
  target?: string;
  detail: string;
  /** Validated replacement content, populated by `retrack` plans only. */
  repaired?: { frontmatter: SessionFrontmatter; body: string };
}

interface KnownRepair {
  file: string;
  kind: 'retrack' | 'relocate';
  target?: string;
  why: string;
}

export const KNOWN_REPAIRS: KnownRepair[] = [
  {
    file: path.join('audiobook', 'sessions', '2026-07-23-0549-2026-07-26-book1-m4b-packaging.md'),
    kind: 'retrack',
    why: "track is a branch name ('feat/tts-quality'), not one of canonical|sidecar|adhoc",
  },
  {
    file: path.join('voltras-workspace', 'sessions', 'ARCHIVED-handoff-through-2026-07-15.md'),
    kind: 'relocate',
    target: path.join('voltras-workspace', 'sources', 'ARCHIVED-handoff-through-2026-07-15.md'),
    why: 'not a session file — a hand-archived handoff parked in sessions/',
  },
];

const TRACKS = new Set(['canonical', 'sidecar', 'adhoc']);

/**
 * Brief-level repairs, applied before the `task_seq` backfill so a brief that
 * currently fails validation can still be rewritten.
 *
 * `health` carries `state: active`, which has never been in the enum, so every
 * validating writer refuses it — `active-work touch health` errors today. The
 * operator's chosen resolution is `focused` at rank 11 (1–10 are taken).
 * Guarded by the exact broken value, so a hand-fix beforehand wins.
 */
const BRIEF_REPAIRS: Record<
  string,
  (fm: Record<string, unknown>) => { patch: Record<string, unknown>; detail: string } | null
> = {
  health(fm) {
    if (fm.state !== 'active') return null;
    return {
      patch: { state: 'focused', ...(fm.rank === undefined ? { rank: 11 } : {}) },
      detail: "state 'active' (not in the enum) -> 'focused', rank 11",
    };
  },
};

/**
 * Apply any known repair for `slug` to raw brief frontmatter. Returns the
 * frontmatter unchanged (and an empty `applied`) when nothing matches.
 */
export function repairBriefFrontmatter(
  slug: string,
  frontmatter: Record<string, unknown>,
): { frontmatter: Record<string, unknown>; applied: string[] } {
  const repair = BRIEF_REPAIRS[slug]?.(frontmatter);
  if (repair == null) return { frontmatter, applied: [] };
  return {
    frontmatter: { ...frontmatter, ...repair.patch },
    applied: [repair.detail],
  };
}

/**
 * An out-of-enum `track` is the only thing this repair is allowed to fix, so
 * the repaired frontmatter is validated here, in phase one. A file that is
 * still invalid for some *other* reason is reported and left alone rather
 * than throwing half way through the write phase.
 */
async function planRetrack(fullPath: string, repair: KnownRepair): Promise<RepairPlan> {
  let raw: { frontmatter: Record<string, unknown>; body: string };
  try {
    raw = await readRawFrontmatter(fullPath);
  } catch {
    return { action: 'skip', file: repair.file, detail: 'unreadable; left for the operator' };
  }
  const track = raw.frontmatter.track;
  if (typeof track === 'string' && TRACKS.has(track)) {
    return { action: 'skip', file: repair.file, detail: `track already ${track}` };
  }
  const parsed = SessionFrontmatterSchema.safeParse({ ...raw.frontmatter, track: 'adhoc' });
  if (!parsed.success) {
    return {
      action: 'skip',
      file: repair.file,
      detail: `still invalid after retrack; left for the operator: ${parsed.error.message}`,
    };
  }
  return {
    action: 'retrack',
    file: repair.file,
    detail: `track ${JSON.stringify(track)} -> "adhoc" (${repair.why})`,
    repaired: { frontmatter: parsed.data, body: raw.body },
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function planRepairs(activeRoot: string): Promise<RepairPlan[]> {
  const plans: RepairPlan[] = [];
  for (const repair of KNOWN_REPAIRS) {
    const fullPath = path.join(activeRoot, repair.file);
    if (!(await exists(fullPath))) {
      plans.push({ action: 'skip', file: repair.file, detail: 'already absent' });
      continue;
    }
    if (repair.kind === 'retrack') {
      plans.push(await planRetrack(fullPath, repair));
      continue;
    }
    const target = repair.target!;
    if (await exists(path.join(activeRoot, target))) {
      plans.push({
        action: 'skip',
        file: repair.file,
        target,
        detail: 'target already occupied; left for the operator',
      });
      continue;
    }
    plans.push({ action: 'relocate', file: repair.file, target, detail: repair.why });
  }
  return plans;
}

export async function applyRepair(activeRoot: string, plan: RepairPlan): Promise<void> {
  const fullPath = path.join(activeRoot, plan.file);
  if (plan.action === 'retrack' && plan.repaired !== undefined) {
    await writeFrontmatter(
      fullPath,
      plan.repaired.frontmatter,
      plan.repaired.body,
      SessionFrontmatterSchema,
    );
    return;
  }
  if (plan.action === 'relocate') {
    const target = path.join(activeRoot, plan.target!);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(fullPath, target);
  }
}
