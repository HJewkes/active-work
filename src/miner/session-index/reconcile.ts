import { promises as fs } from 'node:fs';
import type { SessionIndexDb } from './db.js';
import { toAbsolutePath, type DiscoveredTranscript } from './discover.js';
import { markTranscriptStatus } from './watermark.js';

/**
 * Mark transcripts whose source file is gone.
 *
 * `indexTranscript` can only reach the `missing` status for a file that
 * vanishes between discovery and the stat that follows it — a race. The far
 * commoner case is a file deleted before the pass started: discovery never
 * yields it, nothing visits its row, and the row keeps saying `ok` forever. On
 * the live corpus that was 412 of 1477 rows (28%) while `miner status` reported
 * `missing: 0`.
 *
 * Derived rows are deliberately left in place. Facts mined from a transcript
 * outlive it on purpose — surviving Claude Code's own pruning is much of why
 * this index exists — so `missing` marks the *source* as unavailable (locators
 * into it can no longer be resolved) rather than retracting what it taught us.
 */

/**
 * Absence from `discovered` only nominates a row; an `fs.stat` decides. That
 * second check is what keeps a discovery that returned nothing — an unreadable
 * root, a mistyped `root` override — from marking the entire corpus missing,
 * and what stops a row indexed under a different root from being condemned by
 * a scan that was never looking for it.
 */
export async function reconcileMissingTranscripts(
  db: SessionIndexDb,
  discovered: readonly DiscoveredTranscript[],
): Promise<number> {
  const present = new Set(discovered.map((transcript) => transcript.displayPath));
  const rows = db
    .prepare<
      [],
      { transcript_id: number; path: string }
    >("SELECT transcript_id, path FROM transcripts WHERE status <> 'missing'")
    .all();

  let marked = 0;
  for (const row of rows) {
    if (present.has(row.path)) continue;
    if (await exists(toAbsolutePath(row.path))) continue;
    markTranscriptStatus(db, row.transcript_id, 'missing', 'source file no longer exists');
    marked += 1;
  }
  return marked;
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}
