import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { v1ToV2Artifacts } from '../../src/migrations/v1-to-v2-artifacts.js';

const TEMP_PREFIX = path.join(tmpdir(), 'aw-mig-');

interface Workspace {
  archiveRoot: string;
  activeRoot: string;
}

async function setup(): Promise<Workspace> {
  const archiveRoot = mkdtempSync(TEMP_PREFIX);
  // emulate the canonical layout: <archiveRoot>/active-work/ is the activeRoot.
  const activeRoot = path.join(archiveRoot, 'active-work');
  await mkdir(activeRoot, { recursive: true });
  return { archiveRoot, activeRoot };
}

function cleanup(ws: Workspace): void {
  rmSync(ws.archiveRoot, { recursive: true, force: true });
}

async function writeFile_(p: string, body: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, body, 'utf8');
}

describe('v1ToV2Artifacts migrator', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await setup();
  });

  afterEach(() => {
    cleanup(ws);
  });

  it('drops prs[], last_commit, and renames stash message → label for active initiatives', async () => {
    const file = path.join(ws.activeRoot, 'sample', 'artifacts.yml');
    await writeFile_(
      file,
      [
        'prs:',
        '  - number: 42',
        '    repo: HJewkes/sample',
        '    title: Sample PR',
        '    status: open',
        '    last_checked: 2026-05-10T16:00:00Z',
        'branches:',
        '  - repo: ~/code/sample',
        '    name: feat/sample',
        '    last_commit: 2026-05-10',
        'stashes:',
        '  - repo: ~/code/sample',
        '    message: WIP zod schemas',
        '    created: 2026-05-12',
        '',
      ].join('\n'),
    );

    await v1ToV2Artifacts.run(ws.activeRoot);

    const after = await readFile(file, 'utf8');
    expect(after).not.toContain('prs:');
    expect(after).not.toContain('last_commit');
    expect(after).not.toContain('message:');
    expect(after).not.toContain('created:');
    expect(after).toContain('label: WIP zod schemas');
    expect(after).toContain('feat/sample');

    const log = await readFile(path.join(ws.activeRoot, '.migrations.log'), 'utf8');
    expect(log).toContain('#42 (HJewkes/sample) Sample PR');
  });

  it('is a no-op on already-v2 files', async () => {
    const file = path.join(ws.activeRoot, 'sample', 'artifacts.yml');
    const v2Body = ['branches:', '  - repo: ~/code/sample', '    name: feat/sample', 'stashes: []', ''].join('\n');
    await writeFile_(file, v2Body);

    await v1ToV2Artifacts.run(ws.activeRoot);

    const after = await readFile(file, 'utf8');
    expect(after).toBe(v2Body);
    // No log entry written for a clean file.
    await expect(readFile(path.join(ws.activeRoot, '.migrations.log'), 'utf8')).rejects.toThrow();
  });

  it('preserves an existing note when migrating a branch', async () => {
    const file = path.join(ws.activeRoot, 'sample', 'artifacts.yml');
    await writeFile_(
      file,
      [
        'prs: []',
        'branches:',
        '  - repo: ~/code/sample',
        '    name: feat/sample',
        '    last_commit: 2026-05-10',
        '    note: keep this context',
        'stashes: []',
        '',
      ].join('\n'),
    );
    await v1ToV2Artifacts.run(ws.activeRoot);
    const after = await readFile(file, 'utf8');
    expect(after).toContain('note: keep this context');
    expect(after).not.toContain('last_commit');
  });

  it('migrates archived initiatives under <archiveRoot>/<domain>/archive/*', async () => {
    const archivedFile = path.join(
      ws.archiveRoot,
      'engineering',
      'archive',
      'old-2025-12',
      'artifacts.yml',
    );
    await writeFile_(
      archivedFile,
      [
        'prs:',
        '  - number: 7',
        '    repo: HJewkes/old',
        '    title: Old PR',
        '    status: merged',
        '    last_checked: 2025-12-01T10:00:00Z',
        'branches: []',
        'stashes: []',
        '',
      ].join('\n'),
    );

    await v1ToV2Artifacts.run(ws.activeRoot);

    const after = await readFile(archivedFile, 'utf8');
    expect(after).not.toContain('prs:');

    const log = await readFile(path.join(ws.activeRoot, '.migrations.log'), 'utf8');
    expect(log).toContain('#7 (HJewkes/old) Old PR');
  });

  it('handles a missing prs key gracefully but still removes last_commit', async () => {
    const file = path.join(ws.activeRoot, 'sample', 'artifacts.yml');
    await writeFile_(
      file,
      [
        'branches:',
        '  - repo: ~/code/sample',
        '    name: feat/sample',
        '    last_commit: 2026-05-10',
        'stashes: []',
        '',
      ].join('\n'),
    );
    await v1ToV2Artifacts.run(ws.activeRoot);
    const after = await readFile(file, 'utf8');
    expect(after).not.toContain('last_commit');
    expect(after).toContain('feat/sample');
  });
});
