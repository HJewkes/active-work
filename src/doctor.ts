/**
 * `active-work doctor` — aggregate health checks for a local install (AW-4).
 *
 * Verifies the pieces `active-work setup` wires up: Node version, the active
 * root + schema version, the MCP daemon, Claude Code MCP registration, the
 * installed skill, and (if the platform supports it) daemon supervision.
 *
 * Every probe is injectable so the checks are unit-testable without a real
 * daemon, filesystem layout, or service manager.
 */
import { promises as fsp } from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import { getActiveRoot } from './utils/paths.js';
import { isProcessAlive, probeHealth, readPidFile, resolveDaemonPort } from './server/lifecycle.js';
import { getSupervisor } from './setup/supervision.js';
import { lintHashes, listInitiativeSlugs } from './lint/index.js';
import { loadTasks } from './lint/load-tasks.js';
import { loadNotesFromDir } from './notes/note-file.js';
import { NOTE_TITLE_MAX_LENGTH } from './schemas/note.js';
import {
  deriveOpenLoops,
  findSessionIssues,
  type DanglingKind,
  type DanglingResolve,
  type MalformedSession,
} from './sessions/open-loops.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DaemonProbe {
  running: boolean;
  healthy: boolean;
  port?: number;
  version?: string;
  pid?: number;
  /** True when `/health` answered but no PID file names the daemon. */
  orphaned?: boolean;
}

export interface DoctorDeps {
  fs?: typeof fsp;
  activeRoot?: string;
  homeDir?: string;
  /** Node version string like `process.version` (`v22.4.0`). */
  nodeVersion?: string;
  /** Minimum supported Node major (defaults to 22). */
  minNodeMajor?: number;
  /** Probe the daemon; defaults to reading the pid file + `/health`. */
  probeDaemon?: () => Promise<DaemonProbe>;
  /** Whether a supervisor already owns the daemon; null when unsupported. */
  supervisorActive?: () => Promise<{ kind: string; active: boolean } | null>;
}

/**
 * Probe by port alone, for when the PID file is absent or names a dead
 * process. A missing file used to read as "not running" outright, which is how
 * a live daemon whose file its predecessor clobbered became indistinguishable
 * from no daemon at all (AW-76). Something answering `/health` outranks the
 * bookkeeping, so adopt the pid/port/version it reports.
 */
async function probeByPort(port: number): Promise<DaemonProbe> {
  const health = await probeHealth(port);
  if (!health) return { running: false, healthy: false, port };
  return {
    running: true,
    healthy: true,
    orphaned: true,
    pid: health.pid,
    port: health.port,
    version: health.version,
  };
}

async function defaultProbeDaemon(): Promise<DaemonProbe> {
  const entry = await readPidFile();
  if (!entry) return probeByPort(resolveDaemonPort());
  if (!isProcessAlive(entry.pid)) {
    // A pre-meta pid file records port 0; fall back to where a daemon would be.
    return probeByPort(entry.meta.port || resolveDaemonPort());
  }
  const health = await probeHealth(entry.meta.port);
  if (health) {
    return {
      running: true,
      healthy: true,
      pid: health.pid,
      port: health.port,
      version: health.version,
    };
  }
  return {
    running: true,
    healthy: false,
    pid: entry.pid,
    port: entry.meta.port,
    version: entry.meta.version,
  };
}

async function defaultSupervisorActive(): Promise<{
  kind: string;
  active: boolean;
} | null> {
  const supervisor = getSupervisor();
  if (!supervisor) return null;
  return { kind: supervisor.kind, active: await supervisor.isActive({}) };
}

function parseMajor(version: string): number {
  const match = /^v?(\d+)\./.exec(version);
  return match ? Number(match[1]) : 0;
}

async function fileExists(fs: typeof fsp, target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// `setup` registers the server as `@hjewkes/active-work` (stdio), but users
// commonly wire it as `active-work` (http, pointed at the daemon). Accept
// either name.
const MCP_SERVER_NAMES = ['@hjewkes/active-work', 'active-work'];

async function readMcpRegistered(fs: typeof fsp, homeDir: string): Promise<boolean> {
  const configPath = nodePath.join(homeDir, '.claude.json');
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, unknown>;
    };
    const servers = parsed.mcpServers ?? {};
    return MCP_SERVER_NAMES.some((name) => Boolean(servers[name]));
  } catch {
    return false;
  }
}

async function checkNode(deps: DoctorDeps): Promise<DoctorCheck> {
  const version = deps.nodeVersion ?? process.version;
  const min = deps.minNodeMajor ?? 22;
  const major = parseMajor(version);
  if (major >= min) {
    return { name: 'node', status: 'ok', detail: `${version} (>= ${min})` };
  }
  return {
    name: 'node',
    status: 'fail',
    detail: `${version} is older than the required Node ${min}`,
  };
}

async function checkActiveRoot(deps: DoctorDeps): Promise<DoctorCheck> {
  const fs = deps.fs ?? fsp;
  const activeRoot = deps.activeRoot ?? getActiveRoot();
  if (!(await fileExists(fs, activeRoot))) {
    return {
      name: 'active-root',
      status: 'fail',
      detail: `${activeRoot} does not exist — run \`active-work setup\``,
    };
  }
  const schemaFile = nodePath.join(activeRoot, '.schema-version');
  if (!(await fileExists(fs, schemaFile))) {
    return {
      name: 'active-root',
      status: 'warn',
      detail: `${activeRoot} exists but has no .schema-version`,
    };
  }
  return { name: 'active-root', status: 'ok', detail: activeRoot };
}

async function checkDaemon(deps: DoctorDeps): Promise<DoctorCheck> {
  const probe = await (deps.probeDaemon ?? defaultProbeDaemon)();
  const where = `pid ${probe.pid ?? '?'}, port ${probe.port ?? '?'}, v${probe.version ?? '?'}`;
  if (probe.running && probe.healthy && probe.orphaned === true) {
    // Answering but unfiled: `mcp stop`/`mcp restart` key off the PID file and
    // will not find it, so this needs saying even though the daemon is fine.
    return {
      name: 'daemon',
      status: 'warn',
      detail:
        `running (${where}) but no pid file — \`mcp stop\`/\`mcp restart\` ` +
        'cannot see it; restart it through your supervisor to re-file it',
    };
  }
  if (probe.running && probe.healthy) {
    return { name: 'daemon', status: 'ok', detail: `running (${where})` };
  }
  if (probe.running && !probe.healthy) {
    return {
      name: 'daemon',
      status: 'warn',
      detail: `pid ${probe.pid ?? '?'} is alive but /health did not answer`,
    };
  }
  // Name the port we probed: a daemon started on a non-default `--port` with
  // no pid file to record it is invisible here, and that beats implying none.
  const probed = probe.port === undefined ? '' : ` (nothing answered port ${probe.port})`;
  return {
    name: 'daemon',
    status: 'warn',
    detail: `not running${probed} — start it with \`active-work mcp serve --detach\``,
  };
}

async function checkMcp(deps: DoctorDeps): Promise<DoctorCheck> {
  const fs = deps.fs ?? fsp;
  const homeDir = deps.homeDir ?? os.homedir();
  if (await readMcpRegistered(fs, homeDir)) {
    return { name: 'mcp-registration', status: 'ok', detail: 'registered in ~/.claude.json' };
  }
  return {
    name: 'mcp-registration',
    status: 'warn',
    detail: 'not registered with Claude Code — run `active-work setup`',
  };
}

async function checkSkill(deps: DoctorDeps): Promise<DoctorCheck> {
  const fs = deps.fs ?? fsp;
  const homeDir = deps.homeDir ?? os.homedir();
  const skill = nodePath.join(homeDir, '.claude', 'skills', 'active-work', 'SKILL.md');
  if (await fileExists(fs, skill)) {
    return { name: 'skill', status: 'ok', detail: skill };
  }
  return {
    name: 'skill',
    status: 'warn',
    detail: 'skill not installed in ~/.claude/skills — run `active-work setup`',
  };
}

async function checkSupervisor(deps: DoctorDeps): Promise<DoctorCheck> {
  const result = await (deps.supervisorActive ?? defaultSupervisorActive)();
  if (!result) {
    return {
      name: 'supervision',
      status: 'ok',
      detail: `no supervisor integration for ${process.platform} (optional)`,
    };
  }
  if (result.active) {
    return { name: 'supervision', status: 'ok', detail: `${result.kind} agent is loaded` };
  }
  return {
    name: 'supervision',
    status: 'warn',
    detail: `${result.kind} supervisor not active — re-run \`active-work setup\` to enable`,
  };
}

/** Each rejection kind has a different remedy, so each gets its own sentence. */
const DANGLING_REMEDY: Record<DanglingKind, string> = {
  missing: 'no such next_step — fix or drop the ref',
  'not-prior':
    'target session ended at or after the resolver, so the close was rejected — re-file the resolve from a later session',
  self: 'a session cannot resolve its own loop — resolve it from a later session',
};

function describeDangling(kind: DanglingKind, entries: string[]): string {
  return `${DANGLING_REMEDY[kind]}: ${entries.join(', ')}`;
}

function openLoopsCheck(byKind: Map<DanglingKind, string[]>): DoctorCheck {
  if (byKind.size === 0) {
    return { name: 'open-loops', status: 'ok', detail: 'no dangling resolves' };
  }
  const parts = [...byKind.entries()].map(([kind, refs]) => describeDangling(kind, refs));
  return { name: 'open-loops', status: 'warn', detail: parts.join('; ') };
}

function taskRefsCheck(entries: string[]): DoctorCheck {
  if (entries.length === 0) {
    return { name: 'task-refs', status: 'ok', detail: 'every next_steps task ref resolves' };
  }
  return {
    name: 'task-refs',
    status: 'warn',
    // Mirrors dangling resolves, but for the other half of the ledger: unlike
    // a bad `resolves` ref, a bad `next_steps` ref is never rejected — the
    // loop just stays open and silent forever.
    detail: `next_steps reference a task that does not exist: ${entries.join('; ')}`,
  };
}

/** `kind: 'task'` open loops whose `ref` names no task in this initiative. */
async function collectBadTaskRefs(
  slug: string,
  initiativeDir: string,
  now: Date,
): Promise<string[]> {
  const tasks = await loadTasks(initiativeDir);
  const taskIds = new Set(tasks.map((t) => t.id));
  const loops = await deriveOpenLoops(initiativeDir, { now, tasks });
  return loops
    .filter((loop) => loop.kind === 'task' && loop.targetRef !== undefined)
    .filter((loop) => !taskIds.has(loop.targetRef as string))
    .map(
      (loop) =>
        `${slug}/sessions/${loop.sessionFile}.md ${loop.ref} -> ${loop.targetRef} (no such task)`,
    );
}

function sessionFilesCheck(malformed: string[]): DoctorCheck {
  if (malformed.length === 0) {
    return { name: 'session-files', status: 'ok', detail: 'every session file parses' };
  }
  return {
    name: 'session-files',
    status: 'warn',
    // These files are invisible in the ledger: their loops vanish and the loops
    // they closed come back. Only this check can surface them.
    detail: `${malformed.length} session file(s) unreadable — their loops are missing from the ledger: ${malformed.join('; ')}`,
  };
}

/**
 * Walk every initiative once and report both integrity signals derivation
 * cannot express in the ledger: rejected `resolves` and unparseable sessions.
 */
async function checkSessions(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const activeRoot = deps.activeRoot ?? getActiveRoot();
  const slugs = await listInitiativeSlugs(activeRoot);
  const byKind = new Map<DanglingKind, string[]>();
  const malformed: string[] = [];
  const badTaskRefs: string[] = [];
  const now = new Date();
  for (const slug of slugs) {
    const initiativeDir = nodePath.join(activeRoot, slug);
    const issues = await findSessionIssues(initiativeDir);
    for (const entry of issues.dangling) collectDangling(byKind, slug, entry);
    for (const entry of issues.malformed) malformed.push(describeMalformed(slug, entry));
    badTaskRefs.push(...(await collectBadTaskRefs(slug, initiativeDir, now)));
  }
  return [openLoopsCheck(byKind), sessionFilesCheck(malformed), taskRefsCheck(badTaskRefs)];
}

function collectDangling(
  byKind: Map<DanglingKind, string[]>,
  slug: string,
  entry: DanglingResolve,
): void {
  const line = `${slug}/sessions/${entry.sessionFile}.md resolves ${entry.ref}`;
  const existing = byKind.get(entry.kind);
  if (existing) existing.push(line);
  else byKind.set(entry.kind, [line]);
}

function describeMalformed(slug: string, entry: MalformedSession): string {
  return `${slug}/sessions/${entry.file} (${entry.reason})`;
}

function noteTitlesCheck(entries: string[]): DoctorCheck {
  if (entries.length === 0) {
    return {
      name: 'note-titles',
      status: 'ok',
      detail: `every note title is at most ${NOTE_TITLE_MAX_LENGTH} characters`,
    };
  }
  return {
    name: 'note-titles',
    status: 'warn',
    // `note.add` rejects these now, so anything here predates the bound: the
    // read path stays permissive on purpose, and this is the only place those
    // notes get named.
    detail:
      `note title longer than ${NOTE_TITLE_MAX_LENGTH} characters ` +
      `(rename the title in the file's frontmatter): ${entries.join('; ')}`,
  };
}

/** Notes whose stored title exceeds the write-time bound. */
async function checkNoteTitles(deps: DoctorDeps): Promise<DoctorCheck> {
  const activeRoot = deps.activeRoot ?? getActiveRoot();
  const slugs = await listInitiativeSlugs(activeRoot);
  const overlong: string[] = [];
  for (const slug of slugs) {
    const { notes } = await loadNotesFromDir(nodePath.join(activeRoot, slug));
    for (const note of notes) {
      if (note.frontmatter.title.length <= NOTE_TITLE_MAX_LENGTH) continue;
      overlong.push(
        `${slug}/sources/notes/${note.filename} (${note.frontmatter.title.length} chars)`,
      );
    }
  }
  return noteTitlesCheck(overlong);
}

function artifactHashesCheck(drifted: string[]): DoctorCheck {
  if (drifted.length === 0) {
    return {
      name: 'artifact-hashes',
      status: 'ok',
      detail: 'no hand-edits detected in tracked structured artifacts',
    };
  }
  return {
    name: 'artifact-hashes',
    status: 'warn',
    detail: `hand-edited outside active-work: ${drifted.join('; ')}`,
  };
}

/** Structured artifacts (tasks/*.yml, artifacts.yml, brief.md) whose content no longer matches the last CLI write (AW-66). */
async function checkArtifactHashes(deps: DoctorDeps): Promise<DoctorCheck> {
  const activeRoot = deps.activeRoot ?? getActiveRoot();
  const slugs = await listInitiativeSlugs(activeRoot);
  const drifted: string[] = [];
  for (const slug of slugs) {
    const findings = await lintHashes(slug, nodePath.join(activeRoot, slug));
    drifted.push(...findings.map((f) => `${slug}/${f.file}`));
  }
  return artifactHashesCheck(drifted);
}

/** Run all health checks and return a report. `ok` is false iff any check failed. */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const [installChecks, sessionChecks, noteTitles, artifactHashes] = await Promise.all([
    Promise.all([
      checkNode(deps),
      checkActiveRoot(deps),
      checkDaemon(deps),
      checkMcp(deps),
      checkSkill(deps),
      checkSupervisor(deps),
    ]),
    checkSessions(deps),
    checkNoteTitles(deps),
    checkArtifactHashes(deps),
  ]);
  const checks = [...installChecks, ...sessionChecks, noteTitles, artifactHashes];
  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}
