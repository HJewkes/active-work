import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyStructuredArtifact,
  hashContent,
  readArtifactHashes,
  recordArtifactHash,
} from '../../src/utils/artifact-hash.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-artifact-hash-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('classifyStructuredArtifact', () => {
  it('matches artifacts.yml', () => {
    expect(classifyStructuredArtifact('/root/demo/artifacts.yml')).toEqual({
      initiativeDir: '/root/demo',
      relPath: 'artifacts.yml',
    });
  });

  it('matches brief.md', () => {
    expect(classifyStructuredArtifact('/root/demo/brief.md')).toEqual({
      initiativeDir: '/root/demo',
      relPath: 'brief.md',
    });
  });

  it('matches tasks/*.yml', () => {
    expect(classifyStructuredArtifact('/root/demo/tasks/AW-3.yml')).toEqual({
      initiativeDir: '/root/demo',
      relPath: 'tasks/AW-3.yml',
    });
  });

  it('does not match session files', () => {
    expect(classifyStructuredArtifact('/root/demo/sessions/2026-07-30-a.md')).toBeNull();
  });

  it('does not match notes', () => {
    expect(classifyStructuredArtifact('/root/demo/sources/notes/x.md')).toBeNull();
  });

  it('does not match an unrelated .yml file outside tasks/', () => {
    expect(classifyStructuredArtifact('/root/demo/sources/other.yml')).toBeNull();
  });
});

describe('artifact hash manifest', () => {
  it('round-trips a recorded hash', async () => {
    await recordArtifactHash(dir, 'tasks/AW-1.yml', 'id: AW-1\n');
    const manifest = await readArtifactHashes(dir);
    expect(manifest['tasks/AW-1.yml']).toBe(hashContent('id: AW-1\n'));
  });

  it('returns an empty manifest when none exists yet', async () => {
    expect(await readArtifactHashes(dir)).toEqual({});
  });

  it('is tolerant of a corrupt manifest file', async () => {
    const { promises: fs } = await import('node:fs');
    await fs.writeFile(path.join(dir, '.artifact-hashes.yml'), '{ not: valid: yaml');
    expect(await readArtifactHashes(dir)).toEqual({});
  });

  it('updates an existing entry without disturbing others', async () => {
    await recordArtifactHash(dir, 'artifacts.yml', 'a');
    await recordArtifactHash(dir, 'brief.md', 'b');
    await recordArtifactHash(dir, 'artifacts.yml', 'a2');
    const manifest = await readArtifactHashes(dir);
    expect(manifest.artifacts).toBeUndefined();
    expect(manifest['artifacts.yml']).toBe(hashContent('a2'));
    expect(manifest['brief.md']).toBe(hashContent('b'));
  });
});
