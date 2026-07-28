/**
 * Open loops are *derived*, never stored: each session records the loops it
 * opens (`next_steps`) and the loops it closes (`resolves`), and live state is
 * whatever is left unresolved. There is no denormalized copy, so there is
 * nothing that can go stale.
 *
 * Derivation deliberately ignores `track` — ad-hoc and sidecar sessions open
 * real loops. `track` only selects which session is the narrative "last
 * mainline session"; it must not gate the ledger.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  SessionFrontmatterSchema,
  type NextStep,
  type SessionFrontmatter,
} from '../schemas/session.js';
import type { Task } from '../schemas/task.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FRONTMATTER_DELIM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface OpenLoop {
  /**
   * Global reference: `<session file stem>#<next_step id>`. The stem, not
   * `session_id`: a session that records more than once produces several files
   * sharing one `session_id` (`pickAvailableFilename` appends `-1`, `-2`), so
   * only the filename is unique within an initiative.
   */
  ref: string;
  text: string;
  kind: 'task' | 'pr' | 'prose';
  /** The yaml `ref` field of the next_step (task id or PR number), when present. */
  targetRef?: string;
  /** Session filename without `.md` — the identity half of `ref`. */
  sessionFile: string;
  /** Frontmatter `session_id`, kept for display; not unique. */
  sessionId: string;
  /** ISO timestamp — the originating session's `ended`. */
  openedAt: string;
  /** Whole days between `openedAt` and the injected `now`. */
  ageDays: number;
}

export interface DeriveOptions {
  /** Injected for determinism; this module never calls `new Date()`. */
  now: Date;
  /** Auto-closes `kind: 'task'` loops whose `ref` names a done task. */
  tasks?: Task[];
  /**
   * PR refs known merged, supplied by the caller. Derivation stays pure and
   * offline (bootstrap runs it on every launch) and `artifacts.yml` persists no
   * PR state, so without this list PR loops stay open until resolved manually.
   */
  mergedPrs?: string[];
}

/**
 * Why a `resolves` entry did not close a loop. The kinds have different
 * remedies, so they must not be conflated: `missing` is a bad ref, `not-prior`
 * is a correct ref filed too early (re-file it from a later session), `self` is
 * a session trying to close its own loop.
 */
export type DanglingKind = 'missing' | 'not-prior' | 'self';

export interface DanglingResolve {
  /** Stem of the session file that recorded the bad `resolves` entry. */
  sessionFile: string;
  ref: string;
  kind: DanglingKind;
}

/** A file under `sessions/` that could not be parsed as a session. */
export interface MalformedSession {
  /** Filename including `.md`; a malformed file may have no usable identity. */
  file: string;
  reason: string;
}

export interface SessionIssues {
  dangling: DanglingResolve[];
  malformed: MalformedSession[];
}

interface LoadedSession {
  sessionFile: string;
  sessionId: string;
  ended: string;
  endedMs: number;
  frontmatter: SessionFrontmatter;
}

interface LoopEntry {
  ref: string;
  step: NextStep;
  session: LoadedSession;
}

interface Analysis {
  loops: LoopEntry[];
  resolvedRefs: Set<string>;
  dangling: DanglingResolve[];
  malformed: MalformedSession[];
}

type LoadResult =
  | { ok: true; session: LoadedSession }
  | { ok: false; problem: MalformedSession };

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort by contract — never throws. But an unparseable file is *not* the
 * same as an absent one: skipping it silently drops the loops it opened and
 * re-opens the ones it closed, so the reason travels back to the caller.
 */
async function loadSession(fullPath: string, sessionFile: string): Promise<LoadResult> {
  const fail = (reason: string): LoadResult => ({
    ok: false,
    problem: { file: `${sessionFile}.md`, reason },
  });
  let raw: string;
  try {
    raw = await fs.readFile(fullPath, 'utf8');
  } catch (err) {
    return fail(`unreadable: ${describe(err)}`);
  }
  const match = FRONTMATTER_DELIM.exec(raw);
  if (!match) return fail('no frontmatter block');
  let parsed: unknown;
  try {
    parsed = YAML.parse(match[1] ?? '');
  } catch (err) {
    return fail(`invalid YAML: ${describe(err)}`);
  }
  const result = SessionFrontmatterSchema.safeParse(parsed);
  if (!result.success) return fail(`invalid frontmatter: ${summarizeIssues(result.error)}`);
  return { ok: true, session: toLoadedSession(sessionFile, result.data) };
}

function summarizeIssues(error: {
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join(', ');
}

function toLoadedSession(
  sessionFile: string,
  frontmatter: SessionFrontmatter,
): LoadedSession {
  return {
    sessionFile,
    sessionId: frontmatter.session_id,
    ended: frontmatter.ended,
    endedMs: new Date(frontmatter.ended).getTime(),
    frontmatter,
  };
}

async function loadSessions(
  initiativeDir: string,
): Promise<{ sessions: LoadedSession[]; malformed: MalformedSession[] }> {
  const sessionsDir = path.join(initiativeDir, 'sessions');
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return { sessions: [], malformed: [] };
  }
  const sessions: LoadedSession[] = [];
  const malformed: MalformedSession[] = [];
  for (const filename of entries.filter((n) => n.endsWith('.md')).sort()) {
    const result = await loadSession(
      path.join(sessionsDir, filename),
      filename.slice(0, -'.md'.length),
    );
    if (result.ok) sessions.push(result.session);
    else malformed.push(result.problem);
  }
  return { sessions, malformed };
}

function indexLoops(sessions: LoadedSession[]): Map<string, LoopEntry> {
  const loops = new Map<string, LoopEntry>();
  for (const session of sessions) {
    for (const step of session.frontmatter.next_steps) {
      // Filename stems are unique by construction, so no ref can collide.
      loops.set(`${session.sessionFile}#${step.id}`, {
        ref: `${session.sessionFile}#${step.id}`,
        step,
        session,
      });
    }
  }
  return loops;
}

function refStem(ref: string): string {
  const hash = ref.indexOf('#');
  return hash < 0 ? ref : ref.slice(0, hash);
}

/**
 * Classify one `resolves` entry, returning null when it legitimately closes.
 *
 * Only a *strictly* earlier session may close a loop. `<=` let a session close
 * its own loop (defeating the empty-ledger gate) and let two sessions sharing
 * an `ended` close each other's loops in a cycle, both silently.
 *
 * Same-`session_id` targets are rejected too: `pickAvailableFilename` parks a
 * colliding record at `<stem>-1.md`, so a self-directed resolve lands on the
 * *earlier* file and would silently close a different record's live loop.
 */
function classifyResolve(
  ref: string,
  session: LoadedSession,
  loops: Map<string, LoopEntry>,
): DanglingKind | null {
  if (refStem(ref) === session.sessionFile) return 'self';
  const target = loops.get(ref);
  if (!target) return 'missing';
  if (target.session.sessionId === session.sessionId) return 'self';
  if (target.session.endedMs >= session.endedMs) return 'not-prior';
  return null;
}

function applyResolves(
  sessions: LoadedSession[],
  loops: Map<string, LoopEntry>,
): { resolvedRefs: Set<string>; dangling: DanglingResolve[] } {
  const resolvedRefs = new Set<string>();
  const dangling: DanglingResolve[] = [];
  for (const session of sessions) {
    for (const entry of session.frontmatter.resolves) {
      const kind = classifyResolve(entry.ref, session, loops);
      if (kind === null) resolvedRefs.add(entry.ref);
      else dangling.push({ sessionFile: session.sessionFile, ref: entry.ref, kind });
    }
  }
  return { resolvedRefs, dangling };
}

async function analyze(initiativeDir: string): Promise<Analysis> {
  const { sessions, malformed } = await loadSessions(initiativeDir);
  const loops = indexLoops(sessions);
  const { resolvedRefs, dangling } = applyResolves(sessions, loops);
  return { loops: [...loops.values()], resolvedRefs, dangling, malformed };
}

/** `#57` and `57` are the same PR; normalize before comparing. */
function normalizePrRef(ref: string): string {
  return ref.replace(/^#/, '').trim();
}

function isAutoResolved(entry: LoopEntry, opts: DeriveOptions): boolean {
  const target = entry.step.ref;
  if (target === undefined) return false;
  if (entry.step.kind === 'task' && opts.tasks) {
    return opts.tasks.some((t) => t.id === target && t.status === 'done');
  }
  if (entry.step.kind === 'pr' && opts.mergedPrs) {
    const wanted = normalizePrRef(target);
    return opts.mergedPrs.some((ref) => normalizePrRef(ref) === wanted);
  }
  return false;
}

function toOpenLoop(entry: LoopEntry, now: Date): OpenLoop {
  const ageMs = now.getTime() - entry.session.endedMs;
  return {
    ref: entry.ref,
    text: entry.step.text,
    ...(entry.step.ref !== undefined ? { targetRef: entry.step.ref } : {}),
    kind: entry.step.kind,
    sessionFile: entry.session.sessionFile,
    sessionId: entry.session.sessionId,
    openedAt: entry.session.ended,
    ageDays: Math.max(0, Math.floor(ageMs / MS_PER_DAY)),
  };
}

/** Unresolved loops for an initiative, oldest first. */
export async function deriveOpenLoops(
  initiativeDir: string,
  opts: DeriveOptions,
): Promise<OpenLoop[]> {
  const { loops, resolvedRefs } = await analyze(initiativeDir);
  return loops
    .filter((entry) => !resolvedRefs.has(entry.ref) && !isAutoResolved(entry, opts))
    .map((entry) => toOpenLoop(entry, opts.now))
    .sort(
      (a, b) =>
        new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime() ||
        a.ref.localeCompare(b.ref),
    );
}

/** `resolves` entries that did not close a loop, each tagged with why. */
export async function findDanglingResolves(
  initiativeDir: string,
): Promise<DanglingResolve[]> {
  const { dangling } = await analyze(initiativeDir);
  return dangling;
}

/**
 * Everything derivation had to work around: rejected `resolves` and session
 * files it could not read. Callers that only render loops can ignore this, but
 * something must report it — a malformed file both drops its own loops and
 * re-opens the ones it closed, and that is invisible in the ledger itself.
 */
export async function findSessionIssues(initiativeDir: string): Promise<SessionIssues> {
  const { dangling, malformed } = await analyze(initiativeDir);
  return { dangling, malformed };
}
