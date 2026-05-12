import { mkdtempSync, rmSync, promises as fs, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sessions, { runSessions } from '../../src/commands/sessions-browser.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

let projectsRoot: string;
const originalEnv = process.env.CLAUDE_PROJECTS_ROOT;

beforeEach(() => {
  projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'aw-sessions-'));
  process.env.CLAUDE_PROJECTS_ROOT = projectsRoot;
});

afterEach(() => {
  rmSync(projectsRoot, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
  else process.env.CLAUDE_PROJECTS_ROOT = originalEnv;
});

interface JsonlSpec {
  projectDir: string;
  sessionId: string;
  cwd?: string;
  lines: object[];
  mtime?: Date;
}

async function writeJsonl(spec: JsonlSpec): Promise<string> {
  const dir = path.join(projectsRoot, spec.projectDir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${spec.sessionId}.jsonl`);
  const body = spec.lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await fs.writeFile(file, body);
  if (spec.mtime) {
    utimesSync(file, spec.mtime, spec.mtime);
  }
  return file;
}

describe('sessions command', () => {
  it('exports CLI metadata with limit and include-active options', () => {
    expect(sessions.name).toBe('sessions');
    expect(sessions.cli?.options?.limit?.long).toBe('--limit');
    expect(sessions.cli?.options?.include_active?.long).toBe('--include-active');
  });

  it('returns sessions sorted by mtime desc and extracts cwd', async () => {
    await writeJsonl({
      projectDir: '-Users-alice-foo',
      sessionId: 'aaa-old',
      lines: [
        { type: 'system', cwd: '/Users/alice/foo' },
        { type: 'user', message: { content: 'hello older session' } },
      ],
      mtime: new Date('2026-01-01T00:00:00Z'),
    });
    await writeJsonl({
      projectDir: '-Users-alice-bar',
      sessionId: 'bbb-new',
      lines: [
        { type: 'system', cwd: '/Users/alice/bar' },
        { type: 'user', message: { content: 'hello newer session' } },
      ],
      mtime: new Date('2026-04-01T00:00:00Z'),
    });

    await withEmptyActiveRoot(async () => {
      const result = await runSessions({});
      expect(result.sessions.map((s) => s.session_id)).toEqual(['bbb-new', 'aaa-old']);
      expect(result.sessions[0].cwd).toBe('/Users/alice/bar');
      expect(result.sessions[1].cwd).toBe('/Users/alice/foo');
      expect(result.sessions[0].ended).toBe('2026-04-01T00:00:00.000Z');
    });
  });

  it('skips files without a cwd field', async () => {
    await writeJsonl({
      projectDir: '-empty',
      sessionId: 'no-cwd',
      lines: [{ type: 'system', model: 'opus' }],
    });
    await writeJsonl({
      projectDir: '-good',
      sessionId: 'has-cwd',
      lines: [
        { type: 'system', cwd: '/Users/alice/has' },
        { type: 'user', message: { content: 'hi' } },
      ],
    });

    await withEmptyActiveRoot(async () => {
      const result = await runSessions({});
      expect(result.sessions.map((s) => s.session_id)).toEqual(['has-cwd']);
    });
  });

  it('honors the limit option', async () => {
    for (let i = 0; i < 5; i++) {
      await writeJsonl({
        projectDir: `-proj-${i}`,
        sessionId: `s-${i}`,
        lines: [
          { type: 'system', cwd: `/tmp/p${i}` },
          { type: 'user', message: { content: `msg ${i}` } },
        ],
        mtime: new Date(2026, 0, i + 1),
      });
    }

    await withEmptyActiveRoot(async () => {
      const result = await runSessions({ limit: 2 });
      expect(result.sessions).toHaveLength(2);
      // newest first
      expect(result.sessions[0].session_id).toBe('s-4');
      expect(result.sessions[1].session_id).toBe('s-3');
    });
  });

  it('prefers the compaction-continuation summary over first user message', async () => {
    await writeJsonl({
      projectDir: '-summarized',
      sessionId: 'compacted',
      lines: [
        { type: 'system', cwd: '/Users/alice/summarized' },
        { type: 'user', message: { content: 'original ask' } },
        { type: 'assistant', message: { content: 'reply' } },
        {
          type: 'user',
          message: {
            content:
              'This session is being continued from a previous conversation. Key context: ' +
              'wave 2 sessions browser implementation in progress.',
          },
        },
      ],
    });

    await withEmptyActiveRoot(async () => {
      const result = await runSessions({});
      expect(result.sessions[0].summary).toMatch(/continued from a previous conversation/);
      expect(result.sessions[0].summary).not.toMatch(/original ask/);
    });
  });

  it('falls back to first user message when no compaction marker is present', async () => {
    await writeJsonl({
      projectDir: '-firstmsg',
      sessionId: 'first',
      lines: [
        { type: 'system', cwd: '/Users/alice/first' },
        { type: 'user', message: { content: 'kick off the work please' } },
      ],
    });

    await withEmptyActiveRoot(async () => {
      const result = await runSessions({});
      expect(result.sessions[0].summary).toBe('kick off the work please');
    });
  });

  it('truncates long summaries to 150 chars', async () => {
    const long = 'x'.repeat(500);
    await writeJsonl({
      projectDir: '-long',
      sessionId: 'long',
      lines: [
        { type: 'system', cwd: '/Users/alice/long' },
        { type: 'user', message: { content: long } },
      ],
    });

    await withEmptyActiveRoot(async () => {
      const result = await runSessions({});
      expect(result.sessions[0].summary).toHaveLength(150);
    });
  });

  it('filters out sessions whose cwd is under an active initiative by default', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await fs.mkdir(path.join(activeRoot, 'my-initiative'), { recursive: true });

      await writeJsonl({
        projectDir: '-active',
        sessionId: 'inside',
        lines: [
          { type: 'system', cwd: path.join(activeRoot, 'my-initiative', 'sub') },
          { type: 'user', message: { content: 'inside initiative' } },
        ],
      });
      await writeJsonl({
        projectDir: '-outside',
        sessionId: 'outside',
        lines: [
          { type: 'system', cwd: '/Users/alice/elsewhere' },
          { type: 'user', message: { content: 'outside' } },
        ],
      });

      const result = await runSessions({});
      expect(result.sessions.map((s) => s.session_id)).toEqual(['outside']);
    });
  });

  it('include_active retains sessions under an active initiative', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await fs.mkdir(path.join(activeRoot, 'my-initiative'), { recursive: true });

      await writeJsonl({
        projectDir: '-active',
        sessionId: 'inside',
        lines: [
          { type: 'system', cwd: path.join(activeRoot, 'my-initiative') },
          { type: 'user', message: { content: 'inside initiative' } },
        ],
      });

      const result = await runSessions({ include_active: true });
      expect(result.sessions.map((s) => s.session_id)).toEqual(['inside']);
    });
  });

  it('returns empty result when projects root does not exist', async () => {
    process.env.CLAUDE_PROJECTS_ROOT = path.join(projectsRoot, 'does-not-exist');
    await withEmptyActiveRoot(async () => {
      const result = await runSessions({});
      expect(result.sessions).toEqual([]);
    });
  });
});
