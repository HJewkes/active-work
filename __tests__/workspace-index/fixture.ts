import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openGraph, type WorkspaceGraph } from '../../src/session-index/graph.js';
import { refreshWorkspace } from '../../src/workspace-index/refresh.js';

/**
 * A miniature active root with the properties the live one has and the naive
 * schema could not survive: one `session_id` written by files in two different
 * initiatives, a task filed twice under `tasks/` and `tasks/archive/`, notes
 * sharing tags across an initiative boundary, and notes naming ids that live
 * somewhere else.
 */

export function writeFile(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

export function removeFile(root: string, relativePath: string): void {
  rmSync(path.join(root, ...relativePath.split('/')), { force: true });
}

function brief(slug: string, prefix: string): string {
  return [
    '---',
    'schema_version: 5',
    `title: ${slug} initiative`,
    'updated: 2026-09-01',
    'state: backburner',
    `task_prefix: ${prefix}`,
    '---',
    '',
    `The ${slug} initiative exists to prove the indexer works.`,
    '',
    '## Detail',
    '',
    'A second paragraph nobody reads.',
    '',
  ].join('\n');
}

function note(title: string, tags: string[], body: string): string {
  return [
    '---',
    'kind: process',
    `title: ${title}`,
    'created: 2026-09-02',
    ...(tags.length > 0 ? ['tags:', ...tags.map((t) => `  - ${t}`)] : []),
    '---',
    '',
    body,
    '',
  ].join('\n');
}

function task(id: string, title: string, status: string): string {
  return [
    `id: ${id}`,
    `title: ${title}`,
    'priority: 1',
    'done_when: the index converges',
    'notes: a note field that FTS should reach',
    `status: ${status}`,
    'created: 2026-09-01',
    'updated: 2026-09-02',
    'done_at: null',
    '',
  ].join('\n');
}

function session(id: string, started: string): string {
  return [
    '---',
    `session_id: ${id}`,
    `started: ${started}`,
    `ended: ${started}`,
    'track: canonical',
    'next_steps: []',
    'resolves: []',
    '---',
    '',
    '## What happened',
    '',
    'The indexer was written.',
    '',
    '## What is left',
    '',
    'Verifying it against the live corpus.',
    '',
  ].join('\n');
}

/** The shared id: two initiatives record the same migration session, as `handoff-migration` really does. */
export const SHARED_SESSION_ID = 'handoff-migration';

export function scaffold(root: string): void {
  writeFile(root, 'alpha/brief.md', brief('alpha', 'AL'));
  writeFile(root, 'beta/brief.md', brief('beta', 'BE'));

  writeFile(root, 'alpha/tasks/AL-1.yml', task('AL-1', 'Build the indexer', 'open'));
  writeFile(root, 'alpha/tasks/archive/AL-1.yml', task('AL-1', 'Build the indexer', 'done'));
  writeFile(root, 'beta/tasks/BE-7.yml', task('BE-7', 'Consume the index', 'open'));

  writeFile(
    root,
    'alpha/sessions/2026-09-02-0900-alpha-one.md',
    session('alpha-one', '2026-09-02T09:00:00Z'),
  );
  writeFile(
    root,
    `alpha/sessions/2026-07-13-2316-${SHARED_SESSION_ID}.md`,
    session(SHARED_SESSION_ID, '2026-07-13T23:16:00Z'),
  );
  writeFile(
    root,
    `beta/sessions/2026-07-13-2316-${SHARED_SESSION_ID}.md`,
    session(SHARED_SESSION_ID, '2026-07-13T23:16:00Z'),
  );

  writeFile(
    root,
    'alpha/sources/notes/2026-09-02-alpha-lesson.md',
    note(
      'The alpha lesson',
      ['worktree', 'process'],
      'This one references BE-7 in another initiative.',
    ),
  );
  writeFile(
    root,
    'beta/sources/notes/2026-09-02-beta-lesson.md',
    note('The beta lesson', ['worktree'], 'And this one names sources/design.md at home.'),
  );
  writeFile(
    root,
    'beta/sources/notes/2026-09-03-beta-second.md',
    note('The second beta lesson', ['process'], 'Nothing cross-initiative here.'),
  );

  writeFile(root, 'beta/sources/design.md', '# The beta design\n\nProse a search should find.\n');
}

export async function refreshInto(
  dbPath: string,
  root: string,
  full = false,
): Promise<WorkspaceGraph> {
  const graph = openGraph(dbPath);
  await refreshWorkspace(graph, { activeRoot: root, full });
  return graph;
}
