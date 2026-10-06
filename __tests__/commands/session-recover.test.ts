import { promises as fs, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeProjectSlug } from '@titan-design/session-read';
import sessionRecover, { recoverUnwrapped } from '../../src/commands/session-recover.js';
import open from '../../src/commands/open.js';
import prompt from '../../src/commands/prompt.js';
import sessionList from '../../src/commands/session-list.js';
import type { RecoverTarget } from '../../src/sessions/recover-session.js';
import { RECOVERED_FIRST_LINE } from '../../src/sessions/recovered-body.js';
import type { CommandContext } from '../../src/registry/index.js';
import { parseFrontmatter } from '../../src/utils/gray-matter-io.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import {
  LAST_ASSISTANT_TEXT,
  OWNER_MESSAGES,
  writeUnwrappedTranscript,
} from '../fixtures/unwrapped-transcript.js';

const SLUG = 'sample-initiative';
const CRASHED = '0a0a0a0a-1111-4222-8333-444444444444';
const OLDER = '0b0b0b0b-1111-4222-8333-444444444444';
const RUNNING = '0c0c0c0c-1111-4222-8333-444444444444';

let claudeHome: string;

beforeEach(() => {
  claudeHome = mkdtempSync(path.join(os.tmpdir(), 'aw-recover-claude-'));
});

afterEach(() => {
  rmSync(claudeHome, { recursive: true, force: true });
});

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

function transcriptFor(activeRoot: string, sessionId: string, ageMs = 0): string {
  const cwd = path.join(activeRoot, SLUG);
  const projectDir = path.join(claudeHome, 'projects', claudeProjectSlug(cwd));
  const file = writeUnwrappedTranscript({ projectDir, sessionId, cwd });
  const when = new Date(Date.now() - ageMs);
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
  };
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
      const older = transcriptFor(activeRoot, OLDER, 60_000);

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
      transcriptFor(activeRoot, CRASHED);

      const result = await recoverUnwrapped(target(activeRoot), undefined);

      const record = await readRecord(result.recovered!.path);
      expect(record).toContain('- `handoff-notes.md`');
      expect(record).toContain('- `active-work task add` ×2');
      expect(record).toContain('- `git push origin` ×1');
      expect(record).toContain('- coordinator: Handoff is in place.');
      expect(record).toContain('- worker-one: Pick up the first follow-up.');
      for (const message of OWNER_MESSAGES) expect(record).toContain(`> ${message}`);
      expect(record).toContain(`> ${LAST_ASSISTANT_TEXT}`);
      const started = (await readFrontmatter(result.recovered!.path)).started;
      expect(new Date(started as string).toISOString()).toBe('2026-10-05T21:00:01.000Z');
    });
  });

  it('skips a transcript a running claude process still holds', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      transcriptFor(activeRoot, RUNNING);
      transcriptFor(activeRoot, CRASHED, 60_000);

      const result = await recoverUnwrapped(target(activeRoot, [RUNNING]), undefined);

      expect(result.recovered?.session_id).toBe(CRASHED);
      expect(result.unrecorded).toEqual([]);
    });
  });

  it('recovers nothing once every transcript has a record', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      transcriptFor(activeRoot, CRASHED);
      await recoverUnwrapped(target(activeRoot), undefined);

      const again = await recoverUnwrapped(target(activeRoot), undefined);

      expect(again).toEqual({ recovered: null, unrecorded: [], unrecorded_total: 0 });
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
      const previous = process.env.CLAUDE_CONFIG_DIRS;
      process.env.CLAUDE_CONFIG_DIRS = claudeHome;
      try {
        transcriptFor(activeRoot, RUNNING);
        transcriptFor(activeRoot, CRASHED, 60_000);
        await fs.mkdir(path.join(claudeHome, 'sessions'));
        const pidFile = { pid: process.pid, sessionId: RUNNING };
        await fs.writeFile(path.join(claudeHome, 'sessions', 'x.json'), JSON.stringify(pidFile));

        const result = await sessionRecover.run(
          sessionRecover.args.parse({ slug: SLUG }),
          makeCtx(activeRoot),
        );

        expect(result.recovered?.session_id).toBe(CRASHED);
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIRS;
        else process.env.CLAUDE_CONFIG_DIRS = previous;
      }
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
