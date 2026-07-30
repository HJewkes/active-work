import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import contextGraph from '../../src/commands/context-graph.js';
import { withTempActiveRoot, withEmptyActiveRoot } from '../setup/test-helpers.js';
import type { CommandContext } from '../../src/registry/index.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

const SLUG = 'sample-initiative';

function initiativeDir(activeRoot: string): string {
  return path.join(activeRoot, SLUG);
}

async function writeSession(
  activeRoot: string,
  filename: string,
  frontmatter: string,
  body: string,
): Promise<void> {
  const file = path.join(initiativeDir(activeRoot), 'sessions', filename);
  await fs.writeFile(file, `---\n${frontmatter}---\n\n${body}\n`, 'utf8');
}

async function writeTask(activeRoot: string, id: string, extra: string): Promise<void> {
  const file = path.join(initiativeDir(activeRoot), 'tasks', `${id}.yml`);
  await fs.writeFile(
    file,
    [
      `id: ${id}`,
      `title: Task ${id}`,
      'priority: 9',
      'status: open',
      extra,
      'created: 2026-05-09',
      'updated: 2026-05-10',
      'done_at: null',
      '',
    ].join('\n'),
    'utf8',
  );
}

function run(activeRoot: string, id: string, slug?: string) {
  return contextGraph.run(
    contextGraph.args.parse({ id, ...(slug ? { slug } : {}) }),
    makeCtx(activeRoot),
  );
}

describe('context.graph', () => {
  it('resolves a task id to its own file as the subject', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await run(activeRoot, 'SI-1', SLUG);

      expect(result.kind).toBe('task');
      expect(result.subject).toEqual({
        kind: 'task',
        slug: SLUG,
        file: path.join('tasks', 'SI-1.yml'),
        title: 'First sample task',
      });
      expect(result.errors).toEqual([]);
    });
  });

  it('joins a task id across sessions, sibling tasks, and artifacts', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeTask(activeRoot, 'SI-9', 'notes: Blocked until SI-1 lands.');
      await writeSession(
        activeRoot,
        '2026-05-11-0900-join.md',
        [
          'session_id: join\n',
          'started: 2026-05-11T09:00:00Z\n',
          'ended: 2026-05-11T10:00:00Z\n',
          'track: canonical\n',
          'next_steps:\n',
          '  - id: step1\n',
          '    text: Finish SI-1 review\n',
          '    kind: task\n',
          '    ref: SI-1\n',
        ].join(''),
        'Picked up SI-1 today.',
      );
      await fs.writeFile(
        path.join(initiativeDir(activeRoot), 'artifacts.yml'),
        [
          'branches:',
          '  - repo: ~/code/sample',
          '    name: feat/si-1-first-task',
          'stashes: []',
          'worktrees: []',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await run(activeRoot, 'SI-1', SLUG);
      const seen = result.references.map((r) => `${r.source}:${r.field}`);

      expect(result.errors).toEqual([]);
      expect(seen).toContain('task:notes');
      expect(seen).toContain('session:next_steps[0].ref');
      expect(seen).toContain('session:next_steps[0].text');
      expect(seen).toContain('session:body:L2');
      // Case-insensitive so lowercased branch names still join.
      expect(seen).toContain('artifacts:branches[0].name');
    });
  });

  it('resolves a loop ref to its next_step and finds the resolving session', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeSession(
        activeRoot,
        '2026-05-11-0900-opener.md',
        [
          'session_id: opener\n',
          'started: 2026-05-11T09:00:00Z\n',
          'ended: 2026-05-11T10:00:00Z\n',
          'track: canonical\n',
          'next_steps:\n',
          '  - id: step1\n',
          '    text: Sketch the join\n',
          '    kind: prose\n',
        ].join(''),
        'opened a loop',
      );
      await writeSession(
        activeRoot,
        '2026-05-12-0900-closer.md',
        [
          'session_id: closer\n',
          'started: 2026-05-12T09:00:00Z\n',
          'ended: 2026-05-12T10:00:00Z\n',
          'track: canonical\n',
          'resolves:\n',
          '  - ref: 2026-05-11-0900-opener#step1\n',
          '    outcome: done\n',
        ].join(''),
        'closed it',
      );

      const result = await run(activeRoot, '2026-05-11-0900-opener#step1', SLUG);

      expect(result.kind).toBe('loop');
      expect(result.subject).toMatchObject({
        kind: 'loop',
        title: 'Sketch the join',
        file: path.join('sessions', '2026-05-11-0900-opener.md'),
      });
      expect(result.references).toHaveLength(1);
      expect(result.references[0]).toMatchObject({
        source: 'session',
        file: path.join('sessions', '2026-05-12-0900-closer.md'),
        field: 'resolves[0].ref',
      });
    });
  });

  it('matches whole ID tokens only', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeTask(activeRoot, 'SI-9', 'notes: Related to SI-10, not SI-1.');

      const result = await run(activeRoot, 'SI-10', SLUG);

      expect(result.subject).toBeNull();
      expect(result.references).toHaveLength(1);
      expect(result.references[0].field).toBe('notes');
    });
  });

  it('scans every initiative when no slug is given', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await run(activeRoot, 'SI-1');
      expect(result.initiatives_scanned).toEqual([SLUG]);
    });
  });

  it('returns an empty graph for an unknown id on an empty root', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const result = await run(activeRoot, 'ZZ-1');

      expect(result).toEqual({
        id: 'ZZ-1',
        kind: 'task',
        subject: null,
        references: [],
        initiatives_scanned: [],
        errors: [],
      });
    });
  });

  it('reports unreadable files without aborting the scan', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await fs.writeFile(
        path.join(initiativeDir(activeRoot), 'tasks', 'broken.yml'),
        'id: not a task id\n',
        'utf8',
      );

      const result = await run(activeRoot, 'SI-1', SLUG);

      expect(result.subject).not.toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].file).toBe(path.join('tasks', 'broken.yml'));
    });
  });
});
