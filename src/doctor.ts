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
import { readPidFile, isProcessAlive } from './server/lifecycle.js';
import { getSupervisor } from './setup/supervision.js';

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

const HEALTH_TIMEOUT_MS = 500;

interface HealthResponse {
  version: string;
  pid: number;
  uptime_ms: number;
  port: number;
}

async function probeHealth(port: number): Promise<HealthResponse | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

async function defaultProbeDaemon(): Promise<DaemonProbe> {
  const entry = await readPidFile();
  if (!entry) return { running: false, healthy: false };
  const alive = isProcessAlive(entry.pid);
  if (!alive) {
    return { running: false, healthy: false, pid: entry.pid, port: entry.meta.port };
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

async function readMcpRegistered(
  fs: typeof fsp,
  homeDir: string,
): Promise<boolean> {
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
  if (probe.running && probe.healthy) {
    return {
      name: 'daemon',
      status: 'ok',
      detail: `running (pid ${probe.pid ?? '?'}, port ${probe.port ?? '?'}, v${probe.version ?? '?'})`,
    };
  }
  if (probe.running && !probe.healthy) {
    return {
      name: 'daemon',
      status: 'warn',
      detail: `pid ${probe.pid ?? '?'} is alive but /health did not answer`,
    };
  }
  return {
    name: 'daemon',
    status: 'warn',
    detail: 'not running — start it with `active-work mcp serve --detach`',
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

/** Run all health checks and return a report. `ok` is false iff any check failed. */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const checks = await Promise.all([
    checkNode(deps),
    checkActiveRoot(deps),
    checkDaemon(deps),
    checkMcp(deps),
    checkSkill(deps),
    checkSupervisor(deps),
  ]);
  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}
