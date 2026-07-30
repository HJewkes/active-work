import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import wrap from '../../src/commands/wrap.js';
import sessionList from '../../src/commands/session-list.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import type { CommandContext } from '../../src/registry/index.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

/** `wrap` is the only way to write a session file; use it to seed the list. */
function writeSession(
  activeRoot: string,
  overrides: Record<string, unknown>,
): Promise<{ path: string; filename: string }> {
  return wrap.run(
    wrap.args.parse({
      slug: 'sample-initiative',
      track: 'canonical',
      no_loops: true,
      no_notes: true,
      no_tasks: true,
      ...overrides,
    }),
    makeCtx(activeRoot),
  );
}

describe('session.list', () => {
  it('returns sessions sorted by ended desc', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      // Fixture has 2026-05-10-1430-fixture001.md ended at 16:00.
      await writeSession(activeRoot, {
        session_id: 'newer',
        started: '2026-05-11T08:00:00Z',
        ended: '2026-05-11T09:00:00Z',
        body: 'newer body\n',
      });
      await writeSession(activeRoot, {
        session_id: 'newest',
        started: '2026-05-12T08:00:00Z',
        ended: '2026-05-12T09:00:00Z',
        track: 'sidecar',
        body: 'newest body\n',
      });

      const result = await sessionList.run({ slug: 'sample-initiative' }, makeCtx(activeRoot));

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
      await writeSession(activeRoot, {
        session_id: 'extra',
        started: '2026-05-12T08:00:00Z',
        ended: '2026-05-12T09:00:00Z',
        body: 'x\n',
      });

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
      await writeSession(activeRoot, {
        session_id: 'preview',
        started: '2026-05-12T08:00:00Z',
        ended: '2026-05-12T09:00:00Z',
        body: `\n\n${longLine}\nsecond line\n`,
      });

      const result = await sessionList.run(
        { slug: 'sample-initiative', limit: 1 },
        makeCtx(activeRoot),
      );
      expect(result.sessions[0]?.first_line).toBe('a'.repeat(120));
    });
  });

  it('reports errors for malformed files', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const sessionsDir = path.join(activeRoot, 'sample-initiative', 'sessions');
      // Deliberately invalid: missing required frontmatter fields.
      await fs.writeFile(
        path.join(sessionsDir, '2026-05-12-1000-broken.md'),
        '---\nsession_id: broken\n---\n\nincomplete\n',
        'utf8',
      );

      const result = await sessionList.run({ slug: 'sample-initiative' }, makeCtx(activeRoot));

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.filename).toBe('2026-05-12-1000-broken.md');
      expect(result.errors[0]?.error).toMatch(/Frontmatter validation failed/);
      // The valid fixture is still returned.
      expect(result.sessions.map((s) => s.frontmatter.session_id)).toContain('fixture001');
    });
  });
});
