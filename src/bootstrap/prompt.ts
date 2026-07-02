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
import {
  ArtifactsSchema,
  type Artifacts,
  type BranchEntry,
} from '../schemas/artifacts.js';
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

const LIVE_RENDER_LIMIT = 10;

function renderStaticBranchLine(branch: BranchEntry): string {
  const head = `- ${branch.name} (${branch.repo})`;
  return branch.note ? `${head} — ${branch.note}` : head;
}

function renderLiveBranchLine(status: LiveBranchStatus): string {
  const parts: string[] = [`- ${status.name} (${status.repo})`];
  if (!status.present) {
    parts.push('[missing locally]');
  } else if (status.ahead !== null && status.behind !== null) {
    parts.push(`+${status.ahead}/-${status.behind}`);
  }
  if (status.pr) {
    const checks = status.pr.checks ? ` ${status.pr.checks}` : '';
    parts.push(`PR #${status.pr.number} ${status.pr.state}${checks}`);
  }
  let line = parts.join(' ');
  if (status.note) line += ` — ${status.note}`;
  return line;
}

function renderStashes(artifacts: Artifacts): string | null {
  if (artifacts.stashes.length === 0) return null;
  return artifacts.stashes
    .map((s) => `- ${s.repo}: ${s.label}${s.sha ? ` (${s.sha.slice(0, 12)})` : ''}`)
    .join('\n');
}

function renderStaticArtifacts(artifacts: Artifacts): string | null {
  const sections: string[] = [];
  if (artifacts.branches.length > 0) {
    const branchLines = artifacts.branches.map(renderStaticBranchLine).join('\n');
    sections.push(`Branches:\n${branchLines}`);
  }
  const stashBody = renderStashes(artifacts);
  if (stashBody) sections.push(`Stashes:\n${stashBody}`);
  return sections.length > 0 ? sections.join('\n\n') : null;
}

function renderLiveArtifacts(
  artifacts: Artifacts,
  statuses: LiveBranchStatus[],
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
  let artifactsBody: string | null = null;
  if (!includeLiveStatus || artifacts.branches.length === 0) {
    artifactsBody = renderStaticArtifacts(artifacts);
  } else {
    const fetcher = liveStatusFetcher ?? defaultLiveStatusFetcher;
    try {
      const statuses = await fetcher(artifacts.branches);
      artifactsBody = renderLiveArtifacts(artifacts, statuses);
    } catch {
      // Live fetch failed entirely — degrade to static rendering.
      artifactsBody = renderStaticArtifacts(artifacts);
    }
  }

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

  if (archivedTaskIds && archivedTaskIds.length > 0) {
    sections.push(
      `# Archived (housekeeping)\nMoved ${archivedTaskIds.length} stale done task(s) to tasks/archive/: ${archivedTaskIds.join(', ')}`,
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
