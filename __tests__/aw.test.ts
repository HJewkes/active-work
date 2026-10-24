import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EXIT, NotFoundError } from '../src/errors.js';
import { PROFILE_ROOT_ENV } from '../src/launcher-profile.js';

const runMock = vi.fn();

vi.mock('../src/commands/open.js', () => ({
  default: {
    args: { parse: (input: unknown) => input },
    run: runMock,
  },
}));

const exitMock = vi.fn();

vi.mock('../src/utils/exit.js', () => ({ exitAfterFlush: exitMock }));

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { helpText, main, openSlugOrInit } = await import('../src/aw.js');

describe('openSlugOrInit (TP-356 reviewer nit)', () => {
  let isTTY: boolean | undefined;

  beforeEach(() => {
    isTTY = process.stdin.isTTY;
    runMock.mockReset();
  });

  afterEach(() => {
    process.stdin.isTTY = isTTY;
  });

  it('rethrows a NotFoundError with the kebab-case hint appended for an invalid-slug miss on a TTY', async () => {
    process.stdin.isTTY = true;
    const original = "No initiative matches 'New_Thing'. Known: a, b";
    runMock.mockRejectedValue(new NotFoundError(original, { reason: 'no_match' }));

    await expect(openSlugOrInit('New_Thing', false)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).code).toBe(66);
      expect((err as Error).message).toContain(original);
      expect((err as Error).message).toContain(
        'To create it, use a lowercase kebab-case slug (e.g. my-new-thing).',
      );
      return true;
    });
  });
});

describe('aw --profile', () => {
  let profilesRoot: string;
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    profilesRoot = mkdtempSync(path.join(tmpdir(), 'aw-profiles-'));
    mkdirSync(path.join(profilesRoot, 'agents'));
    mkdirSync(path.join(profilesRoot, 'server'));
    vi.stubEnv(PROFILE_ROOT_ENV, profilesRoot);
    runMock.mockReset();
    exitMock.mockReset();
    spawnMock.mockReset();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    vi.unstubAllEnvs();
    rmSync(profilesRoot, { recursive: true, force: true });
  });

  it.each([['--profile', 'ghost'], ['--profile=ghost']])(
    'exits non-zero listing the existing profiles before launching for %s',
    async (...flag) => {
      await main(['node', 'aw', 'example-app', ...flag]);

      expect(exitMock).toHaveBeenCalledWith(EXIT.USAGE);
      const message = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(message).toContain('unknown profile "ghost"');
      expect(message).toContain('agents, server');
      expect(runMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it('rejects an unknown profile for resume before looking the session up', async () => {
    await main(['node', 'aw', 'resume', 'abc123', '--profile', 'ghost']);

    expect(exitMock).toHaveBeenCalledWith(EXIT.USAGE);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('documents --profile in the help text', () => {
    const help = helpText();

    expect(help).toContain('aw <slug> --profile <name>');
    expect(help).toContain('--profile=<name>');
    expect(help).toContain('aw resume <session_id> [--no-rc] [--profile <name>]');
  });
});
