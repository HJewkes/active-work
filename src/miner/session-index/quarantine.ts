import type { SessionIndexDb } from './db.js';
import { extractTranscript } from './extract.js';
import {
  advanceWatermark,
  ensureTranscript,
  fileDurability,
  markTranscriptStatus,
} from './watermark.js';
import { applyExtractResult } from './writer.js';

export interface IndexOutcome {
  path: string;
  status: 'indexed' | 'unchanged' | 'quarantined' | 'missing';
  /** Rows appended by this pass — 0 for an already-current transcript. */
  factsAdded: number;
  reason?: string;
}

export interface IndexTranscriptInput {
  absolutePath: string;
  displayPath: string;
}

/**
 * Index one transcript, isolating failure to that transcript.
 *
 * A malformed line, an unreadable file, or a schema violation marks the
 * transcript's row and returns — one bad file in a corpus of thousands must
 * never abort the run (§CASS quarantine). The watermark is only advanced by a
 * successful `applyExtractResult`, so a quarantined transcript is retried in
 * full on the next pass once its source is repaired.
 */
export async function indexTranscript(
  db: SessionIndexDb,
  input: IndexTranscriptInput,
): Promise<IndexOutcome> {
  const row = ensureTranscript(db, input.displayPath);
  try {
    const result = await extractTranscript(input.absolutePath, {
      fromByteOffset: row.lastByteOffset,
      priorPrefixHash: row.prefixHash,
    });
    const durability = await fileDurability(input.absolutePath);
    applyExtractResult(db, row.transcriptId, result);
    advanceWatermark(db, row.transcriptId, {
      lastByteOffset: result.lastByteOffset,
      prefixHash: result.prefixHash,
      ...durability,
    });
    return {
      path: input.displayPath,
      status: result.facts.length > 0 ? 'indexed' : 'unchanged',
      factsAdded: result.facts.length,
    };
  } catch (err) {
    return quarantine(db, row.transcriptId, input.displayPath, err);
  }
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
    reason,
  };
}
