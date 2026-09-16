import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getStateRoot } from '../utils/paths.js';

/**
 * Every retrieved hit a session was shown, one JSON line each.
 *
 * "Shown to a session" is the signal note promotion (TP-27 Half B) was waiting
 * for. It lives in the state dir rather than the graph because the index is
 * derived and disposable, and a rebuild must not erase the history of what
 * was surfaced.
 */

export type HitTrigger = 'bootstrap-loop' | 'bootstrap-foreign';

export interface HitLogEntry {
  ts: string;
  slug: string;
  trigger: HitTrigger;
  /** The text the hit was retrieved for. */
  query: string;
  ref: string;
  /** 1-based, within the list the hit was rendered in. */
  rank: number;
}

/** Resolves to an error message when the append failed, null when it did not. */
export type HitLogWriter = (entries: HitLogEntry[]) => Promise<string | null>;

export function hitLogPath(): string {
  return path.join(getStateRoot(), 'retrieval-hits.jsonl');
}

/** Best effort: a failed append is returned for the caller to report, never thrown. */
export function fileHitLog(file: string = hitLogPath()): HitLogWriter {
  return async (entries) => {
    if (entries.length === 0) return null;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, entries.map((entry) => JSON.stringify(entry) + '\n').join(''));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
}
