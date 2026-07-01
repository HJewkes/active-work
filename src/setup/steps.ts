/**
 * Individual setup steps used by `active-work setup` and `active-work uninstall`.
 *
 * Each step is a small async function that accepts a `SetupDeps` bag
 * (filesystem, spawn, prompts, paths). Tests inject stubs; production
 * callers let everything default. Steps never throw on failure — they
 * return a tagged result so the orchestrator can short-circuit cleanly.
 */
import { promises as fsp, existsSync } from 'node:fs';
import nodePath from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as clackPrompts from '@clack/prompts';
import { ensureSchemaVersion } from '../schemas/state.js';
import {
  getActiveRoot,
  getStateRoot,
  getConfigRoot,
} from '../utils/paths.js';
import {
  STEP_SUPERVISION,
  UNIT_NAME,
  stepInstallSupervision,
  uninstallSupervision,
  isUnitActive,
} from './supervision-systemd.js';

function findRepoRoot(): string {
  let cursor = nodePath.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(nodePath.join(cursor, 'package.json'))) return cursor;
    const parent = nodePath.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  // Fallback: two up from current file (covers source layout).
  return nodePath.resolve(
    nodePath.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
}

export interface StepPaths {
  activeRoot: string;
  stateRoot: string;
  configRoot: string;
  homeDir: string;
}

export interface SetupDeps {
  fs?: typeof fsp;
  spawn?: typeof nodeSpawn;
  prompts?: typeof clackPrompts;
  paths?: StepPaths;
  /** When true, skip interactive prompts and assume yes. */
  yes?: boolean;
  /** When true, allow overwrite of existing user files. */
  update?: boolean;
  /** Optional override for repo root (where bundled skill lives). */
  repoRoot?: string;
  /** Optional override for the CLI entrypoint (for spawn calls). */
  cliEntry?: string;
}

export interface StepOk {
  ok: true;
  name: string;
  done: boolean;
  message: string;
}

export interface StepErr {
  ok: false;
  name: string;
  error: string;
}

export type StepResult = StepOk | StepErr;

/** Resolve every defaultable dep so each step has a complete bag. */
function resolveDeps(deps: SetupDeps): Required<
  Omit<SetupDeps, 'yes' | 'update' | 'repoRoot' | 'cliEntry'>
> & {
  yes: boolean;
  update: boolean;
  repoRoot: string;
  cliEntry: string;
} {
  const fs = deps.fs ?? fsp;
  const spawn = deps.spawn ?? nodeSpawn;
  const prompts = deps.prompts ?? clackPrompts;
  const homeDir = deps.paths?.homeDir ?? os.homedir();
  const paths: StepPaths = deps.paths ?? {
    activeRoot: getActiveRoot(),
    stateRoot: getStateRoot(),
    configRoot: getConfigRoot(),
    homeDir,
  };
  // The bundled skill lives at `<repoRoot>/skill`. Find it by walking up
  // from this module until we hit a directory containing `package.json`
  // — works both for source (`src/setup/steps.ts`) and bundled
  // (`dist/cli.js`) layouts.
  const repoRoot = deps.repoRoot ?? findRepoRoot();
  const cliEntry = deps.cliEntry ?? process.argv[1] ?? 'active-work';
  return {
    fs,
    spawn,
    prompts,
    paths,
    yes: deps.yes ?? false,
    update: deps.update ?? false,
    repoRoot,
    cliEntry,
  };
}

const STEP_CHECK_NODE = 'check-node';
const STEP_CREATE_ACTIVE = 'create-active-root';
const STEP_SCHEMA = 'write-schema-version';
const STEP_CONFIG = 'write-config-stub';
const STEP_SKILL = 'install-skill';
const STEP_MCP = 'register-mcp';
const STEP_DAEMON = 'start-daemon';
const STEP_INGEST = 'ingestion';

export const STEP_NAMES = {
  CHECK_NODE: STEP_CHECK_NODE,
  CREATE_ACTIVE: STEP_CREATE_ACTIVE,
  SCHEMA: STEP_SCHEMA,
  CONFIG: STEP_CONFIG,
  SKILL: STEP_SKILL,
  MCP: STEP_MCP,
  SUPERVISION: STEP_SUPERVISION,
  DAEMON: STEP_DAEMON,
  INGEST: STEP_INGEST,
} as const;

const MIN_NODE_MAJOR = 22;

function parseNodeMajor(version: string): number {
  const cleaned = version.startsWith('v') ? version.slice(1) : version;
  const major = Number(cleaned.split('.')[0]);
  return Number.isFinite(major) ? major : 0;
}

export async function stepCheckNode(deps: SetupDeps = {}): Promise<StepResult> {
  void deps;
  const major = parseNodeMajor(process.versions.node);
  if (major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      name: STEP_CHECK_NODE,
      error: `Node ${MIN_NODE_MAJOR}+ required, found v${process.versions.node}`,
    };
  }
  return {
    ok: true,
    name: STEP_CHECK_NODE,
    done: true,
    message: `Node v${process.versions.node} OK`,
  };
}

async function ensureDir(
  fs: typeof fsp,
  dir: string,
): Promise<{ created: boolean }> {
  try {
    const stat = await fs.stat(dir);
    if (stat.isDirectory()) return { created: false };
    throw new Error(`${dir} exists but is not a directory`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
  await fs.mkdir(dir, { recursive: true });
  return { created: true };
}

export async function stepCreateActiveRoot(
  deps: SetupDeps = {},
): Promise<StepResult> {
  const { fs, paths } = resolveDeps(deps);
  try {
    const created: string[] = [];
    for (const dir of [paths.activeRoot, paths.stateRoot, paths.configRoot]) {
      const { created: didCreate } = await ensureDir(fs, dir);
      if (didCreate) created.push(dir);
    }
    const message =
      created.length === 0
        ? `Active/state/config dirs already present`
        : `Created ${created.length} dir(s)`;
    return {
      ok: true,
      name: STEP_CREATE_ACTIVE,
      done: created.length > 0,
      message,
    };
  } catch (err) {
    return {
      ok: false,
      name: STEP_CREATE_ACTIVE,
      error: (err as Error).message,
    };
  }
}

export async function stepWriteSchemaVersion(
  deps: SetupDeps = {},
): Promise<StepResult> {
  const { paths } = resolveDeps(deps);
  try {
    const result = await ensureSchemaVersion(paths.activeRoot);
    const message = result.migrated
      ? `Migrated v${result.before} -> v${result.after}`
      : `Schema at v${result.after}`;
    return {
      ok: true,
      name: STEP_SCHEMA,
      done: result.migrated,
      message,
    };
  } catch (err) {
    return {
      ok: false,
      name: STEP_SCHEMA,
      error: (err as Error).message,
    };
  }
}

const CONFIG_STUB = {
  discovery: {
    githubRepos: [] as string[],
    localRepos: [] as string[],
    projectsRoot: '~/Documents/projects',
  },
};

export async function stepWriteConfigStub(
  deps: SetupDeps = {},
): Promise<StepResult> {
  const { fs, paths, update } = resolveDeps(deps);
  const configPath = nodePath.join(paths.configRoot, 'config.json');
  try {
    await ensureDir(fs, paths.configRoot);
    let exists = false;
    try {
      await fs.stat(configPath);
      exists = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (exists && !update) {
      return {
        ok: true,
        name: STEP_CONFIG,
        done: false,
        message: `Config exists at ${configPath} (left untouched)`,
      };
    }
    await fs.writeFile(configPath, JSON.stringify(CONFIG_STUB, null, 2) + '\n', 'utf8');
    return {
      ok: true,
      name: STEP_CONFIG,
      done: true,
      message: `Wrote config stub to ${configPath}`,
    };
  } catch (err) {
    return {
      ok: false,
      name: STEP_CONFIG,
      error: (err as Error).message,
    };
  }
}

async function pathExists(fs: typeof fsp, p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function copyTree(
  fs: typeof fsp,
  src: string,
  dest: string,
): Promise<void> {
  // node:fs/promises has cp() in Node 22+.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cp = (fs as any).cp as
    | undefined
    | ((from: string, to: string, opts: { recursive: boolean }) => Promise<void>);
  if (cp) {
    await cp(src, dest, { recursive: true });
    return;
  }
  // Fallback: shallow copy of files only (test envs may stub fs).
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = nodePath.join(src, entry.name);
    const to = nodePath.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTree(fs, from, to);
    } else {
      await fs.copyFile(from, to);
    }
  }
}

export async function stepInstallSkill(
  deps: SetupDeps = {},
): Promise<StepResult> {
  const { fs, paths, repoRoot } = resolveDeps(deps);
  const targetDir = nodePath.join(paths.homeDir, '.claude', 'skills', 'active-work');
  const targetMarker = nodePath.join(targetDir, 'SKILL.md');
  const sourceDir = nodePath.join(repoRoot, 'skill');
  try {
    if (await pathExists(fs, targetMarker)) {
      return {
        ok: true,
        name: STEP_SKILL,
        done: false,
        message: `Skill already installed at ${targetDir}`,
      };
    }
    if (!(await pathExists(fs, sourceDir))) {
      return {
        ok: true,
        name: STEP_SKILL,
        done: false,
        message: `Skill source not found at ${sourceDir}; skipping`,
      };
    }
    await fs.mkdir(nodePath.dirname(targetDir), { recursive: true });
    await copyTree(fs, sourceDir, targetDir);
    return {
      ok: true,
      name: STEP_SKILL,
      done: true,
      message: `Installed skill to ${targetDir}`,
    };
  } catch (err) {
    return {
      ok: false,
      name: STEP_SKILL,
      error: (err as Error).message,
    };
  }
}

/** Spawn a process and capture its exit code + stderr. */
function runOnce(
  spawn: typeof nodeSpawn,
  cmd: string,
  args: string[],
): Promise<{ code: number | null; stderr: string; spawnError?: Error }> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ code: null, stderr, spawnError: err });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        resolve({ code, stderr });
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      resolve({ code: null, stderr, spawnError: err as Error });
    }
  });
}

const MCP_FALLBACK_SNIPPET = `{
  "active-work": {
    "command": "active-work",
    "args": ["mcp", "serve", "--stdio"]
  }
}`;

export async function stepRegisterMcp(
  deps: SetupDeps = {},
): Promise<StepResult> {
  const { spawn } = resolveDeps(deps);
  const result = await runOnce(spawn, 'claude', [
    'mcp',
    'add',
    '--user',
    '@hjewkes/active-work',
    '--',
    'active-work',
    'mcp',
    'serve',
    '--stdio',
  ]);
  if (result.spawnError && (result.spawnError as NodeJS.ErrnoException).code === 'ENOENT') {
    return {
      ok: true,
      name: STEP_MCP,
      done: false,
      message:
        '`claude` CLI not found. Add this to ~/.claude.json mcpServers section:\n' +
        MCP_FALLBACK_SNIPPET,
    };
  }
  if (result.spawnError) {
    return {
      ok: true,
      name: STEP_MCP,
      done: false,
      message: `MCP registration skipped: ${result.spawnError.message}`,
    };
  }
  if (result.code === 0) {
    return {
      ok: true,
      name: STEP_MCP,
      done: true,
      message: 'Registered MCP server with Claude Code',
    };
  }
  return {
    ok: true,
    name: STEP_MCP,
    done: false,
    message:
      `claude mcp add exited with code ${result.code ?? 'null'}. ` +
      'If already registered, this is safe. Otherwise add manually:\n' +
      MCP_FALLBACK_SNIPPET,
  };
}

/**
 * On Linux, offer to install a user-level systemd unit that supervises
 * the daemon. No-op on other platforms.
 */
export async function stepSupervision(
  deps: SetupDeps = {},
): Promise<StepResult> {
  const { prompts, yes } = resolveDeps(deps);
  if (process.platform !== 'linux') {
    return {
      ok: true,
      name: STEP_SUPERVISION,
      done: false,
      message: `Skipped: systemd supervision only applies on Linux (this host is ${process.platform})`,
    };
  }
  if (!yes) {
    const answer = await prompts.confirm({
      message:
        'Install user systemd unit to keep the daemon running across logins?',
      initialValue: true,
    });
    if (prompts.isCancel(answer) || answer !== true) {
      return {
        ok: true,
        name: STEP_SUPERVISION,
        done: false,
        message: 'Systemd install skipped',
      };
    }
  }
  // Supervision is an optional enhancement, not a prerequisite. Like
  // `stepStartDaemon`, a runtime failure (no user systemd session, container,
  // WSL-without-systemd, CI) must not abort the whole setup — the unit file is
  // still written, so downgrade an install failure to a non-fatal warning that
  // tells the user how to finish enabling it by hand.
  const result = await stepInstallSupervision(deps);
  if (!result.ok) {
    return {
      ok: true,
      name: STEP_SUPERVISION,
      done: false,
      message: `Systemd supervision not enabled (${result.error}); run \`systemctl --user enable --now ${UNIT_NAME}\` once a user systemd session is available`,
    };
  }
  return result;
}

/** Spawn `active-work mcp serve --detach` (best-effort). */
export async function stepStartDaemon(
  deps: SetupDeps = {},
): Promise<StepResult> {
  const { spawn, prompts, yes, cliEntry } = resolveDeps(deps);
  // If systemd is already supervising the daemon on Linux, skip the manual
  // spawn — restarting under systemd is the user's job (`systemctl --user
  // restart active-work.service`).
  if (process.platform === 'linux' && (await isUnitActive(deps))) {
    return {
      ok: true,
      name: STEP_DAEMON,
      done: false,
      message:
        'Daemon already supervised by systemd (active-work.service); manual start skipped',
    };
  }
  if (!yes) {
    const answer = await prompts.confirm({
      message: 'Start the HTTP daemon now? (background process)',
      initialValue: true,
    });
    if (prompts.isCancel(answer) || answer !== true) {
      return {
        ok: true,
        name: STEP_DAEMON,
        done: false,
        message: 'Daemon start skipped',
      };
    }
  } else {
    return {
      ok: true,
      name: STEP_DAEMON,
      done: false,
      message: 'Daemon start skipped (--yes)',
    };
  }
  try {
    const child = spawn(process.execPath, [cliEntry, 'mcp', 'serve', '--detach'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref?.();
    return {
      ok: true,
      name: STEP_DAEMON,
      done: true,
      message: `Daemon launched (pid=${child.pid ?? 'unknown'})`,
    };
  } catch (err) {
    return {
      ok: true,
      name: STEP_DAEMON,
      done: false,
      message: `Daemon launch skipped: ${(err as Error).message}`,
    };
  }
}

export async function stepIngestion(
  deps: SetupDeps = {},
): Promise<StepResult> {
  const { prompts, yes, paths } = resolveDeps(deps);
  if (yes) {
    return {
      ok: true,
      name: STEP_INGEST,
      done: false,
      message:
        `Skipped ingestion walkthrough. Run \`claude\` in ${paths.activeRoot} ` +
        'and ask it to run `active-work discover` followed by `active-work fold` / `active-work drop` / `active-work track`.',
    };
  }
  const answer = await prompts.confirm({
    message: 'Walk through existing work with Claude now?',
    initialValue: false,
  });
  if (prompts.isCancel(answer) || answer !== true) {
    return {
      ok: true,
      name: STEP_INGEST,
      done: false,
      message:
        `Ingestion skipped. Later: run \`claude\` in ${paths.activeRoot} and ask it to ` +
        'invoke `active-work discover` to scan your work.',
    };
  }
  return {
    ok: true,
    name: STEP_INGEST,
    done: true,
    message:
      `Run \`claude\` in ${paths.activeRoot} and paste this prompt: ` +
      '"Please run `active-work discover`, then walk me through `active-work fold` / `active-work drop` / `active-work track` for each hit."',
  };
}

export interface SetupReport {
  banner: string;
  steps: Array<{
    name: string;
    ok: boolean;
    done?: boolean;
    message?: string;
    error?: string;
  }>;
}

/** Run every setup step in order, short-circuiting on the first failure. */
export async function runSetup(deps: SetupDeps = {}): Promise<SetupReport> {
  const banner = 'active-work setup';
  const steps: SetupReport['steps'] = [];
  const ordered = [
    stepCheckNode,
    stepCreateActiveRoot,
    stepWriteSchemaVersion,
    stepWriteConfigStub,
    stepInstallSkill,
    stepRegisterMcp,
    stepSupervision,
    stepStartDaemon,
    stepIngestion,
  ];
  for (const step of ordered) {
    const result = await step(deps);
    if (result.ok) {
      steps.push({
        name: result.name,
        ok: true,
        done: result.done,
        message: result.message,
      });
    } else {
      steps.push({ name: result.name, ok: false, error: result.error });
      break;
    }
  }
  return { banner, steps };
}

// ----- Uninstall ----------------------------------------------------------

export interface UninstallReport {
  steps: Array<{ name: string; done: boolean; message?: string; error?: string }>;
  activeRootPreservedAt: string;
}

async function confirmStep(
  prompts: typeof clackPrompts,
  yes: boolean,
  message: string,
  initial = true,
): Promise<boolean> {
  if (yes) return true;
  const answer = await prompts.confirm({ message, initialValue: initial });
  if (prompts.isCancel(answer)) return false;
  return answer === true;
}

export async function uninstallSkill(deps: SetupDeps = {}): Promise<StepResult> {
  const { fs, paths } = resolveDeps(deps);
  const target = nodePath.join(paths.homeDir, '.claude', 'skills', 'active-work');
  try {
    if (!(await pathExists(fs, target))) {
      return {
        ok: true,
        name: STEP_SKILL,
        done: false,
        message: `Skill not present at ${target}`,
      };
    }
    await fs.rm(target, { recursive: true, force: true });
    return {
      ok: true,
      name: STEP_SKILL,
      done: true,
      message: `Removed skill from ${target}`,
    };
  } catch (err) {
    return { ok: false, name: STEP_SKILL, error: (err as Error).message };
  }
}

export async function uninstallStopDaemon(
  deps: SetupDeps = {},
): Promise<StepResult> {
  const { spawn, cliEntry } = resolveDeps(deps);
  const result = await runOnce(spawn, process.execPath, [cliEntry, 'mcp', 'stop']);
  if (result.spawnError) {
    return {
      ok: true,
      name: STEP_DAEMON,
      done: false,
      message: `Daemon stop skipped: ${result.spawnError.message}`,
    };
  }
  return {
    ok: true,
    name: STEP_DAEMON,
    done: result.code === 0,
    message:
      result.code === 0
        ? 'Daemon stopped'
        : `Daemon stop exited ${result.code ?? 'null'}`,
  };
}

export async function uninstallMcp(deps: SetupDeps = {}): Promise<StepResult> {
  const { spawn } = resolveDeps(deps);
  const result = await runOnce(spawn, 'claude', [
    'mcp',
    'remove',
    '--user',
    '@hjewkes/active-work',
  ]);
  if (result.spawnError && (result.spawnError as NodeJS.ErrnoException).code === 'ENOENT') {
    return {
      ok: true,
      name: STEP_MCP,
      done: false,
      message: '`claude` CLI not found. Remove the entry manually from ~/.claude.json',
    };
  }
  if (result.spawnError) {
    return {
      ok: true,
      name: STEP_MCP,
      done: false,
      message: `MCP unregister skipped: ${result.spawnError.message}`,
    };
  }
  return {
    ok: true,
    name: STEP_MCP,
    done: result.code === 0,
    message:
      result.code === 0
        ? 'Unregistered MCP server from Claude Code'
        : `claude mcp remove exited with code ${result.code ?? 'null'}`,
  };
}

export async function runUninstall(deps: SetupDeps = {}): Promise<UninstallReport> {
  const resolved = resolveDeps(deps);
  const steps: UninstallReport['steps'] = [];

  const wantSkill = await confirmStep(
    resolved.prompts,
    resolved.yes,
    'Remove the active-work skill from ~/.claude/skills/?',
  );
  if (wantSkill) {
    const r = await uninstallSkill(deps);
    steps.push({
      name: r.name,
      done: r.ok ? r.done : false,
      ...(r.ok ? { message: r.message } : { error: r.error }),
    });
  } else {
    steps.push({ name: STEP_SKILL, done: false, message: 'Skipped' });
  }

  if (process.platform === 'linux') {
    const wantSupervision = await confirmStep(
      resolved.prompts,
      resolved.yes,
      'Disable and remove the systemd user unit (active-work.service)?',
    );
    if (wantSupervision) {
      const r = await uninstallSupervision(deps);
      steps.push({
        name: r.name,
        done: r.ok ? r.done : false,
        ...(r.ok ? { message: r.message } : { error: r.error }),
      });
    } else {
      steps.push({ name: STEP_SUPERVISION, done: false, message: 'Skipped' });
    }
  }

  const wantDaemon = await confirmStep(
    resolved.prompts,
    resolved.yes,
    'Stop the daemon?',
  );
  if (wantDaemon) {
    const r = await uninstallStopDaemon(deps);
    steps.push({
      name: r.name,
      done: r.ok ? r.done : false,
      ...(r.ok ? { message: r.message } : { error: r.error }),
    });
  } else {
    steps.push({ name: STEP_DAEMON, done: false, message: 'Skipped' });
  }

  const wantMcp = await confirmStep(
    resolved.prompts,
    resolved.yes,
    'Unregister MCP from Claude Code?',
  );
  if (wantMcp) {
    const r = await uninstallMcp(deps);
    steps.push({
      name: r.name,
      done: r.ok ? r.done : false,
      ...(r.ok ? { message: r.message } : { error: r.error }),
    });
  } else {
    steps.push({ name: STEP_MCP, done: false, message: 'Skipped' });
  }

  return {
    steps,
    activeRootPreservedAt: resolved.paths.activeRoot,
  };
}
