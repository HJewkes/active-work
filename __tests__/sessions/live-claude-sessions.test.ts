import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { liveSessionIdsFrom } from '../../src/sessions/live-claude-sessions.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(path.join(os.tmpdir(), 'aw-live-sessions-'));
  mkdirSync(path.join(configDir, 'sessions'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function writePidFile(pid: number, sessionId: string): void {
  const file = path.join(configDir, 'sessions', `${pid}.json`);
  writeFileSync(file, JSON.stringify({ pid, sessionId, cwd: '/tmp' }));
}

const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

describe('liveSessionIdsFrom', () => {
  it('reports a session whose pid file names a live claude process', async () => {
    writePidFile(101, 'live-session');
    const probe = liveSessionIdsFrom([configDir], {
      isAlive: alive([101]),
      getComm: () => '/opt/bin/claude',
    });

    expect(await probe()).toEqual(new Set(['live-session']));
  });

  it('ignores a pid file left behind by a dead process', async () => {
    writePidFile(102, 'crashed-session');
    const probe = liveSessionIdsFrom([configDir], { isAlive: alive([]), getComm: () => null });

    expect(await probe()).toEqual(new Set());
  });

  it('ignores a pid recycled onto an unrelated process after a reboot', async () => {
    writePidFile(103, 'rebooted-session');
    const probe = liveSessionIdsFrom([configDir], {
      isAlive: alive([103]),
      getComm: () => 'launchd',
    });

    expect(await probe()).toEqual(new Set());
  });

  it('treats an unreadable command name on a live pid as claude', async () => {
    writePidFile(104, 'unknown-comm');
    const probe = liveSessionIdsFrom([configDir], { isAlive: alive([104]), getComm: () => null });

    expect(await probe()).toEqual(new Set(['unknown-comm']));
  });

  it('skips malformed pid files and missing config dirs', async () => {
    writeFileSync(path.join(configDir, 'sessions', 'bad.json'), '{not json');
    const probe = liveSessionIdsFrom([configDir, path.join(configDir, 'missing')], {
      isAlive: alive([]),
      getComm: () => null,
    });

    expect(await probe()).toEqual(new Set());
  });
});
