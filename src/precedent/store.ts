import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listInitiativeSlugs } from '../lint/index.js';
import { atomicWrite, withFileLock } from '../utils/fs-atomic.js';
import { PrecedentRowSchema, type PrecedentRow } from './schema.js';

/**
 * Precedent rows live inside the active root and nowhere else: one JSONL file
 * per initiative under `sources/`, and a root-level file for rows no
 * initiative claims. Rows are only ever appended, keyed by `key`, so a re-run
 * writes nothing it has already written.
 */

export const PRECEDENT_FILE = 'precedents.jsonl';
export const GLOBAL_PRECEDENT_FILE = '.precedents.jsonl';

export function precedentFileFor(activeRoot: string, initiative: string | null): string {
  return initiative === null
    ? path.join(activeRoot, GLOBAL_PRECEDENT_FILE)
    : path.join(activeRoot, initiative, 'sources', PRECEDENT_FILE);
}

export interface ReadRows {
  rows: PrecedentRow[];
  malformed: number;
}

async function readText(file: string): Promise<string> {
  return fs.readFile(file, 'utf8').catch(() => '');
}

function parseRows(text: string): ReadRows {
  const out: ReadRows = { rows: [], malformed: 0 };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.rows.push(PrecedentRowSchema.parse(JSON.parse(line)));
    } catch {
      out.malformed += 1;
    }
  }
  return out;
}

export async function readPrecedentFile(file: string): Promise<ReadRows> {
  return parseRows(await readText(file));
}

export async function precedentFiles(activeRoot: string): Promise<string[]> {
  const slugs = await listInitiativeSlugs(activeRoot);
  return [null, ...slugs].map((slug) => precedentFileFor(activeRoot, slug));
}

export async function readAllPrecedents(activeRoot: string): Promise<ReadRows> {
  const all: ReadRows = { rows: [], malformed: 0 };
  for (const file of await precedentFiles(activeRoot)) {
    const { rows, malformed } = await readPrecedentFile(file);
    all.rows.push(...rows);
    all.malformed += malformed;
  }
  return all;
}

/**
 * Append rows whose key the file does not hold yet; returns how many were written.
 * One `AskUserQuestion` call yields a row per question, all sharing the call's key.
 */
export async function appendPrecedents(file: string, rows: PrecedentRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  return withFileLock(file, async () => {
    const existing = await readText(file);
    const { rows: held } = parseRows(existing);
    const seen = new Set(held.map((row) => row.key));
    const fresh = rows.filter((row) => !seen.has(row.key));
    const lines = fresh.map((row) => JSON.stringify(PrecedentRowSchema.parse(row)) + '\n');
    if (lines.length === 0) return 0;
    const prefix = existing === '' || existing.endsWith('\n') ? existing : existing + '\n';
    await atomicWrite(file, prefix + lines.join(''));
    return lines.length;
  });
}
