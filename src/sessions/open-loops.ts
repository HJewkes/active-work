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

export interface DanglingResolve {
  /** Stem of the session file that recorded the bad `resolves` entry. */
  sessionFile: string;
  ref: string;
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
}

async function loadSession(
  fullPath: string,
  sessionFile: string,
): Promise<LoadedSession | null> {
  try {
    const raw = await fs.readFile(fullPath, 'utf8');
    const match = FRONTMATTER_DELIM.exec(raw);
    const parsed = match ? YAML.parse(match[1] ?? '') : {};
    const frontmatter = SessionFrontmatterSchema.parse(parsed);
    return {
      sessionFile,
      sessionId: frontmatter.session_id,
      ended: frontmatter.ended,
      endedMs: new Date(frontmatter.ended).getTime(),
      frontmatter,
    };
  } catch {
    // Malformed sessions are skipped: derivation is best-effort, like bootstrap.
    return null;
  }
}

async function loadSessions(initiativeDir: string): Promise<LoadedSession[]> {
  const sessionsDir = path.join(initiativeDir, 'sessions');
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }
  const loaded: LoadedSession[] = [];
  for (const filename of entries.filter((n) => n.endsWith('.md'))) {
    const session = await loadSession(
      path.join(sessionsDir, filename),
      filename.slice(0, -'.md'.length),
    );
    if (session) loaded.push(session);
  }
  return loaded;
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

/**
 * Walk every `resolves` entry and split it into a real closure or a dangling
 * pointer. Only a later session may close an earlier one: a resolve aimed at a
 * session that ended *after* the resolver is a lineage error, not a closure.
 */
function applyResolves(
  sessions: LoadedSession[],
  loops: Map<string, LoopEntry>,
): { resolvedRefs: Set<string>; dangling: DanglingResolve[] } {
  const resolvedRefs = new Set<string>();
  const dangling: DanglingResolve[] = [];
  for (const session of sessions) {
    for (const entry of session.frontmatter.resolves) {
      const target = loops.get(entry.ref);
      if (target && target.session.endedMs <= session.endedMs) {
        resolvedRefs.add(entry.ref);
      } else {
        dangling.push({ sessionFile: session.sessionFile, ref: entry.ref });
      }
    }
  }
  return { resolvedRefs, dangling };
}

async function analyze(initiativeDir: string): Promise<Analysis> {
  const sessions = await loadSessions(initiativeDir);
  const loops = indexLoops(sessions);
  const { resolvedRefs, dangling } = applyResolves(sessions, loops);
  return { loops: [...loops.values()], resolvedRefs, dangling };
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

/** `resolves` entries pointing at a next_step that does not exist (or is not prior). */
export async function findDanglingResolves(
  initiativeDir: string,
): Promise<DanglingResolve[]> {
  const { dangling } = await analyze(initiativeDir);
  return dangling;
}
