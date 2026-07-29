import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../errors.js';
import { BriefFrontmatterSchema, type BriefFrontmatter } from '../schemas/brief.js';
import {
  SessionFrontmatterSchema,
  type SessionFrontmatter,
} from '../schemas/session.js';
import {
  buildSessionStem,
  sessionFilePathForStem,
  writeSessionFile,
} from '../sessions/session-file.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readRawFrontmatter, writeFrontmatter } from '../utils/gray-matter-io.js';
import {
  loadProposal,
  type Proposal,
  type ProposalInitiative,
} from './v3-proposal.js';
import {
  KNOWN_REPAIRS,
  applyRepair,
  planRepairs,
  repairBriefFrontmatter,
  type RepairPlan,
} from './v3-repairs.js';
import type { Migration } from './types.js';

/**
 * v2 → v3 (AW-38): retire `handoff.md` in favour of the session open-loops
 * ledger.
 *
 * Per initiative, driven entirely by the hand-authored proposal data file:
 * - write a back-dated `track: sidecar` session carrying the handoff's
 *   next-actions as `next_steps`, so they enter the ledger and start aging
 *   from their real last-touch;
 * - where the proposal marks a loop `abandoned`, write a *second* sidecar
 *   session, stamped later, whose `resolves` closes it (see below);
 * - repair known-broken brief fields, then backfill `task_seq`;
 * - copy `handoff.md` to `sources/handoff-archive.md`, then delete it;
 * - repair the two known-malformed session files (see `v3-repairs.ts`).
 *
 * **This module writes sessions via `writeSessionFile` directly rather than
 * through `wrap`, which `SKILL.md` otherwise names as the only session
 * writer.** `wrap` stamps `brief.updated = today()`. Running it 17 times would
 * mark every initiative touched today and destroy the exact staleness signal
 * the back-dating exists to preserve. This is the sanctioned exception; no
 * other caller should copy it.
 *
 * **Why abandonment takes a second session.** A loop that was already dead
 * when the handoff was written must still be *opened* — the ledger's job is to
 * show that it existed — and then closed by a decision that is itself dated.
 * Migrating it as live would leave a loop whose own text reads "do not chase"
 * aging in the ledger forever and tripping the 30-day warning. Since only a
 * strictly later session may resolve an earlier one's loops, the closing
 * session is stamped with the proposal's `abandoned_at` — a fixed value, not
 * the clock, because the filename derives from it and idempotence keys on the
 * exact path.
 *
 * Two-phase by construction: `planV2ToV3` builds and schema-validates every
 * initiative in memory and throws on the first problem; nothing is written
 * until the whole batch passes. A rejected `session_id` therefore fails before
 * anything lands rather than half way through, which matters because a
 * half-run leaves `.schema-version` un-bumped and the next CLI invocation
 * re-runs from the top.
 *
 * Idempotent by exact target path: every synthetic session has a deterministic
 * `started` + `session_id`, so its filename is reproducible and an existing
 * file is a skip — checked per session, so an interrupted run that wrote the
 * opening session but not the abandonment one completes correctly.
 * `writeSessionFile`'s own de-duplication (which appends `-1`) is deliberately
 * never allowed to fire; it would duplicate every migrated loop under fresh
 * refs on a re-run.
 *
 * Synthetic sessions never set `no_loops`. An empty ledger here means "the
 * handoff had nothing extractable", not "the operator confirmed nothing is
 * hanging", and the migration is not entitled to make the second claim.
 */

const HANDOFF_FILE = 'handoff.md';
const HANDOFF_ARCHIVE = path.join('sources', 'handoff-archive.md');

/** Distinguishes the back-dated opening session from the later closing one. */
export type SessionKind = 'open' | 'abandon';

export type HandoffDisposition = 'archive-and-remove' | 'archive-exists' | 'absent';

export interface SessionPlan {
  kind: SessionKind;
  stem: string;
  path: string;
  frontmatter: SessionFrontmatter;
  body: string;
  exists: boolean;
}

/** A single validated brief write carrying both repairs and the backfill. */
export interface BriefWrite {
  frontmatter: BriefFrontmatter;
  body: string;
  /** Value written, or `null` when only field repairs applied. */
  taskSeq: number | null;
  repairs: string[];
}

export interface InitiativePlan {
  slug: string;
  /** Empty when uncovered; one session normally; two when loops are abandoned. */
  sessions: SessionPlan[];
  /** Set when no proposal entry covers this initiative; no session is written. */
  uncoveredReason?: string;
  brief: BriefWrite | null;
  /** Set when the brief cannot be rewritten; skipped, not fatal. */
  briefBlocked?: string;
  handoff: HandoffDisposition;
}

export interface MigrationPlan {
  proposalOrigin: string;
  initiatives: InitiativePlan[];
  repairs: RepairPlan[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listInitiativeSlugs(activeRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(activeRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (await pathExists(path.join(activeRoot, entry.name, 'brief.md'))) {
      slugs.push(entry.name);
    }
  }
  return slugs.sort();
}

/**
 * Highest task number ever visible on disk, including `tasks/archive/`.
 * `task add` only scans `tasks/`, so archiving the highest-numbered task
 * currently lowers its allocation floor; seeding the high-water mark from
 * both directories closes that hole at the same instant as the reuse window.
 */
async function maxOnDiskTaskNumber(initiativeDir: string, prefix: string): Promise<number> {
  const re = new RegExp(`^${prefix}-(\\d+)\\.yml$`);
  const tasksDir = path.join(initiativeDir, 'tasks');
  let max = 0;
  for (const dir of [tasksDir, path.join(tasksDir, 'archive')]) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = re.exec(name);
      if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
    }
  }
  return max;
}

async function nextTaskSeq(
  initiativeDir: string,
  frontmatter: Record<string, unknown>,
): Promise<number | null> {
  if (frontmatter.task_seq !== undefined) return null;
  const prefix = frontmatter.task_prefix;
  if (typeof prefix !== 'string' || prefix.length === 0) return null;
  const max = await maxOnDiskTaskNumber(initiativeDir, prefix);
  return max > 0 ? max : null;
}

/**
 * The brief to write, or `null` when nothing changes. Field repairs run first
 * so an initiative whose brief is currently invalid — `health`, which carries
 * an out-of-enum `state` — stops being skipped by the backfill.
 *
 * Spread-then-set preserves every other field, `updated` included: neither a
 * repair nor a backfill is a touch of the work.
 */
async function planBrief(
  initiativeDir: string,
  slug: string,
): Promise<{ write: BriefWrite | null; blocked?: string }> {
  const raw = await readRawFrontmatter(path.join(initiativeDir, 'brief.md'));
  const repaired = repairBriefFrontmatter(slug, raw.frontmatter);
  const taskSeq = await nextTaskSeq(initiativeDir, repaired.frontmatter);
  if (taskSeq === null && repaired.applied.length === 0) return { write: null };

  const merged = {
    ...repaired.frontmatter,
    ...(taskSeq === null ? {} : { task_seq: taskSeq }),
  };
  // A brief still invalid for some *other* reason is reported and skipped: one
  // malformed brief must not block the other sixteen initiatives.
  const parsed = BriefFrontmatterSchema.safeParse(merged);
  if (!parsed.success) {
    return { write: null, blocked: `brief.md is invalid: ${parsed.error.message}` };
  }
  return {
    write: { frontmatter: parsed.data, body: raw.body, taskSeq, repairs: repaired.applied },
  };
}

async function planHandoff(initiativeDir: string): Promise<HandoffDisposition> {
  if (!(await pathExists(path.join(initiativeDir, HANDOFF_FILE)))) return 'absent';
  // An archive already sitting next to a live handoff means a previous run
  // stopped mid-initiative, or the operator has begun the manual split. Either
  // way the archive is not ours to overwrite, and deleting the handoff without
  // archiving it would destroy the only copy.
  if (await pathExists(path.join(initiativeDir, HANDOFF_ARCHIVE))) return 'archive-exists';
  return 'archive-and-remove';
}

function buildOpenSession(entry: ProposalInitiative): Omit<SessionPlan, 'path' | 'exists'> {
  const frontmatter = SessionFrontmatterSchema.parse({
    session_id: entry.session_id,
    // A synthetic session is an instant, not an interval: it stands for a
    // state read off the handoff, so `started === ended`.
    started: entry.ended,
    ended: entry.ended,
    track: 'sidecar',
    // `abandoned` is proposal-only bookkeeping and must not reach the file.
    next_steps: entry.next_steps.map(({ abandoned: _abandoned, ...step }) => step),
    resolves: [],
  });
  const stem = buildSessionStem(entry.ended, entry.session_id);
  return { kind: 'open', stem, frontmatter, body: buildOpenBody(entry, stem) };
}

function buildAbandonSession(
  entry: ProposalInitiative,
  openStem: string,
  abandonedAt: string,
): Omit<SessionPlan, 'path' | 'exists'> {
  const sessionId = `${entry.session_id}-abandonment`;
  const frontmatter = SessionFrontmatterSchema.parse({
    session_id: sessionId,
    started: abandonedAt,
    ended: abandonedAt,
    track: 'sidecar',
    next_steps: [],
    resolves: entry.next_steps
      .filter((step) => step.abandoned !== undefined)
      .map((step) => ({
        ref: `${openStem}#${step.id}`,
        outcome: 'abandoned' as const,
        note: step.abandoned!.note,
      })),
  });
  const stem = buildSessionStem(abandonedAt, sessionId);
  return {
    kind: 'abandon',
    stem,
    frontmatter,
    body: buildAbandonBody(entry, openStem, stem),
  };
}

const PERMANENCE_NOTE = (stem: string): string =>
  `_This file is permanent. Deleting it frees the stem \`${stem}\` for reuse by` +
  ` any later session sharing its minute and \`session_id\`, silently` +
  ` retargeting every ref filed against it._`;

function buildOpenBody(entry: ProposalInitiative, stem: string): string {
  return [
    entry.body.trimEnd(),
    '',
    '---',
    '',
    `_Synthetic session written by the v2→v3 open-loops migration from this` +
      ` initiative's \`handoff.md\` (archived at \`sources/handoff-archive.md\`)._`,
    PERMANENCE_NOTE(stem),
    '',
  ].join('\n');
}

function buildAbandonBody(
  entry: ProposalInitiative,
  openStem: string,
  stem: string,
): string {
  const dead = entry.next_steps.filter((s) => s.abandoned !== undefined);
  return [
    '# Abandoned on arrival',
    '',
    `The v2→v3 open-loops migration opened ${entry.slug}'s loops in \`${openStem}\`,`,
    'back-dated to its real last-touch. The items below were already dead when that',
    'handoff was written — the window each depended on had closed — so this session',
    'closes them immediately rather than leaving loops in the ledger that their own',
    'text tells a future session not to chase.',
    '',
    ...dead.flatMap((step) => [`- \`${openStem}#${step.id}\` — ${step.abandoned!.note}`, '']),
    '---',
    '',
    PERMANENCE_NOTE(stem),
    '',
  ].join('\n');
}

async function locateSessions(
  activeRoot: string,
  slug: string,
  drafts: Array<Omit<SessionPlan, 'path' | 'exists'>>,
): Promise<SessionPlan[]> {
  const located: SessionPlan[] = [];
  for (const draft of drafts) {
    const full = sessionFilePathForStem(slug, draft.stem, activeRoot);
    located.push({ ...draft, path: full, exists: await pathExists(full) });
  }
  return located;
}

function draftSessions(
  entry: ProposalInitiative,
  abandonedAt: string | undefined,
): Array<Omit<SessionPlan, 'path' | 'exists'>> {
  const open = buildOpenSession(entry);
  const hasAbandoned = entry.next_steps.some((s) => s.abandoned !== undefined);
  if (!hasAbandoned) return [open];
  // Guaranteed by ProposalSchema's refinement; re-asserted so a future caller
  // constructing a Proposal by hand cannot skip the ordering guarantee.
  if (abandonedAt === undefined) {
    throw new ValidationError(
      `${entry.slug} marks a next_step abandoned but the proposal has no abandoned_at`,
    );
  }
  return [open, buildAbandonSession(entry, open.stem, abandonedAt)];
}

async function planInitiative(
  activeRoot: string,
  slug: string,
  entry: ProposalInitiative | undefined,
  abandonedAt: string | undefined,
): Promise<InitiativePlan> {
  const initiativeDir = path.join(activeRoot, slug);
  const brief = await planBrief(initiativeDir, slug);
  const base = {
    slug,
    brief: brief.write,
    ...(brief.blocked === undefined ? {} : { briefBlocked: brief.blocked }),
    handoff: await planHandoff(initiativeDir),
  };
  if (entry === undefined) {
    return { ...base, sessions: [], uncoveredReason: 'no entry in the migration proposal' };
  }
  return {
    ...base,
    sessions: await locateSessions(activeRoot, slug, draftSessions(entry, abandonedAt)),
  };
}

function assertProposalSlugsExist(proposal: Proposal, known: string[]): void {
  const set = new Set(known);
  const missing = proposal.initiatives.filter((i) => !set.has(i.slug)).map((i) => i.slug);
  if (missing.length > 0) {
    throw new ValidationError(
      `v2→v3 migration proposal names initiatives that do not exist: ${missing.join(', ')}`,
    );
  }
}

/**
 * Phase one. Reads everything, validates everything, writes nothing. Throws
 * on the first invalid entry so a bad proposal is a pre-run error.
 */
export async function planV2ToV3(activeRoot: string): Promise<MigrationPlan> {
  const { proposal, origin } = await loadProposal();
  const slugs = await listInitiativeSlugs(activeRoot);
  assertProposalSlugsExist(proposal, slugs);

  const byslug = new Map(proposal.initiatives.map((i) => [i.slug, i]));
  const initiatives: InitiativePlan[] = [];
  for (const slug of slugs) {
    initiatives.push(
      await planInitiative(activeRoot, slug, byslug.get(slug), proposal.abandoned_at),
    );
  }
  return { proposalOrigin: origin, initiatives, repairs: await planRepairs(activeRoot) };
}

async function archiveHandoff(initiativeDir: string): Promise<void> {
  const source = path.join(initiativeDir, HANDOFF_FILE);
  const target = path.join(initiativeDir, HANDOFF_ARCHIVE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  await fs.rm(source);
}

async function writePlannedSession(
  activeRoot: string,
  slug: string,
  session: SessionPlan,
): Promise<void> {
  const fm = session.frontmatter;
  await writeSessionFile({
    slug,
    activeRoot,
    session_id: fm.session_id,
    started: fm.started,
    ended: fm.ended,
    track: fm.track,
    next_steps: fm.next_steps,
    resolves: fm.resolves,
    body: session.body,
  });
}

async function applyInitiative(activeRoot: string, plan: InitiativePlan): Promise<void> {
  const initiativeDir = path.join(activeRoot, plan.slug);
  await withFileLock(path.join(initiativeDir, '.lock'), async () => {
    // Ordered: the opening session must exist before the one that resolves it.
    for (const session of plan.sessions) {
      if (session.exists) continue;
      await writePlannedSession(activeRoot, plan.slug, session);
    }
    if (plan.brief !== null) {
      await writeFrontmatter(
        path.join(initiativeDir, 'brief.md'),
        plan.brief.frontmatter,
        plan.brief.body,
        BriefFrontmatterSchema,
      );
    }
    if (plan.handoff === 'archive-and-remove') {
      await archiveHandoff(initiativeDir);
    }
  });
}

/** Phase two. Writes only what phase one already validated. */
export async function applyV2ToV3(activeRoot: string, plan: MigrationPlan): Promise<void> {
  for (const initiative of plan.initiatives) {
    await applyInitiative(activeRoot, initiative);
  }
  for (const repair of plan.repairs) {
    await applyRepair(activeRoot, repair);
  }
}

export const v2ToV3OpenLoops: Migration = {
  from: 2,
  to: 3,
  description: 'Retire handoff.md into synthetic back-dated open-loop sessions',
  async run(activeRoot: string): Promise<void> {
    const plan = await planV2ToV3(activeRoot);
    await applyV2ToV3(activeRoot, plan);
  },
};

export { KNOWN_REPAIRS };
export default v2ToV3OpenLoops;
