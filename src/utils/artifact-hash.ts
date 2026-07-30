import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { atomicWrite } from './fs-atomic.js';

const MANIFEST_FILENAME = '.artifact-hashes.yml';

/**
 * Which structured artifacts get drift-tracked, and their manifest key.
 *
 * Sessions and notes are intentionally excluded — only the files CLAUDE.md
 * calls "CLI-only" (tasks/*.yml, artifacts.yml, brief frontmatter) are in
 * scope for AW-66.
 */
export function classifyStructuredArtifact(
  filePath: string,
): { initiativeDir: string; relPath: string } | null {
  const base = path.basename(filePath);
  const dir = path.dirname(filePath);
  if (base === 'artifacts.yml' || base === 'brief.md') {
    return { initiativeDir: dir, relPath: base };
  }
  if (base.endsWith('.yml') && path.basename(dir) === 'tasks') {
    return { initiativeDir: path.dirname(dir), relPath: path.posix.join('tasks', base) };
  }
  return null;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function readManifest(initiativeDir: string): Promise<Record<string, string>> {
  const manifestPath = path.join(initiativeDir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  return parsed as Record<string, string>;
}

/** Manifest of `relPath -> sha256(content)` for every tracked artifact that has been CLI-written. */
export async function readArtifactHashes(initiativeDir: string): Promise<Record<string, string>> {
  return readManifest(initiativeDir);
}

/**
 * Record the hash of `content` for `relPath` in the initiative's manifest.
 *
 * Called from inside `writeYaml`/`writeFrontmatter` right after the real
 * write, so every CLI write path tracks itself with no call-site changes.
 */
export async function recordArtifactHash(
  initiativeDir: string,
  relPath: string,
  content: string,
): Promise<void> {
  const manifest = await readManifest(initiativeDir);
  manifest[relPath] = hashContent(content);
  const manifestPath = path.join(initiativeDir, MANIFEST_FILENAME);
  await atomicWrite(manifestPath, YAML.stringify(manifest));
}
