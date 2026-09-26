/**
 * Reading one file out of an initiative for a caller that has no filesystem of
 * its own (Hermes, over MCP). The initiative directory is the whole of what it
 * may see, so every path is resolved through symlinks and then checked against
 * the initiative's real path before a byte is read.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NotFoundError, UsageError } from '../errors.js';

/** Large enough for any hand-written source, small enough for one MCP reply. */
export const MAX_READ_BYTES = 200 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.jsonl',
  '.yml',
  '.yaml',
  '.csv',
  '.tsv',
]);

export interface SourceReadResult {
  /** Path relative to the initiative directory, `/`-separated. */
  path: string;
  content: string;
  truncated: boolean;
  /** Size of the whole file, not of `content`. */
  bytes: number;
}

/**
 * Where a requested path points before symlinks are resolved.
 *
 * Accepts the three forms a caller holds: absolute, relative to the active
 * root as `search` returns it (`<slug>/sources/x.md`), or relative to the
 * initiative directory (`sources/x.md`).
 */
export function candidatePath(activeRoot: string, slug: string, requested: string): string {
  if (path.isAbsolute(requested)) return requested;
  if (requested.startsWith(`${slug}/`)) return path.join(activeRoot, requested);
  return path.join(activeRoot, slug, requested);
}

async function realpathOrNotFound(target: string, label: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (err) {
    throw new NotFoundError(`${label} not found: ${target}`, { cause: err });
  }
}

/** The real path of `candidate`, refused unless it sits strictly inside `initiativeDir`. */
async function resolveInside(
  initiativeDir: string,
  candidate: string,
): Promise<{ realDir: string; realTarget: string }> {
  const realDir = await realpathOrNotFound(initiativeDir, 'Initiative');
  const realTarget = await realpathOrNotFound(candidate, 'File');
  const relative = path.relative(realDir, realTarget);
  const escapes = relative === '..' || relative.startsWith(`..${path.sep}`);
  if (relative === '' || escapes || path.isAbsolute(relative)) {
    throw new UsageError(`Path is outside the initiative directory: ${candidate}`);
  }
  return { realDir, realTarget };
}

function assertTextType(realTarget: string): void {
  const extension = path.extname(realTarget).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return;
  const named = extension === '' ? 'a file with no extension' : `'${extension}'`;
  throw new UsageError(
    `Cannot read ${named}: only text sources are supported (${[...TEXT_EXTENSIONS].join(', ')}).`,
  );
}

async function readCapped(file: string, cap: number): Promise<{ content: string; bytes: number }> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, cap));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const decoded = buffer.subarray(0, bytesRead).toString('utf8');
    // A cap can split a multi-byte character; drop the half it leaves behind.
    const content = size > cap ? decoded.replace(/�$/, '') : decoded;
    return { content, bytes: size };
  } finally {
    await handle.close();
  }
}

/** Read a text file inside an initiative, capped at `cap` bytes. */
export async function readInitiativeFile(
  activeRoot: string,
  slug: string,
  requested: string,
  cap: number = MAX_READ_BYTES,
): Promise<SourceReadResult> {
  const initiativeDir = path.join(activeRoot, slug);
  const { realDir, realTarget } = await resolveInside(
    initiativeDir,
    candidatePath(activeRoot, slug, requested),
  );
  const stat = await fs.stat(realTarget);
  if (!stat.isFile()) throw new UsageError(`Not a regular file: ${requested}`);
  assertTextType(realTarget);
  const { content, bytes } = await readCapped(realTarget, cap);
  return {
    path: path.relative(realDir, realTarget).split(path.sep).join('/'),
    content,
    truncated: bytes > cap,
    bytes,
  };
}
