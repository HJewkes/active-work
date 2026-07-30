import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { SessionIndexDb } from './db.js';
import type { TranscriptWatermark } from '../../schemas/session-index.js';

export interface TranscriptRow extends TranscriptWatermark {
  transcriptId: number;
}

const SELECT = `
  SELECT transcript_id, path, last_byte_offset, prefix_hash, last_indexed_at, file_size,
         file_mtime, content_hash, status, quarantine_reason
  FROM transcripts WHERE path = ?`;

interface RawTranscriptRow {
  transcript_id: number;
  path: string;
  last_byte_offset: number;
  prefix_hash: string | null;
  last_indexed_at: string | null;
  file_size: number | null;
  file_mtime: string | null;
  content_hash: string | null;
  status: TranscriptWatermark['status'];
  quarantine_reason: string | null;
}

function toRow(raw: RawTranscriptRow): TranscriptRow {
  return {
    transcriptId: raw.transcript_id,
    path: raw.path,
    lastByteOffset: raw.last_byte_offset,
    prefixHash: raw.prefix_hash,
    lastIndexedAt: raw.last_indexed_at,
    fileSize: raw.file_size,
    fileMtime: raw.file_mtime,
    contentHash: raw.content_hash,
    status: raw.status,
    quarantineReason: raw.quarantine_reason,
  };
}

/** Fetch a transcript's watermark, creating the row on first sight. */
export function ensureTranscript(db: SessionIndexDb, displayPath: string): TranscriptRow {
  db.prepare('INSERT INTO transcripts (path) VALUES (?) ON CONFLICT (path) DO NOTHING').run(
    displayPath,
  );
  return toRow(db.prepare<[string], RawTranscriptRow>(SELECT).get(displayPath)!);
}

export interface WatermarkUpdate {
  lastByteOffset: number;
  prefixHash: string;
  fileSize: number | null;
  fileMtime: string | null;
  contentHash: string | null;
}

export function advanceWatermark(
  db: SessionIndexDb,
  transcriptId: number,
  update: WatermarkUpdate,
): void {
  db.prepare(
    `UPDATE transcripts SET last_byte_offset = @lastByteOffset, prefix_hash = @prefixHash,
       last_indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), file_size = @fileSize,
       file_mtime = @fileMtime, content_hash = @contentHash, status = 'ok',
       quarantine_reason = NULL
     WHERE transcript_id = @transcriptId`,
  ).run({ ...update, transcriptId });
}

export function markTranscriptStatus(
  db: SessionIndexDb,
  transcriptId: number,
  status: TranscriptWatermark['status'],
  reason: string | null,
): void {
  db.prepare(
    'UPDATE transcripts SET status = ?, quarantine_reason = ? WHERE transcript_id = ?',
  ).run(status, reason, transcriptId);
}

/**
 * Size, mtime and whole-file content hash — the durability triple that turns
 * "the source JSONL is gone or was rewritten" into a detectable state instead
 * of silently rotten byte-offset locators.
 */
export async function fileDurability(
  filePath: string,
): Promise<Pick<WatermarkUpdate, 'fileSize' | 'fileMtime' | 'contentHash'>> {
  const stat = await fs.stat(filePath);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return {
    fileSize: stat.size,
    fileMtime: stat.mtime.toISOString(),
    contentHash: hash.digest('hex'),
  };
}
