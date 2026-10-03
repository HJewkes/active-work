import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  LedgerRowSchema,
  openLedgerStore,
  type LedgerRow,
  type LedgerRowWire,
  type LedgerSource,
  type LedgerStore,
  type SourceRead,
  type SourceWatermarks,
} from '@titan-design/decider';
import { listInitiativeSlugs } from '../lint/index.js';

/**
 * The decider ledger lives in one SQLite file inside the active root. The v1
 * `precedents.jsonl` files (one per initiative, plus the root-level file for
 * unclaimed rows) are no longer written; they are read as a ledger source so
 * their rows reach the ledger, and search reads them until they have.
 */

export const PRECEDENT_FILE = 'precedents.jsonl';
export const GLOBAL_PRECEDENT_FILE = '.precedents.jsonl';
export const V1_SOURCE = 'precedents-jsonl';

export function ledgerPath(activeRoot: string): string {
  return path.join(activeRoot, '.decider', 'decider.sqlite3');
}

export function openLedger(activeRoot: string): LedgerStore {
  const file = ledgerPath(activeRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  return openLedgerStore(file);
}

export function precedentFileFor(activeRoot: string, initiative: string | null): string {
  return initiative === null
    ? path.join(activeRoot, GLOBAL_PRECEDENT_FILE)
    : path.join(activeRoot, initiative, 'sources', PRECEDENT_FILE);
}

async function precedentFiles(activeRoot: string): Promise<string[]> {
  const slugs = await listInitiativeSlugs(activeRoot);
  return [null, ...slugs].map((slug) => precedentFileFor(activeRoot, slug));
}

export interface V1Rows {
  rows: LedgerRowWire[];
  malformed: number;
}

function parseV1(text: string): V1Rows {
  const out: V1Rows = { rows: [], malformed: 0 };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const wire = JSON.parse(line) as LedgerRowWire;
      LedgerRowSchema.parse(wire);
      out.rows.push(wire);
    } catch {
      out.malformed += 1;
    }
  }
  return out;
}

async function readBytes(file: string): Promise<Buffer | null> {
  return fs.readFile(file).catch(() => null);
}

export async function readV1Precedents(activeRoot: string): Promise<V1Rows> {
  const all: V1Rows = { rows: [], malformed: 0 };
  for (const file of await precedentFiles(activeRoot)) {
    const bytes = await readBytes(file);
    if (bytes === null) continue;
    const { rows, malformed } = parseV1(bytes.toString('utf8'));
    all.rows.push(...rows);
    all.malformed += malformed;
  }
  return all;
}

function contentHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** One cursor per v1 file, keyed by path; an unchanged file is not re-parsed. */
export function v1PrecedentSource(activeRoot: string): LedgerSource {
  return {
    name: V1_SOURCE,
    async read(since: SourceWatermarks): Promise<SourceRead> {
      const out: SourceRead = { candidates: [], watermarks: new Map(), pending: 0, errors: [] };
      for (const file of await precedentFiles(activeRoot)) {
        const bytes = await readBytes(file);
        if (bytes === null) continue;
        const watermark = { offset: bytes.length, prefixHash: contentHash(bytes) };
        if (since.get(file)?.prefixHash === watermark.prefixHash) continue;
        const { rows, malformed } = parseV1(bytes.toString('utf8'));
        if (malformed > 0) out.errors.push(`${file}: ${malformed} malformed rows skipped`);
        out.candidates.push(...rows.map((row) => ({ row, cwd: null })));
        out.watermarks.set(file, watermark);
      }
      return out;
    },
  };
}

/** Ledger rows plus v1 rows not yet extracted into it; a key the ledger holds wins. */
export async function readLedgerRows(
  activeRoot: string,
): Promise<{ rows: LedgerRow[]; malformed: number }> {
  const held = existsSync(ledgerPath(activeRoot)) ? readStore(activeRoot) : [];
  const keys = new Set(held.map((row) => row.key));
  const v1 = await readV1Precedents(activeRoot);
  const fresh = new Map<string, LedgerRow>();
  for (const wire of v1.rows) {
    if (!keys.has(wire.key) && !fresh.has(wire.key)) {
      fresh.set(wire.key, LedgerRowSchema.parse(wire));
    }
  }
  return { rows: [...held, ...fresh.values()], malformed: v1.malformed };
}

function readStore(activeRoot: string): LedgerRow[] {
  const store = openLedger(activeRoot);
  try {
    return store.rows();
  } finally {
    store.db.close();
  }
}
