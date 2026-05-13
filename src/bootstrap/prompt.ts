import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BriefFrontmatterSchema,
  type BriefFrontmatter,
} from '../schemas/brief.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import {
  SessionFrontmatterSchema,
  type SessionFrontmatter,
} from '../schemas/session.js';
import { ArtifactsSchema, type Artifacts } from '../schemas/artifacts.js';
import { readYaml } from '../utils/yaml-io.js';
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
}

export interface BootstrapMetadata {
  slug: string;
  brief_title: string;
  last_session?: { filename: string; ended: string };
  time_since_last_session_human?: string;
  open_task_count: number;
  recently_done_count: number;
  bootstrap_at: string;
}

export interface BootstrapOutput {
  prompt: string;
  metadata: BootstrapMetadata;
}

interface LoadedSession {
  filename: string;
  frontmatter: SessionFrontmatter;
  body: string;
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
 * Read all canonical sessions for an initiative, newest-`ended` first.
 *
 * Sidecar tracks and files that fail to parse are skipped silently — the
 * bootstrap is best-effort and must never crash on a malformed session.
 */
async function loadCanonicalSessions(
  initiativeDir: string,
): Promise<LoadedSession[]> {
  const sessionsDir = path.join(initiativeDir, 'sessions');
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }
  const mdFiles = entries.filter((n) => n.endsWith('.md'));
  const loaded: LoadedSession[] = [];
  for (const filename of mdFiles) {
    const fullPath = path.join(sessionsDir, filename);
    try {
      const { frontmatter, body } = await readMarkdownWithSchema(
        fullPath,
        SessionFrontmatterSchema,
      );
      if (frontmatter.track === 'canonical') {
        loaded.push({ filename, frontmatter, body });
      }
    } catch {
      // Skip malformed sessions; bootstrap should remain best-effort.
    }
  }
  loaded.sort(
    (a, b) =>
      new Date(b.frontmatter.ended).getTime() -
      new Date(a.frontmatter.ended).getTime(),
  );
  return loaded;
}

async function loadTasks(initiativeDir: string): Promise<Task[]> {
  const tasksDir = path.join(initiativeDir, 'tasks');
  let entries: string[];
  try {
    entries = await fs.readdir(tasksDir);
  } catch {
    return [];
  }
  const ymlFiles = entries.filter(
    (n) => n.endsWith('.yml') || n.endsWith('.yaml'),
  );
  const tasks: Task[] = [];
  for (const filename of ymlFiles) {
    const fullPath = path.join(tasksDir, filename);
    try {
      tasks.push(await readYaml(fullPath, TaskSchema));
    } catch {
      // Skip malformed task files.
    }
  }
  return tasks;
}

async function loadArtifacts(initiativeDir: string): Promise<Artifacts> {
  const artifactsPath = path.join(initiativeDir, 'artifacts.yml');
  try {
    return await readYaml(artifactsPath, ArtifactsSchema);
  } catch {
    return { branches: [], stashes: [] };
  }
}

function truncateLines(body: string, max: number): string {
  const lines = body.split('\n');
  const trimmed: string[] = [];
  let count = 0;
  for (const line of lines) {
    if (count >= max) break;
    trimmed.push(line);
    if (line.trim().length > 0) count++;
  }
  return trimmed.join('\n').replace(/\s+$/, '');
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

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function renderTaskLine(idx: number, task: Task): string {
  const meta: string[] = [`priority ${task.priority}`];
  if (task.severity) meta.push(`severity ${task.severity}`);
  if (task.estimate !== undefined) meta.push(`est ${task.estimate}`);
  let line = `${idx}. [${task.id}] (${meta.join(', ')}) ${task.title}`;
  const note = firstLine(task.notes);
  if (note) line += `\n   ${note}`;
  return line;
}

function renderTopTasks(tasks: Task[], topN: number): { body: string; count: number } {
  const openTasks = tasks
    .filter((t) => t.status === 'open')
    .sort(compareTasksByPriority);
  if (openTasks.length === 0) {
    return { body: '_No open tasks._', count: 0 };
  }
  const shown = openTasks.slice(0, topN);
  return {
    body: shown.map((task, i) => renderTaskLine(i + 1, task)).join('\n'),
    count: openTasks.length,
  };
}

function renderRecentlyDone(
  tasks: Task[],
  windowDays: number,
  now: Date,
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
  const body = done.map((t) => `- [${t.id}] ${t.title} — done ${t.done_at}`).join('\n');
  return { body, count: done.length };
}

function renderArtifacts(artifacts: Artifacts): { body: string | null } {
  const sections: string[] = [];
  if (artifacts.branches.length > 0) {
    const lines = artifacts.branches
      .map((b) => (b.note ? `${b.name} (${b.repo}) — ${b.note}` : `${b.name} (${b.repo})`))
      .join('\n- ');
    sections.push(`Branches:\n- ${lines}`);
  }
  if (artifacts.stashes.length > 0) {
    const lines = artifacts.stashes
      .map((s) => `${s.repo}: ${s.label}${s.sha ? ` (${s.sha.slice(0, 12)})` : ''}`)
      .join('\n- ');
    sections.push(`Stashes:\n- ${lines}`);
  }
  return {
    body: sections.length > 0 ? sections.join('\n\n') : null,
  };
}

function endedDate(iso: string): string {
  return iso.slice(0, 10);
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
  } = input;

  const initiativeDir = path.join(activeRoot, slug);
  const { frontmatter: brief, body: briefBody } = await loadBrief(
    initiativeDir,
    slug,
  );

  const [sessions, tasks, artifacts] = await Promise.all([
    loadCanonicalSessions(initiativeDir),
    loadTasks(initiativeDir),
    loadArtifacts(initiativeDir),
  ]);

  const latestSession = sessions[0];
  const briefExcerpt = truncateLines(briefBody, BRIEF_BODY_MAX_LINES) || '_(no brief body)_';
  const { body: tasksBody, count: openTaskCount } = renderTopTasks(tasks, topNTasks);
  const { body: recentlyDoneBody, count: recentlyDoneCount } = renderRecentlyDone(
    tasks,
    recentlyDoneDays,
    now,
  );
  const { body: artifactsBody } = renderArtifacts(artifacts);

  const timeSinceHuman = latestSession
    ? formatTimeSince(new Date(latestSession.frontmatter.ended), now)
    : undefined;

  const sections: string[] = [];
  sections.push(`Starting a session on \`${slug}\` (${brief.title}).`);
  sections.push(`# Why we're doing this\n${briefExcerpt}`);

  if (latestSession) {
    const sessionExcerpt =
      truncateLines(latestSession.body, SESSION_BODY_MAX_LINES) ||
      '_(empty session body)_';
    const ended = endedDate(latestSession.frontmatter.ended);
    sections.push(
      `# Last session (${ended}, ${latestSession.frontmatter.session_id}) — ${timeSinceHuman}\n${sessionExcerpt}`,
    );
  } else {
    sections.push(`# Last session\nNo previous sessions recorded.`);
  }

  sections.push(`# Tasks (top ${topNTasks} open by priority)\n${tasksBody}`);

  if (recentlyDoneBody) {
    sections.push(
      `# Recently done (last ${recentlyDoneDays} days)\n${recentlyDoneBody}`,
    );
  }

  if (artifactsBody) {
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
    `Work the top task unless redirected. Update tasks via \`active-work task done\` and capture the session via \`active-work session record\` when wrapping up.`,
  );

  const prompt = sections.join('\n\n') + '\n';

  const metadata: BootstrapMetadata = {
    slug,
    brief_title: brief.title,
    open_task_count: openTaskCount,
    recently_done_count: recentlyDoneCount,
    bootstrap_at: bootstrapAt,
  };
  if (latestSession) {
    metadata.last_session = {
      filename: latestSession.filename,
      ended: latestSession.frontmatter.ended,
    };
  }
  if (timeSinceHuman) {
    metadata.time_since_last_session_human = timeSinceHuman;
  }

  return { prompt, metadata };
}
