import nodePath from 'node:path';

const SYSTEM_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

const LINUX_SYSTEM_PATH_DIRS = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** Supervisors start jobs with a bare PATH; child tools such as `gh` need Homebrew's bin (TP-327). */
export function daemonPath(nodeBin: string): string {
  return [...new Set([nodePath.dirname(nodeBin), ...SYSTEM_PATH_DIRS])].join(':');
}

/**
 * The systemd unit's PATH. CLIs the daemon shells out to (agent-chat, titan-factory)
 * install to `~/.local/bin` on Linux hosts, and Homebrew's dir does not exist there (TP-1841).
 */
export function linuxDaemonPath(nodeBin: string, homeDir: string): string {
  const localBin = nodePath.join(homeDir, '.local', 'bin');
  const nodeDir = nodePath.dirname(nodeBin);
  const known = [localBin, ...LINUX_SYSTEM_PATH_DIRS];
  const dirs = known.includes(nodeDir) ? known : [localBin, nodeDir, ...LINUX_SYSTEM_PATH_DIRS];
  return dirs.join(':');
}
