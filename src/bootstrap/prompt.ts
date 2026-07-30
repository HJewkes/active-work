import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BriefFrontmatterSchema,
  type BriefFrontmatter,
} from '../schemas/brief.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import {
  ArtifactsSchema,
  type Artifacts,
  type BranchEntry,
  type WorktreeEntry,
} from '../schemas/artifacts.js';
import {
  deriveOpenLoopsFrom,
  deriveResolvedLoopsFrom,
  loadSessionsFromDir,
  normalizePrRef,
  type LoadedSession,
  type LoadedSessions,
  type MalformedSession,
  type OpenLoop,
  type ResolvedLoop,
} from '../sessions/open-loops.js';
import {
  loadNotesFromDir,
  type LoadedNote,
  type LoadedNotes,
} from '../notes/note-file.js';
import {
  readLiveLeases,
  type LiveSibling,
  type SiblingProbe,
} from '../sessions/lease.js';
import { readYaml } from '../utils/yaml-io.js';
import {
  getGhRunner,
  getGitRunner,
  resolveLocalRepoPath,
  resolveOrgRepo,
} from '../utils/git-gh.js';
import { today, nowIso } from '../utils/today.js';
import { NotFoundError } from '../errors.js';
import YAML from 'yaml';
import type { ZodType } from 'zod';

const BRIEF_BODY_MAX_LINES = 40;
const SESSION_BODY_MAX_LINES = 25;
const DEFAULT_TOP_N_TASKS = 5;
const DEFAULT_RECENTLY_DONE_DAYS = 14;

const RECENT_THRESHOLD_DAYS = 14;
const MS_PER_HOUR = 1000 * 60 * 60;
const MS_PER_DAY = MS_PER_HOUR * 24;

export interface LiveBranchStatus {
  repo: string;
  name: string;
  note?: string;
  present: boolean;
  last_commit_iso: string | null;
  ahead: number | null;
  behind: number | null;
  pr: {
    number: number;
    state: string;
    title: string;
    url: string;
    checks?: string;
  } | null;
}

export type LiveStatusFetcher = (
  branches: BranchEntry[],
) => Promise<LiveBranchStatus[]>;

/** Re-exported so callers can type a sibling list without reaching into `sessions/`. */
export type SiblingSession = LiveSibling;
export type { SiblingProbe };

export interface BootstrapInput {
  /** Active root directory. Used to resolve the initiative dir. */
  activeRoot: string;
  slug: string;
  /** Injectable "now" for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
  /** Cap for top open tasks shown. Defaults to 5. */
  topNTasks?: number;
  /** Window for the "recently done" section. Defaults to 14 days. */
  recentlyDoneDays?: number;
  /**
   * When `true` (default), the bootstrap pulls live branch/PR state via
   * `git` + `gh`. When `false`, only the static `artifacts.yml` data is
   * rendered — useful for offline contexts and fast-path test runs.
   */
  includeLiveStatus?: boolean;
  /**
   * Optional fetcher override (DI). Defaults to a built-in walker that
   * shells out via the shared `git`/`gh` runners. The walker is bounded
   * (~10 branches) and swallows per-branch errors; render falls back to
   * static when the whole fetch throws.
   */
  liveStatusFetcher?: LiveStatusFetcher;
  /**
   * Task ids the caller archived just before this bootstrap (AW-8). Rendered as
   * a short housekeeping note so the session knows they left the active list;
   * the actual file moves happen in the `open` command, not here.
   */
  archivedTaskIds?: string[];
  /**
   * When `true`, frame the session as ad-hoc work related to the workstream
   * rather than a continuation of its handoff / top task. The same context is
   * rendered, but the opening and closing directives tell the session to treat
   * it as background and await the user's specific ad-hoc task (AW-20).
   */
  adhoc?: boolean;
  /**
   * When `true` (default), probe for other sessions holding a lease on this
   * initiative and warn about them at the top of the prompt (CC-9).
   */
  detectSiblings?: boolean;
  /**
   * Optional probe override (DI). Defaults to reading the lease directory under
   * the active root. A probe that throws is treated as "no siblings" — this
   * section is advisory and must never be able to fail a bootstrap.
   */
  siblingProbe?: SiblingProbe;
  /** This session's own lease, excluded from the sibling list. */
  ownLeaseId?: string;
}

export interface BootstrapMetadata {
  slug: string;
  brief_title: string;
  last_session?: { filename: string; ended: string };
  time_since_last_session_human?: string;
  open_task_count: number;
  open_loop_count: number;
  recently_done_count: number;
  bootstrap_at: string;
  /** Number of sibling sessions rendered; absent when none were found. */
  sibling_sessions?: number;
}

export interface BootstrapOutput {
  prompt: string;
  metadata: BootstrapMetadata;
}

const FRONTMATTER_DELIM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Read a markdown file with YAML frontmatter and validate the frontmatter
 * against `schema`.
 *
 * We parse the YAML block using the `yaml` package (eemeli/yaml) rather than
 * relying on gray-matter, because gray-matter's js-yaml backend converts
 * bare YAML dates (e.g. `updated: 2026-05-10`) into JavaScript `Date`
 * instances. Our schemas validate `YYYY-MM-DD` strings, so we want the raw
 * lexical form preserved.
 */
export async function readMarkdownWithSchema<T>(
  filePath: string,
  schema: ZodType<T>,
): Promise<{ frontmatter: T; body: string }> {
  const raw = await fs.readFile(filePath, 'utf8');
  const match = FRONTMATTER_DELIM.exec(raw);
  let frontmatterText = '';
  let body = raw;
  if (match) {
    frontmatterText = match[1] ?? '';
    body = match[2] ?? '';
  }
  const parsed = frontmatterText ? YAML.parse(frontmatterText) : {};
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Frontmatter validation failed for ${filePath}: ${result.error.message}`,
    );
  }
  return { frontmatter: result.data, body };
}

/**
 * Order sessions newest first, breaking `ended` ties on `started` so a long
 * mainline session that overlaps a short parallel one still sorts ahead of it.
 */
function compareSessionsNewestFirst(a: LoadedSession, b: LoadedSession): number {
  const endedDelta =
    new Date(b.frontmatter.ended).getTime() -
    new Date(a.frontmatter.ended).getTime();
  if (endedDelta !== 0) return endedDelta;
  return (
    new Date(b.frontmatter.started).getTime() -
    new Date(a.frontmatter.started).getTime()
  );
}

/**
 * Every session for an initiative, newest first, regardless of track.
 *
 * Parsing is delegated to `loadSessionsFromDir` — the same loader derivation
 * uses — so bootstrap can never render a session whose loops the ledger
 * dropped, or vice versa. Unparseable files are not skipped silently: they
 * come back as `malformed` and are surfaced in the Open loops heading.
 */
async function loadSessionsNewestFirst(initiativeDir: string): Promise<LoadedSessions> {
  const { sessions, malformed } = await loadSessionsFromDir(initiativeDir);
  return { sessions: [...sessions].sort(compareSessionsNewestFirst), malformed };
}

/** A task file that would not parse. Mirrors `MalformedSession`. */
export interface MalformedTask {
  /** Filename including extension; a malformed file may have no usable id. */
  file: string;
  reason: string;
}

export interface LoadedTasks {
  tasks: Task[];
  malformed: MalformedTask[];
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read every task file under `initiativeDir/tasks`.
 *
 * A file that would not parse is *not* the same as a task that does not exist:
 * dropping it silently shrinks the open list, so the next session works a stale
 * top task and never learns why. Malformed entries travel back to the caller
 * the way `loadSessionsFromDir` returns `malformed`.
 */
async function loadTasks(initiativeDir: string): Promise<LoadedTasks> {
  const tasksDir = path.join(initiativeDir, 'tasks');
  let entries: string[];
  try {
    entries = await fs.readdir(tasksDir);
  } catch {
    return { tasks: [], malformed: [] };
  }
  const ymlFiles = entries.filter(
    (n) => n.endsWith('.yml') || n.endsWith('.yaml'),
  );
  const tasks: Task[] = [];
  const malformed: MalformedTask[] = [];
  for (const filename of ymlFiles) {
    const fullPath = path.join(tasksDir, filename);
    try {
      tasks.push(await readYaml(fullPath, TaskSchema));
    } catch (err) {
      malformed.push({ file: filename, reason: describe(err) });
    }
  }
  return { tasks, malformed };
}

export interface LoadedArtifacts {
  artifacts: Artifacts;
  /** Set only when `artifacts.yml` exists but could not be read or parsed. */
  error?: string;
}

function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Read `artifacts.yml`, keeping "no artifacts yet" distinct from "the file is
 * broken".
 *
 * Both used to render as an empty ledger, which is the worst possible outcome:
 * a corrupted file quietly claims there are no open branches or stashes, and
 * the session starts by assuming clean ground it does not have.
 */
async function loadArtifacts(initiativeDir: string): Promise<LoadedArtifacts> {
  const artifactsPath = path.join(initiativeDir, 'artifacts.yml');
  const empty: Artifacts = { branches: [], stashes: [], worktrees: [] };
  try {
    return { artifacts: await readYaml(artifactsPath, ArtifactsSchema) };
  } catch (err) {
    if (isMissingFile(err)) return { artifacts: empty };
    return { artifacts: empty, error: describe(err) };
  }
}

/**
 * Keep the first `max` non-blank lines of `body`, marking the cut.
 *
 * The marker is not decoration: an excerpt that ends mid-thought reads as the
 * whole thought, so the reader has to be told both that content was dropped and
 * which file holds the rest. `source` is a real path for exactly that reason.
 */
function truncateLines(body: string, max: number, source: string): string {
  const lines = body.split('\n');
  const trimmed: string[] = [];
  let count = 0;
  let consumed = 0;
  for (const line of lines) {
    if (count >= max) break;
    trimmed.push(line);
    consumed++;
    if (line.trim().length > 0) count++;
  }
  const dropped = lines.slice(consumed).filter((l) => l.trim().length > 0).length;
  const kept = trimmed.join('\n').replace(/\s+$/, '');
  if (dropped === 0) return kept;
  return `${kept}\n…(+${dropped} lines — see ${source})`;
}

/**
 * Format the time between `from` and `now` as a human string.
 *
 * Thresholds:
 *  - < 1h          → "just now"
 *  - < 24h         → "X hours ago"
 *  - < 14d         → "X days ago"
 *  - >= 14d        → "X days ago — likely needs context refresher"
 */
export function formatTimeSince(from: Date, now: Date): string {
  const diffMs = now.getTime() - from.getTime();
  if (diffMs < MS_PER_HOUR) return 'just now';
  if (diffMs < MS_PER_DAY) {
    const hours = Math.floor(diffMs / MS_PER_HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(diffMs / MS_PER_DAY);
  const base = `${days} day${days === 1 ? '' : 's'} ago`;
  if (days >= RECENT_THRESHOLD_DAYS) {
    return `${base} — likely needs context refresher`;
  }
  return base;
}

function compareTasksByPriority(a: Task, b: Task): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id.localeCompare(b.id);
}

function nonBlankLines(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function firstLine(text: string | undefined): string | undefined {
  return nonBlankLines(text)[0];
}

const TASK_SUMMARY_MAX_LINES = 2;
const TASK_SUMMARY_MAX_CHARS = 200;

/**
 * Collapse `lines` into one bounded summary line, marking anything left behind.
 *
 * Same reasoning as `truncateLines`: a silently clipped excerpt reads as the
 * whole thought, so the cut is marked and paired with the command that prints
 * the field untruncated.
 */
function summarizeField(
  label: string,
  lines: string[],
  pointer: string,
): string {
  const kept = lines.slice(0, TASK_SUMMARY_MAX_LINES);
  const joined = kept.join(' ');
  const clamped =
    joined.length > TASK_SUMMARY_MAX_CHARS
      ? joined
          .slice(0, TASK_SUMMARY_MAX_CHARS)
          .replace(/\s+\S*$/, '')
          .trimEnd()
      : joined;
  // A mid-line cut still leaves content on that line, so it counts as remaining.
  const remaining = lines.length - kept.length + (clamped === joined ? 0 : 1);
  if (remaining === 0) return `${label}${clamped}`;
  const noun = remaining === 1 ? 'line' : 'lines';
  return `${label}${clamped}…(+${remaining} ${noun} — see ${pointer})`;
}

/**
 * The line under a task title answers "what does finishing this look like?".
 *
 * `done_when` answers it directly, so it wins. But roughly half the open tasks
 * in a real initiative have no `done_when`, and there a blank line reads as "no
 * context exists" when the notes are sitting right there on disk — so notes
 * become a bounded, marked fallback rather than nothing. Neither form is the
 * record of truth: both point at the command that prints the field in full.
 */
function renderTaskSummary(task: Task, slug: string): string | undefined {
  const pointer = `\`active-work task list ${slug} --json\``;
  const doneWhen = nonBlankLines(task.done_when);
  if (doneWhen.length > 0) {
    return summarizeField('done when: ', doneWhen, pointer);
  }
  const notes = nonBlankLines(task.notes);
  if (notes.length > 0) return summarizeField('notes: ', notes, pointer);
  return undefined;
}

function renderTaskLine(idx: number, task: Task, slug: string): string {
  const meta: string[] = [`priority ${task.priority}`];
  if (task.severity) meta.push(`severity ${task.severity}`);
  if (task.estimate !== undefined) meta.push(`est ${task.estimate}`);
  let line = `${idx}. [${task.id}] (${meta.join(', ')}) ${task.title}`;
  const summary = renderTaskSummary(task, slug);
  if (summary) line += `\n   ${summary}`;
  return line;
}

function renderTopTasks(
  tasks: Task[],
  topN: number,
  slug: string,
): { body: string; count: number } {
  const openTasks = tasks
    .filter((t) => t.status === 'open')
    .sort(compareTasksByPriority);
  if (openTasks.length === 0) {
    return { body: '_No open tasks._', count: 0 };
  }
  const shown = openTasks.slice(0, topN);
  return {
    body: shown.map((task, i) => renderTaskLine(i + 1, task, slug)).join('\n'),
    count: openTasks.length,
  };
}

/**
 * Recently-done tasks are backward-looking: they cost tokens in every bootstrap
 * but are rarely acted on. A count plus the exact lookup command keeps the
 * signal ("this much shipped here") at fixed size and lets the agent pull the
 * detail on the rare occasion it matters.
 */
function renderRecentlyDone(
  tasks: Task[],
  windowDays: number,
  now: Date,
  slug: string,
): { body: string | null; count: number } {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const done = tasks
    .filter((t) => t.status === 'done' && t.done_at)
    .filter((t) => {
      const ts = new Date(t.done_at as string).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    })
    .sort((a, b) => (a.done_at! < b.done_at! ? 1 : -1));
  if (done.length === 0) return { body: null, count: 0 };
  const noun = done.length === 1 ? 'task' : 'tasks';
  const body =
    `${done.length} ${noun} completed — ` +
    `\`active-work task list ${slug} --status done --json\``;
  return { body, count: done.length };
}

/**
 * Notes are capped by count, never by age. A process lesson from six months ago
 * is precisely the one about to be re-learned the hard way, so it must not
 * scroll out of the bootstrap the way "recently done" does. The cap keeps the
 * section bounded; one compact line each keeps it cheap.
 */
const DURABLE_NOTES_LIMIT = 12;

function renderNoteLine(note: LoadedNote): string {
  const { kind, title, created } = note.frontmatter;
  return `- [${kind}] ${title} (${created})`;
}

function renderDurableNotes(loaded: LoadedNotes, slug: string): string | null {
  const { notes, malformed } = loaded;
  if (notes.length === 0 && malformed.length === 0) return null;
  const shown = notes.slice(0, DURABLE_NOTES_LIMIT);
  const lines = shown.map(renderNoteLine);
  const overflow = notes.length - shown.length;
  if (overflow > 0) {
    lines.push(`(+${overflow} older — \`active-work note list ${slug}\`)`);
  }
  if (malformed.length > 0) {
    lines.push(
      `(${malformed.length} note file(s) unreadable — run \`active-work note list ${slug}\`)`,
    );
  }
  const heading =
    overflow > 0
      ? `# Durable notes (newest ${shown.length} of ${notes.length})`
      : `# Durable notes (${notes.length})`;
  return `${heading}\n${lines.join('\n')}`;
}

/**
 * An empty ledger has two very different meanings and the operator has to be
 * able to tell them apart: a session that ran `wrap --no-loops` positively
 * asserted nothing was hanging, whereas an empty derivation may simply mean
 * nobody ever filed a ledger. Rendering both as "nothing hanging" makes the
 * assertion worthless, which is what `no_loops` exists to prevent.
 */
function renderNoOpenLoops(newestSession: LoadedSession | undefined): string {
  if (newestSession?.frontmatter.no_loops === true) {
    return `Nothing hanging — the ${endedDate(newestSession.ended)} session asserted the ledger is clear.`;
  }
  return 'Nothing hanging — no unresolved loops, but no session has asserted the ledger is clear.';
}

/**
 * A file that would not parse both drops the loops it opened and re-opens the
 * ones it closed, so a silently short ledger is worse than a noisy one.
 */
function malformedNote(malformed: MalformedSession[]): string {
  if (malformed.length === 0) return '';
  return ` (${malformed.length} session file(s) unreadable — run \`active-work doctor\`)`;
}

/**
 * A task file that would not parse is missing from the list entirely, so the
 * heading has to say so — otherwise a shorter list looks like less work.
 */
function malformedTaskNote(malformed: MalformedTask[]): string {
  if (malformed.length === 0) return '';
  const files = malformed.map((m) => m.file).join(', ');
  return ` — ${malformed.length} task file(s) unreadable (${files}); run \`active-work doctor\``;
}

/**
 * Whether the text already opens with `ref`, so prefixing would print it twice.
 *
 * Only a match at the head counts. A loop filed against `AW-65` whose text
 * opens `AW-59 is done` is a ledger/text *disagreement* the operator needs to
 * see, not noise to collapse — suppressing there would hide which task the loop
 * actually concerns. The trailing boundary check keeps `AW-2` from matching text
 * about `AW-28` (AW-71).
 */
function textOpensWithRef(text: string, ref: string, kind: OpenLoop['kind']): boolean {
  const head = text.replace(/^\s*(PR\s*)?#?/i, '');
  // A pasted `.../pull/57` at the head is the same restatement in another form.
  if (kind === 'pr' && normalizePrRef(head.split(/\s/)[0] ?? '') === ref) return true;
  if (!head.toLowerCase().startsWith(ref.toLowerCase())) return false;
  const next = head.charAt(ref.length);
  return next === '' || !/[A-Za-z0-9]/.test(next);
}

/** Prefix the loop text with its target so a task/PR loop is actionable at a glance. */
function loopLabel(loop: OpenLoop): string {
  if (loop.targetRef === undefined) return loop.text;
  const ref = loop.kind === 'pr' ? normalizePrRef(loop.targetRef) : loop.targetRef;
  if (textOpensWithRef(loop.text, ref, loop.kind)) return loop.text;
  return loop.kind === 'pr' ? `PR #${ref} ${loop.text}` : `${ref} ${loop.text}`;
}

/**
 * Loops are already unresolved and oldest-first; `ageDays` comes from the
 * derivation so the render never recomputes time. The full `ref` is printed
 * rather than an abbreviated session id because it is the handle `wrap
 * --resolve` takes.
 */
function renderOpenLoops(
  loops: OpenLoop[],
  malformed: MalformedSession[],
  newestSession: LoadedSession | undefined,
): string {
  const note = malformedNote(malformed);
  if (loops.length === 0) {
    return `# Open loops${note}\n${renderNoOpenLoops(newestSession)}`;
  }
  const labels = loops.map(loopLabel);
  const ageWidth = Math.max(...loops.map((l) => String(l.ageDays).length));
  const labelWidth = Math.max(...labels.map((l) => l.length));
  const lines = loops.map((loop, i) => {
    const age = `[${String(loop.ageDays).padStart(ageWidth)}d]`;
    const label = labels[i]!.padEnd(labelWidth);
    const from = loop.openedAt.slice(0, 10);
    return `- ${age} ${label}   (from ${from}, ref ${loop.ref})`;
  });
  const oldest = loops[0]!.ageDays;
  return `# Open loops (${loops.length} hanging, oldest ${oldest}d)${note}\n${lines.join('\n')}`;
}

const WRAP_DIRECTIVE =
  'Update tasks via `active-work task done` and close the session out via `active-work wrap` when wrapping up — it records the session, files the loops you leave open, and stamps the brief in one step.';

/**
 * A hanging loop is thread continuity nobody else will pick up, so it outranks
 * the general backlog — the backlog is still there next session, whereas the
 * context that makes a loop cheap to close decays.
 *
 * The loop-first half is only emitted when the ledger actually has entries:
 * with zero loops the render above already said "nothing hanging", and telling
 * a session to triage loops would send it hunting for something that isn't
 * there.
 */
function renderClosingInstruction(openLoops: OpenLoop[]): string {
  if (openLoops.length === 0) {
    return `Work the top task unless redirected. ${WRAP_DIRECTIVE}`;
  }
  const count = openLoops.length;
  const noun = count === 1 ? 'loop' : 'loops';
  const verb = count === 1 ? 'is' : 'are';
  return (
    `Start with the open ${noun}: ${count} ${verb} still hanging from prior sessions, ` +
    `and unfinished threads take precedence over the backlog. Work them first, citing each ` +
    `one by the \`ref\` printed under "Open loops", and pass every loop you settle to ` +
    `\`active-work wrap --resolves\` with outcome \`done\` or \`abandoned\` — deciding not to ` +
    `do a loop still closes it. Once the loops are handled, or if the user redirects, work ` +
    `the top task by priority. ${WRAP_DIRECTIVE}`
  );
}

/**
 * Only abandonments are rendered, and only recent ones. A loop closed `done`
 * needs no explanation — the work happened. A loop closed `abandoned` is a
 * decision not to do something, and a future session that cannot see it will
 * propose the abandoned thing again.
 */
function renderAbandonedLoops(
  resolved: ResolvedLoop[],
  windowDays: number,
): string | null {
  const abandoned = resolved.filter(
    (loop) => loop.outcome === 'abandoned' && loop.ageDays <= windowDays,
  );
  if (abandoned.length === 0) return null;
  const lines = abandoned.map((loop) => {
    const head = `- ${loop.text} (dropped ${loop.closedAt.slice(0, 10)})`;
    return loop.note ? `${head}\n  why: ${loop.note}` : head;
  });
  return `# Abandoned in the last ${windowDays} days (${abandoned.length})\n${lines.join('\n')}`;
}

const LIVE_RENDER_LIMIT = 10;

function renderStaticBranchLine(branch: BranchEntry): string {
  const head = `- ${branch.name} (${branch.repo})`;
  return branch.note ? `${head} — ${branch.note}` : head;
}

/**
 * The PR title and url were fetched and then dropped, which made the branch
 * block un-actionable: `PR #12 OPEN` tells a session nothing about what the PR
 * is for and gives it nowhere to look. The same goes for `last_commit_iso` —
 * without it, a branch that has been idle for two months reads identically to
 * one touched an hour ago. Both are carried on the line now; the url goes on a
 * continuation line so the primary line stays scannable.
 */
function renderLiveBranchLine(status: LiveBranchStatus): string {
  const parts: string[] = [`- ${status.name} (${status.repo})`];
  if (!status.present) {
    parts.push('[missing locally]');
  } else if (status.ahead !== null && status.behind !== null) {
    parts.push(`+${status.ahead}/-${status.behind}`);
  }
  if (status.last_commit_iso) {
    parts.push(`last commit ${status.last_commit_iso.slice(0, 10)}`);
  }
  if (status.pr) {
    const checks = status.pr.checks ? ` ${status.pr.checks}` : '';
    parts.push(`PR #${status.pr.number} ${status.pr.state}${checks}`);
  }
  let line = parts.join(' ');
  if (status.note) line += ` — ${status.note}`;
  if (status.pr) {
    line += `\n  PR: ${status.pr.title} — ${status.pr.url}`;
  }
  return line;
}

const WORKTREE_RENDER_LIMIT = 8;

function renderWorktreeLine(entry: WorktreeEntry): string {
  const parts: string[] = [`- ${entry.name}${entry.default ? ' (default)' : ''}: ${entry.path}`];
  if (entry.branch) parts.push(`[${entry.branch}]`);
  if (entry.pr) parts.push(`PR #${entry.pr}`);
  const trailer = entry.holding ?? entry.note;
  return trailer ? `${parts.join(' ')} — ${trailer}` : parts.join(' ');
}

/**
 * Only *registered* worktrees get a line.
 *
 * `worktrees[]` mixes two populations (see `src/schemas/artifacts.ts`): entries
 * the operator named and registered — these resolve `aw <slug>`'s cwd — and
 * entries `wrap` merely swept out of git. Listing every swept tree would bury
 * the two the session actually launches into under a pile of unrelated repos
 * the operator never asked about. The observed ones still get counted, so their
 * existence is visible without their noise, and the count names the command
 * that shows them.
 */
function renderWorktrees(artifacts: Artifacts, slug: string): string | null {
  const registered = artifacts.worktrees.filter((w) => w.name !== undefined);
  const observed = artifacts.worktrees.length - registered.length;
  if (registered.length === 0 && observed === 0) return null;

  const lines: string[] = [];
  const shown = registered.slice(0, WORKTREE_RENDER_LIMIT);
  if (shown.length > 0) {
    lines.push(...shown.map(renderWorktreeLine));
  } else {
    lines.push('_None registered._');
  }
  const overflow = registered.length - shown.length;
  if (overflow > 0) {
    lines.push(`(+${overflow} more registered — \`active-work artifact list ${slug}\`)`);
  }
  if (observed > 0) {
    const noun = observed === 1 ? 'worktree' : 'worktrees';
    lines.push(
      `(+${observed} observed ${noun} swept from git, not registered — \`active-work artifact list ${slug}\`)`,
    );
  }
  return `Worktrees (registered):\n${lines.join('\n')}`;
}

function renderStashes(artifacts: Artifacts): string | null {
  if (artifacts.stashes.length === 0) return null;
  return artifacts.stashes
    .map((s) => `- ${s.repo}: ${s.label}${s.sha ? ` (${s.sha.slice(0, 12)})` : ''}`)
    .join('\n');
}

function renderStaticArtifacts(artifacts: Artifacts, slug: string): string | null {
  const sections: string[] = [];
  if (artifacts.branches.length > 0) {
    const branchLines = artifacts.branches.map(renderStaticBranchLine).join('\n');
    sections.push(`Branches:\n${branchLines}`);
  }
  const worktreeBody = renderWorktrees(artifacts, slug);
  if (worktreeBody) sections.push(worktreeBody);
  const stashBody = renderStashes(artifacts);
  if (stashBody) sections.push(`Stashes:\n${stashBody}`);
  return sections.length > 0 ? sections.join('\n\n') : null;
}

function renderLiveArtifacts(
  artifacts: Artifacts,
  statuses: LiveBranchStatus[],
  slug: string,
): string | null {
  const sections: string[] = [];
  if (statuses.length > 0) {
    const shown = statuses.slice(0, LIVE_RENDER_LIMIT);
    const lines = shown.map(renderLiveBranchLine).join('\n');
    const overflow = statuses.length - shown.length;
    const suffix = overflow > 0 ? `\n(+${overflow} more)` : '';
    sections.push(`Branches (live):\n${lines}${suffix}`);
  } else if (artifacts.branches.length > 0) {
    const branchLines = artifacts.branches.map(renderStaticBranchLine).join('\n');
    sections.push(`Branches:\n${branchLines}`);
  }
  const worktreeBody = renderWorktrees(artifacts, slug);
  if (worktreeBody) sections.push(worktreeBody);
  const stashBody = renderStashes(artifacts);
  if (stashBody) sections.push(`Stashes:\n${stashBody}`);
  return sections.length > 0 ? sections.join('\n\n') : null;
}

/**
 * Default fetcher used when the caller doesn't supply one. Mirrors the
 * read logic in `artifact.status` but is bounded in parallelism and
 * swallows per-branch errors silently — bootstrap never throws on artifact
 * issues.
 */
async function defaultLiveStatusFetcher(
  branches: BranchEntry[],
): Promise<LiveBranchStatus[]> {
  const results: LiveBranchStatus[] = [];
  const limit = Math.min(branches.length, LIVE_RENDER_LIMIT);
  for (let i = 0; i < limit; i++) {
    results.push(await fetchOne(branches[i]!));
  }
  return results;
}

async function fetchOne(branch: BranchEntry): Promise<LiveBranchStatus> {
  const out: LiveBranchStatus = {
    repo: branch.repo,
    name: branch.name,
    ...(branch.note ? { note: branch.note } : {}),
    present: false,
    last_commit_iso: null,
    ahead: null,
    behind: null,
    pr: null,
  };
  const repoPath = resolveLocalRepoPath(branch.repo);
  const git = getGitRunner();
  const gh = getGhRunner();

  if (repoPath) {
    try {
      const exists = await git('git', [
        '-C',
        repoPath,
        'rev-parse',
        '--verify',
        `refs/heads/${branch.name}`,
      ]);
      out.present = exists.code === 0;
    } catch {
      // leave present=false
    }
    if (out.present) {
      try {
        const lc = await git('git', [
          '-C',
          repoPath,
          'log',
          '-1',
          '--format=%cI',
          branch.name,
        ]);
        if (lc.code === 0) {
          const s = lc.stdout.trim();
          out.last_commit_iso = s.length > 0 ? s : null;
        }
      } catch {
        // skip
      }
      for (const base of ['main', 'master']) {
        try {
          const verify = await git('git', [
            '-C',
            repoPath,
            'rev-parse',
            '--verify',
            `refs/remotes/origin/${base}`,
          ]);
          if (verify.code !== 0) continue;
          const counts = await git('git', [
            '-C',
            repoPath,
            'rev-list',
            '--left-right',
            '--count',
            `origin/${base}...${branch.name}`,
          ]);
          if (counts.code === 0) {
            const parts = counts.stdout.trim().split(/\s+/);
            if (parts.length === 2) {
              const b = Number(parts[0]);
              const a = Number(parts[1]);
              if (Number.isFinite(a) && Number.isFinite(b)) {
                out.ahead = a;
                out.behind = b;
              }
            }
          }
          break;
        } catch {
          // continue / give up
        }
      }
    }
  }

  try {
    const orgRepo = await resolveOrgRepo(branch.repo);
    if (orgRepo) {
      const res = await gh('gh', [
        'pr',
        'list',
        '--head',
        branch.name,
        '--repo',
        orgRepo,
        '--json',
        'number,state,title,url,statusCheckRollup',
        '--limit',
        '1',
      ]);
      if (res.code === 0) {
        const parsed = JSON.parse(res.stdout) as Array<{
          number?: number;
          state?: string;
          title?: string;
          url?: string;
          statusCheckRollup?: Array<{ conclusion?: string; state?: string }>;
        }>;
        if (Array.isArray(parsed) && parsed.length > 0) {
          const first = parsed[0]!;
          if (
            typeof first.number === 'number' &&
            typeof first.state === 'string' &&
            typeof first.title === 'string' &&
            typeof first.url === 'string'
          ) {
            const rollup = first.statusCheckRollup ?? [];
            let pass = 0;
            let fail = 0;
            let pending = 0;
            for (const entry of rollup) {
              const tag = (entry.conclusion ?? entry.state ?? '').toUpperCase();
              if (tag === 'SUCCESS') pass++;
              else if (
                tag === 'FAILURE' ||
                tag === 'CANCELLED' ||
                tag === 'TIMED_OUT'
              )
                fail++;
              else pending++;
            }
            let checks: string | undefined;
            if (rollup.length > 0) {
              if (fail > 0) checks = `fail (${fail}/${rollup.length})`;
              else if (pending > 0) checks = `pending (${pending}/${rollup.length})`;
              else checks = `pass (${pass}/${rollup.length})`;
            }
            out.pr = {
              number: first.number,
              state: first.state,
              title: first.title,
              url: first.url,
              ...(checks ? { checks } : {}),
            };
          }
        }
      }
    }
  } catch {
    // PR lookup is best-effort; leave out.pr as null.
  }

  return out;
}

function endedDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Sessions on a non-canonical track that ended after the narrative session
 * (the one rendered in `# Last session`).
 *
 * These ran alongside the mainline thread, so they're worth surfacing — but
 * only as pointers: full bodies would crowd out the mainline context. The
 * narrative session itself is excluded so it isn't both the mainline block
 * and a parallel pointer (matters when it was chosen via the no-canonical
 * fallback, since it's then a non-canonical session too).
 */
function selectParallelSessions(
  sessions: LoadedSession[],
  narrativeSession: LoadedSession | undefined,
): LoadedSession[] {
  if (!narrativeSession) return [];
  const cutoff = new Date(narrativeSession.frontmatter.ended).getTime();
  return sessions.filter(
    (s) =>
      s !== narrativeSession &&
      s.frontmatter.track !== 'canonical' &&
      new Date(s.frontmatter.ended).getTime() > cutoff,
  );
}

function renderParallelSessions(sessions: LoadedSession[]): string | null {
  if (sessions.length === 0) return null;
  const lines = sessions.map((s) => {
    const { ended, session_id, track } = s.frontmatter;
    const summary = firstLine(s.body) ?? '_(empty session body)_';
    return `- ${endedDate(ended)} (${track}, ${session_id}) — ${summary}`;
  });
  return `# Parallel sessions since then\n${lines.join('\n')}`;
}

const MS_PER_MINUTE = 60_000;

/**
 * Short elapsed form for sibling sessions ("just started", "12m", "2h 5m").
 *
 * `formatTimeSince` is the house helper for everything else in this file, but
 * its floor is one hour ("just now"), and sibling sessions are minutes old
 * almost by definition — the whole point is that the other one is *still
 * running*. Rendering every one of them as "just now" would erase the only
 * ordering signal the operator has for deciding which session started first.
 */
export function formatElapsedShort(from: Date, now: Date): string {
  const diffMs = now.getTime() - from.getTime();
  if (!Number.isFinite(diffMs) || diffMs < MS_PER_MINUTE) return 'just started';
  const minutes = Math.floor(diffMs / MS_PER_MINUTE);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h ago` : `${hours}h ${rest}m ago`;
}

/**
 * Whether one of the initiative's push channels is agent-chat.
 *
 * Targets arrive in the three shapes `buildChannelArgs` accepts — a bare server
 * name, `server:<name>`, `plugin:<name>@<marketplace>` — so the name is matched
 * after stripping the prefix and any marketplace suffix.
 */
function hasAgentChatChannel(brief: BriefFrontmatter): boolean {
  return (brief.channels ?? []).some((raw) => {
    const name = raw.replace(/^(?:server|plugin):/, '').split('@')[0] ?? '';
    return name === 'agent-chat';
  });
}

/**
 * One line per sibling, with confidence wording matched to the lease mode.
 *
 * The distinction is the whole point of having two modes: a `launcher` lease
 * names a process we just signalled, so it can be stated as fact, while a
 * `oneshot` lease is a TTL guess about a process that left no handle behind.
 * Rendering the guess in the same voice as the fact would train the reader to
 * discount both.
 */
function renderSiblingLine(sibling: SiblingSession, now: Date): string {
  const elapsed = formatElapsedShort(new Date(sibling.started), now);
  const where = `in \`${sibling.cwd}\``;
  if (sibling.mode === 'launcher') {
    const pid = sibling.pid === undefined ? '' : ` (pid ${sibling.pid})`;
    return `- started ${elapsed} ${where} — launched via \`aw\`, process still running${pid}.`;
  }
  return `- bootstrapped ${elapsed} ${where} — no live process to confirm, so it may have already exited.`;
}

const SIBLING_HEADING = '# Another session may already be live on this initiative';

/**
 * Warn, at t=0, that this may be the second session on the same initiative.
 *
 * Pure: the probe happens in `assembleBootstrap`. Renders nothing when there
 * are no siblings — with an empty list the prompt must be byte-identical to one
 * assembled without this feature at all.
 */
export function renderSiblingSessions(
  siblings: SiblingSession[],
  brief: BriefFrontmatter,
  topTaskTitle: string | undefined,
  now: Date,
): string {
  if (siblings.length === 0) return '';
  const lines = siblings.map((s) => renderSiblingLine(s, now));
  const topTask = topTaskTitle ? ` ("${topTaskTitle}")` : '';
  lines.push(
    `Before starting the top task${topTask}, ask the user which session owns it. ` +
      'If this is the second session, take distinct scope and record it with ' +
      '`active-work wrap --track adhoc` — not `canonical`, which would bury the ' +
      "other session's mainline thread in the next bootstrap.",
  );
  if (hasAgentChatChannel(brief)) {
    lines.push(
      'This initiative carries an agent-chat channel: register under a name that ' +
        'distinguishes you from the other session and coordinate scope there.',
    );
  }
  return `${SIBLING_HEADING}\n${lines.join('\n')}`;
}

/**
 * Surface a non-`focused` initiative state.
 *
 * Bootstrap otherwise reads identically for a paused initiative and a focused
 * one, so a session resumed on a backburnered or paused workstream picks up its
 * top task and starts executing — exactly the thing pausing it was meant to
 * stop. `restart_trigger` is included because it is the condition the operator
 * wrote down as "what would make this current again", and it is the only way
 * the session can tell whether resuming is actually warranted.
 */
function renderBriefState(brief: BriefFrontmatter, now: Date): string | null {
  if (brief.state === 'focused') return null;
  const lines: string[] = [];
  if (brief.paused_since) {
    const since = formatTimeSince(new Date(brief.paused_since), now);
    lines.push(`Paused since ${brief.paused_since} (${since}).`);
  }
  if (brief.restart_trigger) {
    lines.push(`Restart trigger: ${brief.restart_trigger}`);
  }
  lines.push(
    `This initiative is \`${brief.state}\`, not \`focused\` — confirm with the user before treating its tasks as current work.`,
  );
  return `# Initiative state: ${brief.state}\n${lines.join('\n')}`;
}

async function loadBrief(
  initiativeDir: string,
  slug: string,
): Promise<{ frontmatter: BriefFrontmatter; body: string }> {
  const briefPath = path.join(initiativeDir, 'brief.md');
  try {
    return await readMarkdownWithSchema(briefPath, BriefFrontmatterSchema);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new NotFoundError(
      `Initiative '${slug}' has no readable brief.md (${reason})`,
    );
  }
}

/**
 * Build the bootstrap prompt for `slug`.
 *
 * The prompt is composed entirely from files under the initiative directory;
 * missing artifacts (no sessions yet, no open tasks, no PRs) degrade
 * gracefully to omitted or "none" sections.
 */
export async function assembleBootstrap(
  input: BootstrapInput,
): Promise<BootstrapOutput> {
  const {
    activeRoot,
    slug,
    now = new Date(),
    topNTasks = DEFAULT_TOP_N_TASKS,
    recentlyDoneDays = DEFAULT_RECENTLY_DONE_DAYS,
    includeLiveStatus = true,
    liveStatusFetcher,
    archivedTaskIds,
    adhoc = false,
    detectSiblings = true,
    siblingProbe = readLiveLeases,
    ownLeaseId,
  } = input;

  const initiativeDir = path.join(activeRoot, slug);
  const { frontmatter: brief, body: briefBody } = await loadBrief(
    initiativeDir,
    slug,
  );

  const [loaded, loadedTasks, loadedArtifacts, notes] = await Promise.all([
    loadSessionsNewestFirst(initiativeDir),
    loadTasks(initiativeDir),
    loadArtifacts(initiativeDir),
    loadNotesFromDir(initiativeDir),
  ]);
  const { sessions, malformed } = loaded;
  const { tasks, malformed: malformedTasks } = loadedTasks;
  const { artifacts, error: artifactsError } = loadedArtifacts;

  // `mergedPrs` is deliberately unsupplied: derivation must stay offline
  // because bootstrap runs it on every launch.
  const openLoops = deriveOpenLoopsFrom(loaded, { now, tasks });
  const resolvedLoops = deriveResolvedLoopsFrom(loaded, { now, tasks });

  const latestCanonical = sessions.find((s) => s.frontmatter.track === 'canonical');
  // No canonical session recorded for this initiative — fall back to the
  // newest session of any track rather than reporting "no sessions" when
  // sidecar/adhoc sessions exist (AW-42).
  const narrativeSession = latestCanonical ?? sessions[0];
  const usedFallbackTrack = !latestCanonical && narrativeSession !== undefined;
  const parallelBody = renderParallelSessions(
    selectParallelSessions(sessions, narrativeSession),
  );
  const briefExcerpt =
    truncateLines(
      briefBody,
      BRIEF_BODY_MAX_LINES,
      path.join(initiativeDir, 'brief.md'),
    ) || '_(no brief body)_';
  const { body: tasksBody, count: openTaskCount } = renderTopTasks(tasks, topNTasks, slug);
  const { body: recentlyDoneBody, count: recentlyDoneCount } = renderRecentlyDone(
    tasks,
    recentlyDoneDays,
    now,
    slug,
  );
  let artifactsBody: string | null = null;
  if (!includeLiveStatus || artifacts.branches.length === 0) {
    artifactsBody = renderStaticArtifacts(artifacts, slug);
  } else {
    const fetcher = liveStatusFetcher ?? defaultLiveStatusFetcher;
    try {
      const statuses = await fetcher(artifacts.branches);
      artifactsBody = renderLiveArtifacts(artifacts, statuses, slug);
    } catch {
      // Live fetch failed entirely — degrade to static rendering.
      artifactsBody = renderStaticArtifacts(artifacts, slug);
    }
  }

  const timeSinceHuman = narrativeSession
    ? formatTimeSince(new Date(narrativeSession.frontmatter.ended), now)
    : undefined;

  // Fail open, exactly like the live-status fetcher above: a probe that throws
  // (unreadable lease dir, hostile permissions) degrades to "no siblings"
  // rather than costing the caller their whole bootstrap.
  let siblings: SiblingSession[] = [];
  if (detectSiblings) {
    try {
      siblings = await siblingProbe({
        activeRoot,
        slug,
        now,
        ...(ownLeaseId ? { excludeLeaseId: ownLeaseId } : {}),
      });
    } catch {
      siblings = [];
    }
  }
  const topTaskTitle = tasks
    .filter((t) => t.status === 'open')
    .sort(compareTasksByPriority)[0]?.title;

  const sections: string[] = [];
  sections.push(
    adhoc
      ? `Starting an ad-hoc session on \`${slug}\` (${brief.title}). This session is scoped to ad-hoc work related to this workstream — not necessarily its handoff or current top task. The context below is background so you're oriented; wait for the user to describe the specific ad-hoc task before acting.`
      : `Starting a session on \`${slug}\` (${brief.title}).`,
  );
  const siblingBody = renderSiblingSessions(siblings, brief, topTaskTitle, now);
  if (siblingBody) sections.push(siblingBody);
  const stateBody = renderBriefState(brief, now);
  if (stateBody) sections.push(stateBody);
  sections.push(`# Why we're doing this\n${briefExcerpt}`);
  sections.push(renderOpenLoops(openLoops, malformed, sessions[0]));

  const abandonedBody = renderAbandonedLoops(resolvedLoops, recentlyDoneDays);
  if (abandonedBody) sections.push(abandonedBody);

  if (narrativeSession) {
    const sessionExcerpt =
      truncateLines(
        narrativeSession.body,
        SESSION_BODY_MAX_LINES,
        path.join(initiativeDir, 'sessions', `${narrativeSession.sessionFile}.md`),
      ) || '_(empty session body)_';
    const ended = endedDate(narrativeSession.frontmatter.ended);
    // Label the heading with the track when it's not canonical, so a
    // fallback session (no canonical recorded yet) isn't mistaken for
    // mainline continuity.
    const trackLabel = usedFallbackTrack
      ? ` (${narrativeSession.frontmatter.track})`
      : '';
    sections.push(
      `# Last session${trackLabel} (${ended}, ${narrativeSession.frontmatter.session_id}) — ${timeSinceHuman}\n${sessionExcerpt}`,
    );
  } else {
    sections.push(`# Last session\nNo previous sessions recorded.`);
  }

  if (parallelBody) sections.push(parallelBody);

  sections.push(
    `# Tasks (top ${topNTasks} open by priority)${malformedTaskNote(malformedTasks)}\n${tasksBody}`,
  );

  if (recentlyDoneBody) {
    sections.push(
      `# Recently done (last ${recentlyDoneDays} days)\n${recentlyDoneBody}`,
    );
  }

  if (archivedTaskIds && archivedTaskIds.length > 0) {
    sections.push(
      `# Archived (housekeeping)\nMoved ${archivedTaskIds.length} stale done task(s) to tasks/archive/: ${archivedTaskIds.join(', ')}`,
    );
  }

  const notesBody = renderDurableNotes(notes, slug);
  if (notesBody) sections.push(notesBody);

  if (artifactsError) {
    const artifactsPath = path.join(initiativeDir, 'artifacts.yml');
    sections.push(
      `# Open artifacts\n_${artifactsPath} exists but could not be read (${artifactsError}). Branch and stash context is MISSING from this bootstrap — do not treat the working tree as clean. Run \`active-work doctor\`._`,
    );
  } else if (artifactsBody) {
    sections.push(`# Open artifacts\n${artifactsBody}`);
  }

  const bootstrapAt = nowIso();
  const todayStr = today();
  const contextLines = [`- Today: ${todayStr}`, `- Bootstrap: ${bootstrapAt}`];
  if (timeSinceHuman) {
    contextLines.push(`- Time since last session: ${timeSinceHuman}`);
  }
  sections.push(`# Context\n${contextLines.join('\n')}`);

  sections.push(
    adhoc
      ? `This is an ad-hoc session: treat the context above as background, not a directive. Do not assume we're continuing the top task or the handoff — the user will describe the specific ad-hoc task. Once they do, work it with the workstream context in mind. If it turns out to be substantive, still capture it via \`active-work task add\` / \`active-work wrap --track adhoc\`. The \`--track adhoc\` flag is required: this session runs alongside the mainline thread, and recording it as canonical would bury the real last session for the next bootstrap.`
      : renderClosingInstruction(openLoops),
  );

  const prompt = sections.join('\n\n') + '\n';

  const metadata: BootstrapMetadata = {
    slug,
    brief_title: brief.title,
    open_task_count: openTaskCount,
    open_loop_count: openLoops.length,
    recently_done_count: recentlyDoneCount,
    bootstrap_at: bootstrapAt,
  };
  if (narrativeSession) {
    metadata.last_session = {
      filename: `${narrativeSession.sessionFile}.md`,
      ended: narrativeSession.frontmatter.ended,
    };
  }
  if (timeSinceHuman) {
    metadata.time_since_last_session_human = timeSinceHuman;
  }
  if (siblings.length > 0) {
    metadata.sibling_sessions = siblings.length;
  }

  return { prompt, metadata };
}
