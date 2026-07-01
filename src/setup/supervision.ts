/**
 * Platform dispatcher for daemon supervision.
 *
 * `setup`/`uninstall` should not care whether a host uses systemd or launchd —
 * they ask `getSupervisor()` for the local implementation and drive it through
 * this common interface. Linux → systemd (`supervision-systemd.ts`),
 * macOS → launchd (`supervision-launchd.ts`), everything else → no supervisor.
 */
import {
  UNIT_NAME,
  stepInstallSupervision,
  uninstallSupervision,
  isUnitActive,
} from './supervision-systemd.js';
import {
  PLIST_LABEL,
  installLaunchAgent,
  uninstallLaunchAgent,
  isAgentLoaded,
} from './supervision-launchd.js';
import type { SetupDeps, StepResult } from './steps.js';

export interface Supervisor {
  readonly kind: 'systemd' | 'launchd';
  /** One-line prompt shown when offering to install supervision. */
  readonly installPrompt: string;
  /** One-line prompt shown when offering to remove supervision. */
  readonly uninstallPrompt: string;
  /** Manual command that finishes enabling if the runtime step fails. */
  readonly enableHint: string;
  install(deps: SetupDeps, opts?: { port?: number }): Promise<StepResult>;
  uninstall(deps: SetupDeps): Promise<StepResult>;
  /** True when the daemon is already supervised (so manual start is skipped). */
  isActive(deps: SetupDeps): Promise<boolean>;
}

const systemdSupervisor: Supervisor = {
  kind: 'systemd',
  installPrompt:
    'Install user systemd unit to keep the daemon running across logins?',
  uninstallPrompt:
    'Disable and remove the systemd user unit (active-work.service)?',
  enableHint: `systemctl --user enable --now ${UNIT_NAME}`,
  install: (deps, opts) => stepInstallSupervision(deps, opts),
  uninstall: (deps) => uninstallSupervision(deps),
  isActive: (deps) => isUnitActive(deps),
};

const launchdSupervisor: Supervisor = {
  kind: 'launchd',
  installPrompt:
    'Install a launchd agent to keep the daemon running across logins?',
  uninstallPrompt: `Boot out and remove the launchd agent (${PLIST_LABEL})?`,
  enableHint: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${PLIST_LABEL}.plist`,
  install: (deps, opts) => installLaunchAgent(deps, opts),
  uninstall: (deps) => uninstallLaunchAgent(deps),
  isActive: (deps) => isAgentLoaded(deps),
};

/** Return the supervisor for `platform`, or null when none is integrated. */
export function getSupervisor(
  platform: NodeJS.Platform = process.platform,
): Supervisor | null {
  if (platform === 'linux') return systemdSupervisor;
  if (platform === 'darwin') return launchdSupervisor;
  return null;
}
