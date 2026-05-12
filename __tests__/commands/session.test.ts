import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import sessionRecord from '../../src/commands/session-record.js';
import sessionList from '../../src/commands/session-list.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import type { CommandContext } from '../../src/registry/index.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

const STARTED = '2026-05-12T09:00:00Z';
const ENDED = '2026-05-12T10:30:00Z';

describe('session.record', () => {
  it('writes a file with computed filename derived from started (UTC)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await sessionRecord.run(
        {
          slug: 'sample-initiative',
          session_id: 'sess-001',
          started: STARTED,
          ended: ENDED,
          track: 'canonical',
          body: '- bullet one\n- bullet two\n',
        },
        makeCtx(activeRoot),
      );

      expect(result.filename).toBe('2026-05-12-0900-sess-001.md');
      const expectedPath = path.join(
        activeRoot,
        'sample-initiative',
        'sessions',
        '2026-05-12-0900-sess-001.md',
      );
      expect(result.path).toBe(expectedPath);

      const raw = await fs.readFile(expectedPath, 'utf8');
      expect(raw).toContain('session_id: sess-001');
      expect(raw).toContain('track: canonical');
      expect(raw).toContain('- bullet one');
    });
  });

  it('appends -1 suffix on collision', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const args = {
        slug: 'sample-initiative',
        session_id: 'collide',
        started: STARTED,
        ended: ENDED,
        track: 'canonical' as const,
        body: 'first\n',
      };
      const first = await sessionRecord.run(args, makeCtx(activeRoot));
      const second = await sessionRecord.run(
        { ...args, body: 'second\n' },
        makeCtx(activeRoot),
      );

      expect(first.filename).toBe('2026-05-12-0900-collide.md');
      expect(second.filename).toBe('2026-05-12-0900-collide-1.md');

      await fs.access(first.path);
      await fs.access(second.path);
    });
  });

  it('rejects invalid track value', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await expect(
        sessionRecord.run(
          {
            slug: 'sample-initiative',
            session_id: 'bad-track',
            started: STARTED,
            ended: ENDED,
            // @ts-expect-error testing bad input
            track: 'nope',
            body: '',
          },
          makeCtx(activeRoot),
        ),
      ).rejects.toThrow(/Frontmatter validation failed/);
    });
  });

  it('rejects ended < started', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await expect(
        sessionRecord.run(
          {
            slug: 'sample-initiative',
            session_id: 'reverse',
            started: ENDED,
            ended: STARTED,
            track: 'canonical',
            body: '',
          },
          makeCtx(activeRoot),
        ),
      ).rejects.toThrow(/Frontmatter validation failed/);
    });
  });
});

describe('session.list', () => {
  it('returns sessions sorted by ended desc', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      // Fixture has 2026-05-10-1430-fixture001.md ended at 16:00.
      await sessionRecord.run(
        {
          slug: 'sample-initiative',
          session_id: 'newer',
          started: '2026-05-11T08:00:00Z',
          ended: '2026-05-11T09:00:00Z',
          track: 'canonical',
          body: 'newer body\n',
        },
        makeCtx(activeRoot),
      );
      await sessionRecord.run(
        {
          slug: 'sample-initiative',
          session_id: 'newest',
          started: '2026-05-12T08:00:00Z',
          ended: '2026-05-12T09:00:00Z',
          track: 'sidecar',
          body: 'newest body\n',
        },
        makeCtx(activeRoot),
      );

      const result = await sessionList.run(
        { slug: 'sample-initiative' },
        makeCtx(activeRoot),
      );

      expect(result.errors).toEqual([]);
      expect(result.sessions.map((s) => s.frontmatter.session_id)).toEqual([
        'newest',
        'newer',
        'fixture001',
      ]);
    });
  });

  it('truncates to limit', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await sessionRecord.run(
        {
          slug: 'sample-initiative',
          session_id: 'extra',
          started: '2026-05-12T08:00:00Z',
          ended: '2026-05-12T09:00:00Z',
          track: 'canonical',
          body: 'x\n',
        },
        makeCtx(activeRoot),
      );

      const result = await sessionList.run(
        { slug: 'sample-initiative', limit: 1 },
        makeCtx(activeRoot),
      );

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.frontmatter.session_id).toBe('extra');
    });
  });

  it('extracts first non-empty body line, truncated to 120 chars', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const longLine = 'a'.repeat(200);
      await sessionRecord.run(
        {
          slug: 'sample-initiative',
          session_id: 'preview',
          started: '2026-05-12T08:00:00Z',
          ended: '2026-05-12T09:00:00Z',
          track: 'canonical',
          body: `\n\n${longLine}\nsecond line\n`,
        },
        makeCtx(activeRoot),
      );

      const result = await sessionList.run(
        { slug: 'sample-initiative', limit: 1 },
        makeCtx(activeRoot),
      );
      expect(result.sessions[0]?.first_line).toBe('a'.repeat(120));
    });
  });

  it('reports errors for malformed files', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const sessionsDir = path.join(
        activeRoot,
        'sample-initiative',
        'sessions',
      );
      // Deliberately invalid: missing required frontmatter fields.
      await fs.writeFile(
        path.join(sessionsDir, '2026-05-12-1000-broken.md'),
        '---\nsession_id: broken\n---\n\nincomplete\n',
        'utf8',
      );

      const result = await sessionList.run(
        { slug: 'sample-initiative' },
        makeCtx(activeRoot),
      );

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.filename).toBe('2026-05-12-1000-broken.md');
      expect(result.errors[0]?.error).toMatch(/Frontmatter validation failed/);
      // The valid fixture is still returned.
      expect(result.sessions.map((s) => s.frontmatter.session_id)).toContain(
        'fixture001',
      );
    });
  });
});
