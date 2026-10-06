/**
 * TP-1777: the daemon honours the factory host lease. Every lease file lives
 * in a per-test tmpdir reached through AGENT_CHAT_HOME; the hostname is injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as DaemonPackage from '@titan-design/daemon';
import { DaemonError } from '../../src/errors.js';
import { runDaemon } from '../../src/server/daemon.js';
import { hostLeaseRefusal, leasePath } from '../../src/server/host-lease.js';

const startDaemon = vi.hoisted(() => vi.fn());
const getLogger = vi.hoisted(() => vi.fn());

vi.mock('@titan-design/daemon', async (importOriginal) => ({
  ...(await importOriginal<typeof DaemonPackage>()),
  startDaemon,
}));
vi.mock('../../src/server/logger.js', () => ({ getLogger }));

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'aw-lease-'));
  vi.stubEnv('AGENT_CHAT_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function writeLease(text: string): string {
  const file = path.join(home, 'factory-host');
  writeFileSync(file, text);
  return file;
}

function refusalOn(hostname: string): string | undefined {
  return hostLeaseRefusal({ hostname: () => hostname });
}

describe('factory host lease', () => {
  it('resolves the lease file under AGENT_CHAT_HOME', () => {
    expect(leasePath()).toBe(path.join(home, 'factory-host'));
  });

  it('allows a start when no lease file exists', () => {
    expect(refusalOn('build-box')).toBeUndefined();
  });

  it('allows a start when the lease names this host', () => {
    writeLease('build-box\n');
    expect(refusalOn('build-box')).toBeUndefined();
  });

  it.each([
    ['a .local suffix', 'build-box.local', 'build-box'],
    ['a domain suffix', 'build-box', 'build-box.example.com'],
    ['a case difference', 'Build-Box', 'build-box.local'],
    ['surrounding whitespace', '  build-box  \n', 'BUILD-BOX'],
  ])('treats names differing by %s as one host', (_label, leased, hostname) => {
    writeLease(leased);
    expect(refusalOn(hostname)).toBeUndefined();
  });

  it('refuses a host the lease does not name, naming the file and both hosts', () => {
    const file = writeLease('build-box\n');
    const message = refusalOn('build-box2.local');
    expect(message).toContain(file);
    expect(message).toContain('"build-box"');
    expect(message).toContain('"build-box2.local"');
    expect(message).toContain('refusing to start');
  });

  it('refuses when the lease file is empty', () => {
    const file = writeLease('  \n');
    expect(refusalOn('build-box')).toBe(`factory host lease ${file} is empty; refusing to start`);
  });

  it('refuses when the lease file cannot be read', () => {
    const file = path.join(home, 'factory-host');
    mkdirSync(file);
    expect(refusalOn('build-box')).toMatch(
      new RegExp(`factory host lease ${file} is unreadable \\(.+\\); refusing to start`),
    );
  });
});

describe('runDaemon under the factory host lease', () => {
  it('refuses before the logger or the socket when the lease names another host', async () => {
    writeLease(`not-${os.hostname()}`);

    const started = runDaemon({ port: 0 });

    await expect(started).rejects.toBeInstanceOf(DaemonError);
    await expect(started).rejects.toThrow(/refusing to start/);
    expect(getLogger).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
  });
});
