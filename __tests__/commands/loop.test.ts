import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import loopOpenCmd from '../../src/commands/loop-open.js';
import loopResolveCmd from '../../src/commands/loop-resolve.js';
import { NotFoundError, ValidationError } from '../../src/errors.js';
import { SessionFrontmatterSchema } from '../../src/schemas/session.js';
import {
  deriveOpenLoops,
  deriveResolvedLoops,
  findDanglingResolves,
} from '../../src/sessions/open-loops.js';
import { writeSessionFile } from '../../src/sessions/session-file.js';
import { readFrontmatter } from '../../src/utils/gray-matter-io.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

function initiativeDir(root: string): string {
  return path.join(root, SLUG);
}

async function sessionFiles(root: string): Promise<string[]> {
  return (await fs.readdir(path.join(initiativeDir(root), 'sessions'))).sort();
}

function open(root: string, overrides: Record<string, unknown> = {}) {
  const args = loopOpenCmd.args.parse({ slug: SLUG, text: 'Restore the pool', ...overrides });
  return loopOpenCmd.run(args, makeCtx(root));
}

function resolve(root: string, id: string, overrides: Record<string, unknown> = {}) {
  const args = loopResolveCmd.args.parse({ slug: SLUG, id, ...overrides });
  return loopResolveCmd.run(args, makeCtx(root));
}

/** A loop the way `wrap` files it: one of several next_steps in a real session record. */
async function wrapOpened(root: string, sessionId: string, ended: string, ids: string[]) {
  const written = await writeSessionFile({
    slug: SLUG,
    activeRoot: root,
    session_id: sessionId,
    started: ended,
    ended,
    track: 'canonical',
    body: 'narrative\n',
    next_steps: ids.map((id) => ({ id, text: `do ${id}`, kind: 'prose' as const })),
  });
  return written.filename.replace(/\.md$/, '');
}

describe('loop.open', () => {
  it('files a loop the ledger derives, with no wrap', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await open(root, {
        kind: 'task',
        ref: 'SI-1',
        due: '2026-10-03T18:00:00-06:00',
        id: 'pool-restore',
      });

      const [loop] = await deriveOpenLoops(initiativeDir(root), { now: new Date() });
      expect(loop).toMatchObject({
        ref: res.ref,
        text: 'Restore the pool',
        kind: 'task',
        targetRef: 'SI-1',
        due: '2026-10-03T18:00:00-06:00',
      });
      expect(res.ref).toBe(`${res.session_file}#pool-restore`);
    });
  });

  it('writes a session record the validating reader accepts', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await open(root);

      const { frontmatter, body } = await readFrontmatter(res.path, SessionFrontmatterSchema);
      expect(frontmatter.track).toBe('adhoc');
      expect(frontmatter.next_steps).toEqual([
        { id: 'restore-the-pool', text: 'Restore the pool', kind: 'prose' },
      ]);
      expect(body).toContain('Restore the pool');
    });
  });

  it('derives an id from the text that is a valid ref segment', async () => {
    await withTempActiveRoot(async (root) => {
      const res = await open(root, { text: 'Ask: is PR #57 merged / closed?  ' + 'x'.repeat(80) });

      const id = res.ref.split('#')[1]!;
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(id.length).toBeLessThanOrEqual(48);
      expect(id.endsWith('-')).toBe(false);
    });
  });

  it('refuses a task or pr loop with no ref to watch', () => {
    const result = loopOpenCmd.args.safeParse({ slug: SLUG, text: 'x', kind: 'pr' });

    expect(result.success).toBe(false);
  });

  it('refuses a due time without a timezone', () => {
    const result = loopOpenCmd.args.safeParse({
      slug: SLUG,
      text: 'x',
      due: '2026-10-03T18:00:00',
    });

    expect(result.success).toBe(false);
  });

  it('fails for an initiative that does not exist', async () => {
    await withTempActiveRoot(async (root) => {
      const args = loopOpenCmd.args.parse({ slug: 'no-such-initiative', text: 'x' });

      await expect(loopOpenCmd.run(args, makeCtx(root))).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('loop.resolve', () => {
  it('closes a loop opened a moment earlier outside wrap', async () => {
    await withTempActiveRoot(async (root) => {
      const opened = await open(root);

      const res = await resolve(root, opened.ref);

      const now = new Date();
      expect(await deriveOpenLoops(initiativeDir(root), { now })).toEqual([]);
      const [closed] = await deriveResolvedLoops(initiativeDir(root), { now });
      expect(closed).toMatchObject({ ref: opened.ref, outcome: 'done', closedBy: res.closed_by });
      expect(await findDanglingResolves(initiativeDir(root))).toEqual([]);
    });
  });

  it('closes a loop a wrap opened, even when that session ended in the future', async () => {
    await withTempActiveRoot(async (root) => {
      const ahead = new Date(Date.now() + 60_000).toISOString();
      const stem = await wrapOpened(root, 'sess-a', ahead, ['n1']);

      await resolve(root, `${stem}#n1`);

      expect(await deriveOpenLoops(initiativeDir(root), { now: new Date() })).toEqual([]);
    });
  });

  it('accepts a bare id when one open loop carries it', async () => {
    await withTempActiveRoot(async (root) => {
      const stem = await wrapOpened(root, 'sess-a', '2026-07-20T10:00:00Z', ['n1', 'n2']);

      const res = await resolve(root, 'n2');

      expect(res.ref).toBe(`${stem}#n2`);
      const open = await deriveOpenLoops(initiativeDir(root), { now: new Date() });
      expect(open.map((loop) => loop.ref)).toEqual([`${stem}#n1`]);
    });
  });

  it('records an abandonment with its reason', async () => {
    await withTempActiveRoot(async (root) => {
      const opened = await open(root);

      await resolve(root, opened.ref, { outcome: 'abandoned', note: 'superseded by SI-2' });

      const [closed] = await deriveResolvedLoops(initiativeDir(root), { now: new Date() });
      expect(closed).toMatchObject({ outcome: 'abandoned', note: 'superseded by SI-2' });
    });
  });

  it('requires a reason to abandon', () => {
    const result = loopResolveCmd.args.safeParse({ slug: SLUG, id: 'n1', outcome: 'abandoned' });

    expect(result.success).toBe(false);
  });

  // Regression: a resolve aimed at a closed loop used to succeed, so a mistyped
  // id reported success while the live loop stayed open.
  it('fails, and writes nothing, when the loop is already resolved', async () => {
    await withTempActiveRoot(async (root) => {
      const opened = await open(root);
      await resolve(root, opened.ref);
      const before = await sessionFiles(root);

      const again = resolve(root, opened.ref);

      await expect(again).rejects.toBeInstanceOf(ValidationError);
      await expect(again).rejects.toThrow(/already closed: done/);
      expect(await sessionFiles(root)).toEqual(before);
    });
  });

  it('fails when the loop is already abandoned, quoting why', async () => {
    await withTempActiveRoot(async (root) => {
      const opened = await open(root, { id: 'pool-restore' });
      await resolve(root, opened.ref, { outcome: 'abandoned', note: 'owner said no' });

      await expect(resolve(root, 'pool-restore')).rejects.toThrow(
        /already closed: abandoned.*owner said no/,
      );
    });
  });

  it('fails when a bare id names several open loops, listing their refs', async () => {
    await withTempActiveRoot(async (root) => {
      const first = await wrapOpened(root, 'sess-a', '2026-07-20T10:00:00Z', ['n1']);
      const second = await wrapOpened(root, 'sess-b', '2026-07-21T10:00:00Z', ['n1']);

      const attempt = resolve(root, 'n1');

      await expect(attempt).rejects.toBeInstanceOf(ValidationError);
      await expect(attempt).rejects.toThrow(`${first}#n1, ${second}#n1`);
    });
  });

  it('prefers the open loop when a closed one shares its bare id', async () => {
    await withTempActiveRoot(async (root) => {
      const first = await wrapOpened(root, 'sess-a', '2026-07-20T10:00:00Z', ['n1']);
      await resolve(root, `${first}#n1`);
      const second = await wrapOpened(root, 'sess-b', '2026-07-21T10:00:00Z', ['n1']);

      const res = await resolve(root, 'n1');

      expect(res.ref).toBe(`${second}#n1`);
    });
  });

  it('fails when no loop matches the id', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(resolve(root, 'no-such-loop')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('leaves a loop opened outside wrap closable by a later wrap', async () => {
    await withTempActiveRoot(async (root) => {
      const opened = await open(root);
      const later = new Date(Date.now() + 60_000).toISOString();

      await writeSessionFile({
        slug: SLUG,
        activeRoot: root,
        session_id: 'sess-wrap',
        started: later,
        ended: later,
        track: 'canonical',
        body: 'narrative\n',
        resolves: [{ ref: opened.ref, outcome: 'done' }],
      });

      expect(await findDanglingResolves(initiativeDir(root))).toEqual([]);
      expect(await deriveOpenLoops(initiativeDir(root), { now: new Date() })).toEqual([]);
    });
  });
});
