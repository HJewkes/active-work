import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '../utils/fs-atomic.js';
import { getMinerRoot } from '../utils/paths.js';

/**
 * The Drain transcript reader's resume state: `<minerRoot>/reader-state.json`.
 *
 * Two jobs, both forced by the `Locator` contract in
 * `src/schemas/template.ts` — `[transcriptIndex, byteOffset, byteLength]`:
 *
 *  1. It *is* the transcript table. `transcripts[i]` defines what
 *     `transcriptIndex === i` means, so entries are only ever appended and
 *     never reordered; a stored locator would otherwise start pointing at a
 *     different file every time the corpus grew.
 *  2. It carries the per-transcript byte watermark, so a second pass reads
 *     only the bytes appended since the first.
 *
 * `occurrences.jsonl` is NOT usable as the resume point even though it holds
 * locators: it records only the blobs that clustered, so the highest offset in
 * it is the last *eligible* line, not the last line read — resuming there
 * would re-scan (and re-count) every line after it. This mirrors
 * `session-index/watermark.ts`'s byte-watermark-per-transcript design, minus
 * SQLite, since this store is plain files.
 */

const TranscriptStateSchema = z.object({
  /** `~`-relative path, matching `session-index/discover.ts`'s display form. */
  path: z.string().min(1),
  lastByteOffset: z.number().int().nonnegative().default(0),
  /** sha256 of bytes `[0, lastByteOffset)`; detects rewrite vs. append. */
  prefixHash: z.string().nullable().default(null),
  /**
   * `tool_use_id -> tool name` pairs seen but not yet consumed by a result.
   * Persisted because a chunk boundary routinely falls between an assistant's
   * `tool_use` and the user line carrying its result.
   */
  pendingToolNames: z.record(z.string(), z.string()).default({}),
});

export const ReaderStateSchema = z.object({
  version: z.literal(1).default(1),
  transcripts: z.array(TranscriptStateSchema).default([]),
});

export type TranscriptState = z.infer<typeof TranscriptStateSchema>;
export type ReaderState = z.infer<typeof ReaderStateSchema>;

/**
 * Cap on carried-forward `tool_use` ids per transcript. A tool call whose
 * result never arrives (interrupt, crash, compaction) would otherwise leak an
 * entry forever; the newest ids are the ones a result can still reference.
 */
export const MAX_PENDING_TOOL_NAMES = 256;

export function readerStatePath(root: string = getMinerRoot()): string {
  return path.join(root, 'reader-state.json');
}

export async function loadReaderState(root: string = getMinerRoot()): Promise<ReaderState> {
  try {
    const raw = await fs.readFile(readerStatePath(root), 'utf8');
    return ReaderStateSchema.parse(JSON.parse(raw));
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return { version: 1, transcripts: [] };
    }
    throw err;
  }
}

export async function saveReaderState(
  state: ReaderState,
  root: string = getMinerRoot(),
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await atomicWrite(
    readerStatePath(root),
    `${JSON.stringify(ReaderStateSchema.parse(state), null, 2)}\n`,
  );
}

/** Drop all but the newest `MAX_PENDING_TOOL_NAMES` insertions. */
export function trimPendingToolNames(names: Map<string, string>): Record<string, string> {
  const entries = [...names.entries()];
  return Object.fromEntries(entries.slice(-MAX_PENDING_TOOL_NAMES));
}

/**
 * Index of `displayPath` in the transcript table, appending it on first sight.
 * The returned index is the `transcriptIndex` every locator from this file
 * carries, so it must stay stable for the life of the store.
 */
export function transcriptIndexFor(state: ReaderState, displayPath: string): number {
  const existing = state.transcripts.findIndex((t) => t.path === displayPath);
  if (existing !== -1) return existing;
  state.transcripts.push({
    path: displayPath,
    lastByteOffset: 0,
    prefixHash: null,
    pendingToolNames: {},
  });
  return state.transcripts.length - 1;
}
