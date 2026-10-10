import { promises as fs, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeProjectSlug } from '@titan-design/session-read';
import sessionRecover, { recoverUnwrapped } from '../../src/commands/session-recover.js';
import open from '../../src/commands/open.js';
import prompt from '../../src/commands/prompt.js';
import sessionList from '../../src/commands/session-list.js';
import { RECENT_WRITE_MS, type RecoverTarget } from '../../src/sessions/recover-session.js';
import wrap from '../../src/commands/wrap.js';
import { RECOVERED_FIRST_LINE } from '../../src/sessions/recovered-body.js';
import type { CommandContext } from '../../src/registry/index.js';
import { parseFrontmatter } from '../../src/utils/gray-matter-io.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import {
  LAST_ASSISTANT_TEXT,
  OWNER_MESSAGES,
  writeUnwrappedTranscript,
} from '../fixtures/unwrapped-transcript.js';
import { mirrorRoot, mirrorRoots } from '../fixtures/mirror-roots.js';

vi.mock('@titan-design/session-read', async (importOriginal) =>
  (await import('../fixtures/mirror-roots.js')).withMirrors(importOriginal),
);

const SLUG = 'sample-initiative';
const CRASHED = '0a0a0a0a-1111-4222-8333-444444444444';
const OLDER = '0b0b0b0b-1111-4222-8333-444444444444';
const RUNNING = '0c0c0c0c-1111-4222-8333-444444444444';

let claudeHome: string;

beforeEach(() => {
  claudeHome = mkdtempSync(path.join(os.tmpdir(), 'aw-recover-claude-'));
});

afterEach(() => {
  mirrorRoots.length = 0;
  rmSync(claudeHome, { recursive: true, force: true });
});

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

/** Older than the recency guard, so a transcript is recoverable unless a test says otherwise. */
const QUIET_MS = RECENT_WRITE_MS + 60_000;

function transcriptFor(
  activeRoot: string,
  sessionId: string,
  ageMs = QUIET_MS,
  entrypoint = 'cli',
): string {
  const cwd = path.join(activeRoot, SLUG);
  const projectDir = path.join(claudeHome, 'projects', claudeProjectSlug(cwd));
  const when = new Date(Date.now() - ageMs);
  const file = writeUnwrappedTranscript({ projectDir, sessionId, cwd, entrypoint, endsAt: when });
  utimesSync(file, when, when);
  return file;
}

function target(activeRoot: string, live: string[] = []): RecoverTarget {
  return {
    activeRoot,
    slug: SLUG,
    track: 'canonical',
    roots: [{ root: path.join(claudeHome, 'projects'), account: 'default' }],
    liveSessionIds: () => Promise.resolve(new Set(live)),
    now: new Date(),
  };
}

async function withConfigDirs(fn: () => Promise<void>): Promise<void> {
  const previous = process.env.CLAUDE_CONFIG_DIRS;
  process.env.CLAUDE_CONFIG_DIRS = claudeHome;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIRS;
    else process.env.CLAUDE_CONFIG_DIRS = previous;
  }
}

async function wrapCanonical(activeRoot: string, ended: string): Promise<void> {
  await wrap.run(
    wrap.args.parse({
      slug: SLUG,
      session_id: 'wrapped-later',
      started: ended,
      ended,
      track: 'canonical',
      body: 'Wrapped after the older transcript ended.\n',
      no_loops: true,
      no_notes: true,
      no_tasks: true,
    }),
    makeCtx(activeRoot),
  );
}

async function readRecord(file: string): Promise<string> {
  return fs.readFile(file, 'utf8');
}

async function readFrontmatter(file: string): Promise<Record<string, unknown>> {
  return parseFrontmatter(await readRecord(file)).data;
}

describe('session recover', () => {
  it('writes a generated record for the newest transcript with no record and no process', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const transcript = transcriptFor(activeRoot, CRASHED);
      const older = transcriptFor(activeRoot, OLDER, QUIET_MS + 60_000);

      const result = await recoverUnwrapped(target(activeRoot), undefined);

      expect(result.recovered?.session_id).toBe(CRASHED);
      expect(result.recovered?.transcript).toBe(transcript);
      expect(result.unrecorded).toEqual([{ session_id: OLDER, transcript: older }]);
      const { data, content } = parseFrontmatter(await readRecord(result.recovered!.path));
      expect(data).toMatchObject({ generated: true, transcript, track: 'canonical' });
      expect(content.trimStart().split('\n')[0]).toBe(RECOVERED_FIRST_LINE);
    });
  });

  it('lists the handoff file, filed tasks and last owner messages from the transcript', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const transcript = transcriptFor(activeRoot, CRASHED);

      const result = await recoverUnwrapped(target(activeRoot), undefined);

      const record = await readRecord(result.recovered!.path);
      expect(record).toContain('- `handoff-notes.md`');
      expect(record).toContain('- `active-work task add` ×2');
      expect(record).toContain('- `git push origin` ×1');
      expect(record).toContain('- coordinator: Handoff is in place.');
      expect(record).toContain('- worker-one: Pick up the first follow-up.');
      for (const message of OWNER_MESSAGES) expect(record).toContain(`> ${message}`);
      expect(record).toContain(`> ${LAST_ASSISTANT_TEXT}`);
      const lines = (await readRecord(transcript)).trim().split('\n');
      const at = (raw: string | undefined) =>
        (JSON.parse(raw ?? '{}') as { timestamp: string }).timestamp;
      const { started, ended } = await readFrontmatter(result.recovered!.path);
      expect(new Date(started as string).toISOString()).toBe(at(lines[0]));
      expect(new Date(ended as string).toISOString()).toBe(at(lines.at(-1)));
    });
  });

  it('skips a transcript a running claude process still holds', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      transcriptFor(activeRoot, RUNNING);
      transcriptFor(activeRoot, CRASHED, QUIET_MS + 60_000);

      const result = await recoverUnwrapped(target(activeRoot, [RUNNING]), undefined);

      expect(result.recovered?.session_id).toBe(CRASHED);
      expect(result.unrecorded).toEqual([]);
    });
  });

  it('writes nothing on a second run and says why', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      transcriptFor(activeRoot, CRASHED);
      transcriptFor(activeRoot, OLDER, QUIET_MS + 60_000);
      await recoverUnwrapped(target(activeRoot), undefined);
      const before = await fs.readdir(path.join(activeRoot, SLUG, 'sessions'));

      const again = await recoverUnwrapped(target(activeRoot), undefined);

      expect(again.recovered).toBeNull();
      expect(again.note).toMatch(/nothing was written/);
      expect(await fs.readdir(path.join(activeRoot, SLUG, 'sessions'))).toEqual(before);
    });
  });

  it('skips a transcript that ended before the newest record on its track', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      transcriptFor(activeRoot, OLDER, QUIET_MS + 60 * 60_000);
      const ended = new Date(Date.now() - QUIET_MS - 30 * 60_000).toISOString();
      await wrapCanonical(activeRoot, ended);

      const result = await recoverUnwrapped(target(activeRoot), undefined);

      expect(result.recovered).toBeNull();
      expect(result.note).toContain(`newest canonical record (${ended})`);
      expect(result.unrecorded).toEqual([{ session_id: OLDER, transcript: expect.any(String) }]);
    });
  });

  it('skips a headless sdk-cli transcript', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      transcriptFor(activeRoot, RUNNING, QUIET_MS, 'sdk-cli');
      transcriptFor(activeRoot, CRASHED, QUIET_MS + 60_000);

      const result = await recoverUnwrapped(target(activeRoot), undefined);

      expect(result.recovered?.session_id).toBe(CRASHED);
    });
  });

  it('skips a transcript written in the last ten minutes, by default and by name', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      transcriptFor(activeRoot, RUNNING, 60_000);

      const result = await recoverUnwrapped(target(activeRoot), undefined);

      expect(result.recovered).toBeNull();
      await expect(recoverUnwrapped(target(activeRoot), RUNNING)).rejects.toThrow(
        /last 10 minutes/,
      );
    });
  });

  it('aborts without writing when a pid file cannot be parsed', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await withConfigDirs(async () => {
        transcriptFor(activeRoot, CRASHED);
        await fs.mkdir(path.join(claudeHome, 'sessions'));
        await fs.writeFile(path.join(claudeHome, 'sessions', '123.json'), '{truncated');

        const run = sessionRecover.run(
          sessionRecover.args.parse({ slug: SLUG }),
          makeCtx(activeRoot),
        );

        await expect(run).rejects.toThrow(/123\.json is not valid JSON/);
        const sessions = await fs.readdir(path.join(activeRoot, SLUG, 'sessions'));
        expect(sessions.some((f) => f.includes(CRASHED))).toBe(false);
      });
    });
  });

  it('refuses a named session that is running, recorded, or not the initiative’s', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      transcriptFor(activeRoot, RUNNING);
      transcriptFor(activeRoot, CRASHED);
      await recoverUnwrapped(target(activeRoot), CRASHED);

      await expect(recoverUnwrapped(target(activeRoot, [RUNNING]), RUNNING)).rejects.toThrow(
        /still running/,
      );
      await expect(recoverUnwrapped(target(activeRoot), CRASHED)).rejects.toThrow(
        /already has a record/,
      );
      await expect(recoverUnwrapped(target(activeRoot), OLDER)).rejects.toThrow(/No transcript/);
    });
  });

  it('finds transcripts and live processes through CLAUDE_CONFIG_DIRS by default', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await withConfigDirs(async () => {
        transcriptFor(activeRoot, RUNNING);
        transcriptFor(activeRoot, CRASHED, QUIET_MS + 60_000);
        await fs.mkdir(path.join(claudeHome, 'sessions'));
        const pidFile = { pid: process.pid, sessionId: RUNNING };
        await fs.writeFile(path.join(claudeHome, 'sessions', 'x.json'), JSON.stringify(pidFile));

        const result = await sessionRecover.run(
          sessionRecover.args.parse({ slug: SLUG }),
          makeCtx(activeRoot),
        );

        expect(result.recovered?.session_id).toBe(CRASHED);
      });
    });
  });

  it('never recovers a session from a mirror of another host', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await withConfigDirs(async () => {
        const mirror = mirrorRoot(path.join(claudeHome, 'mirror'), 'default');
        mirrorRoots.push(mirror);
        const cwd = path.join(activeRoot, SLUG);
        const projectDir = path.join(mirror.root, claudeProjectSlug(cwd));
        const when = new Date(Date.now() - QUIET_MS);
        const file = writeUnwrappedTranscript({ projectDir, sessionId: CRASHED, cwd, endsAt: when });
        utimesSync(file, when, when);

        const result = await sessionRecover.run(
          sessionRecover.args.parse({ slug: SLUG }),
          makeCtx(activeRoot),
        );

        expect(result.recovered).toBeNull();
        expect(result.unrecorded_total).toBe(0);
      });
    });
  });

  it('shows the recovered record as the labelled last session in prompt and open', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const transcript = transcriptFor(activeRoot, CRASHED);
      await recoverUnwrapped(target(activeRoot), undefined);
      const ctx = makeCtx(activeRoot);

      const text = await prompt.run({ slug: SLUG, offline: true }, ctx);
      const opened = await open.run({ slug: SLUG, offline: true, lease_mode: 'defer' }, ctx);

      expect(text).toMatch(new RegExp(`# Last session \\(recovered\\) \\([^)]*, ${CRASHED}\\)`));
      expect(text).toContain(`Transcript: \`${transcript}\``);
      expect(text).toContain(RECOVERED_FIRST_LINE);
      expect('metadata' in opened && opened.metadata.last_session).toMatchObject({
        recovered: true,
        transcript,
      });
    });
  });

  it('leaves a wrapped session unlabelled', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const text = await prompt.run({ slug: SLUG, offline: true }, makeCtx(activeRoot));
      const listed = await sessionList.run({ slug: SLUG }, makeCtx(activeRoot));

      expect(text).not.toContain('(recovered)');
      expect(listed.sessions[0]?.frontmatter.generated).toBeUndefined();
    });
  });
});
