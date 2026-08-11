import { promises as fs, type Stats } from 'node:fs';
import type { SessionIndexDb } from './db.js';
import { extractTranscript } from './extract.js';
import { prefixHash } from './prefix-hash.js';
import { purgeTranscript } from './purge.js';
import {
  advanceWatermark,
  ensureTranscript,
  fileDurability,
  markTranscriptStatus,
  type TranscriptRow,
} from './watermark.js';
import { applyExtractResult } from './writer.js';

export interface IndexOutcome {
  path: string;
  status: 'indexed' | 'unchanged' | 'quarantined' | 'missing';
  /** Rows appended by this pass — 0 for an already-current transcript. */
  factsAdded: number;
  /** Session ids this pass touched, for the caller's rollup scope. */
  sessionIds: string[];
  reason?: string;
}

export interface IndexTranscriptInput {
  absolutePath: string;
  displayPath: string;
  /** See `DiscoveredTranscript.subagentId`; null for ordinary transcripts. */
  subagentId?: string | null;
}

export interface IndexTranscriptOptions {
  /**
   * Stream a full sha256 of the transcript to refresh `content_hash`. Off by
   * default: it is O(file) and the stat pair already answers "did this grow?".
   */
  verifyContentHash?: boolean;
  /** Bytes ingested per transaction; see `CHUNK_BYTES`. */
  chunkBytes?: number;
}

/**
 * Bytes read per transaction. Bounds peak memory (an extract result holds every
 * row — including span text — for its chunk) and keeps the chunk-boundary
 * invariant continuously exercised rather than only in tests.
 */
export const CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Index one transcript, isolating failure to that transcript.
 *
 * A malformed line, an unreadable file, or a schema violation marks the
 * transcript's row and returns — one bad file in a corpus of thousands must
 * never abort the run (§CASS quarantine). The watermark is only advanced by a
 * successful chunk, so a quarantined transcript resumes from the last good
 * boundary on the next pass once its source is repaired.
 */
export async function indexTranscript(
  db: SessionIndexDb,
  input: IndexTranscriptInput,
  options: IndexTranscriptOptions = {},
): Promise<IndexOutcome> {
  const row = ensureTranscript(db, input.displayPath);
  try {
    const stat = await fs.stat(input.absolutePath);
    if (isUpToDate(row, stat, options)) {
      return { path: input.displayPath, status: 'unchanged', factsAdded: 0, sessionIds: [] };
    }
    const ingested = await ingestChunks(db, input, row, stat, options);
    advanceWatermark(db, row.transcriptId, {
      lastByteOffset: ingested.lastByteOffset,
      // Only null when nothing has ever been committed for this transcript, so
      // the offset is 0 and this hash is the (constant) empty digest.
      prefixHash: ingested.prefixHash ?? (await prefixHash(input.absolutePath, 0)),
      ...(await fileDurability(input.absolutePath, options.verifyContentHash ?? false)),
    });
    return {
      path: input.displayPath,
      status: ingested.factsAdded > 0 ? 'indexed' : 'unchanged',
      factsAdded: ingested.factsAdded,
      sessionIds: [...ingested.sessionIds],
    };
  } catch (err) {
    return quarantine(db, row.transcriptId, input.displayPath, err);
  }
}

/**
 * Size and mtime both unchanged on a healthy row means no new bytes to read —
 * skip opening the file entirely. This is what keeps an incremental pass over a
 * multi-gigabyte corpus proportional to what actually changed.
 */
function isUpToDate(row: TranscriptRow, stat: Stats, options: IndexTranscriptOptions): boolean {
  if (options.verifyContentHash) return false;
  return (
    row.status === 'ok' &&
    row.fileSize === stat.size &&
    row.fileMtime === stat.mtime.toISOString() &&
    row.lastIndexedAt !== null
  );
}

interface Ingested {
  lastByteOffset: number;
  /** `null` until a chunk commits and no prior hash was stored. */
  prefixHash: string | null;
  factsAdded: number;
  sessionIds: Set<string>;
}

/**
 * Read forward from the watermark in bounded chunks, committing each one.
 *
 * A chunk that consumes no complete line is either an oversized single record
 * or a trailing partial line on a file still being appended to. Growing the
 * window distinguishes them: once the window covers the rest of the file and
 * still yields nothing, there is no complete record left and we stop.
 */
async function ingestChunks(
  db: SessionIndexDb,
  input: IndexTranscriptInput,
  row: TranscriptRow,
  stat: Stats,
  options: IndexTranscriptOptions,
): Promise<Ingested> {
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  const state: Ingested = {
    // A watermark past EOF means the file was truncated; clamping it lets the
    // first pass reach `resolveStartOffset`, which is what detects the rewrite.
    lastByteOffset: Math.min(row.lastByteOffset, stat.size),
    prefixHash: row.prefixHash,
    factsAdded: 0,
    sessionIds: new Set(),
  };
  let priorPrefixHash = row.prefixHash;
  let window = chunkBytes;
  let firstPass = true;

  while (firstPass || state.lastByteOffset < stat.size) {
    firstPass = false;
    const result = await extractTranscript(input.absolutePath, {
      fromByteOffset: state.lastByteOffset,
      priorPrefixHash,
      untilByteOffset: state.lastByteOffset + window,
      subagentId: input.subagentId,
    });
    const advanced = result.lastByteOffset > result.startByteOffset;
    if (!advanced && !result.restartedFromZero) {
      if (state.lastByteOffset + window >= stat.size) break;
      window *= 2;
      continue;
    }
    db.transaction(() => {
      if (result.restartedFromZero) purgeTranscript(db, row.transcriptId);
      applyExtractResult(db, row.transcriptId, result);
    })();
    state.lastByteOffset = result.lastByteOffset;
    state.prefixHash = result.prefixHash;
    state.factsAdded += result.facts.length;
    for (const session of result.sessions) state.sessionIds.add(session.sessionId);
    priorPrefixHash = result.prefixHash;
    window = chunkBytes;
    // A rewrite restarts at zero; without this the loop could re-detect the
    // same mismatch forever if the file kept failing to advance.
    if (result.restartedFromZero && !advanced) break;
  }

  return state;
}

function quarantine(
  db: SessionIndexDb,
  transcriptId: number,
  displayPath: string,
  err: unknown,
): IndexOutcome {
  const missing = err instanceof Error && 'code' in err && err.code === 'ENOENT';
  const reason = err instanceof Error ? err.message : String(err);
  markTranscriptStatus(db, transcriptId, missing ? 'missing' : 'quarantined', reason);
  return {
    path: displayPath,
    status: missing ? 'missing' : 'quarantined',
    factsAdded: 0,
    sessionIds: [],
    reason,
  };
}
