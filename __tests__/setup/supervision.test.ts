import { describe, expect, it } from 'vitest';
import { getSupervisor } from '../../src/setup/supervision.js';

describe('getSupervisor', () => {
  it('returns the systemd supervisor on linux', () => {
    const sup = getSupervisor('linux');
    expect(sup).not.toBeNull();
    expect(sup!.kind).toBe('systemd');
    expect(sup!.enableHint).toMatch(/systemctl/);
  });

  it('returns the launchd supervisor on darwin', () => {
    const sup = getSupervisor('darwin');
    expect(sup).not.toBeNull();
    expect(sup!.kind).toBe('launchd');
    expect(sup!.enableHint).toMatch(/launchctl/);
  });

  it('returns null on platforms without an integration', () => {
    expect(getSupervisor('win32')).toBeNull();
    expect(getSupervisor('aix')).toBeNull();
  });
});

describe('Supervisor.render (print-only path)', () => {
  it('renders the systemd unit without touching the host', () => {
    const text = getSupervisor('linux')!.render({
      cliEntry: '/x/cli.js',
      paths: { activeRoot: '', stateRoot: '', configRoot: '', homeDir: '/tmp/u' },
    });
    expect(text).toContain('[Service]');
    expect(text).toContain('/x/cli.js mcp serve');
  });

  it('renders the launchd plist on darwin', () => {
    const text = getSupervisor('darwin')!.render({ cliEntry: '/x/cli.js' });
    expect(text).toContain('<plist');
  });
});
