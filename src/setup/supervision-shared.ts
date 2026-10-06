import nodePath from 'node:path';

const SYSTEM_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

/** Supervisors start jobs with a bare PATH; child tools such as `gh` need Homebrew's bin (TP-327). */
export function daemonPath(nodeBin: string): string {
  return [...new Set([nodePath.dirname(nodeBin), ...SYSTEM_PATH_DIRS])].join(':');
}
