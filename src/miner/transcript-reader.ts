import { promises as fs } from 'node:fs';
import { MinerIngestor } from './index.js';
import { collectToolUses, extractBlobs } from './blob-extract.js';
import {
  loadReaderState,
  saveReaderState,
  transcriptIndexFor,
  trimPendingToolNames,
  type ReaderState,
  type TranscriptState,
} from './reader-state.js';
import { discoverTranscripts, transcriptsRoot } from './session-index/discover.js';
import { readJsonLines } from './session-index/json-lines.js';
import { prefixHash } from './session-index/prefix-hash.js';
import { getMinerRoot } from '../utils/paths.js';
import type { Locator } from '../schemas/template.js';

/**
 * AW-89: streams `~/.claude/projects/*<slash>*.jsonl` into
 * `MinerIngestor.ingestBlob`, the last build step deferred from AW-28/PR #81.
 *
 * Incremental by byte watermark per transcript (`reader-state.json`), reusing
 * `session-index`'s `discover` / `json-lines` / `prefix-hash` primitives so
 * the two miners agree on what a transcript is and where a line starts. What
 * is deliberately *not* shared is the extraction model: session-index indexes
 * every line, this reads whole tool-result blobs, because Drain clusters a
 * blob's shape through one signature line.
 *
 * Ingest runs buffered: one `templates.yml` write and one `occurrences.jsonl`
 * append per pass rather than per blob. Clustering is untouched by this — see
 * `MinerIngestorOptions.buffered`.
 */

export interface DrainIngestOptions {
  /** Miner store root; overridable for tests and eval sandboxes. */
  root?: string;
  /** Transcript corpus root. */
  corpusRoot?: string;
  /** Visit at most this many transcripts. */
  limit?: number;
  /** Ignore stored watermarks and re-read every transcript from byte 0. */
  full?: boolean;
  /**
   * Stop reading each transcript after this many new bytes, leaving the
   * watermark mid-file. Exists so the eval can force chunk boundaries that a
   * static corpus would never produce on its own.
   */
  chunkBytes?: number;
  /**
   * Re-hash each transcript's already-read prefix to detect a rewrite rather
   * than an append. Off by default because it is O(corpus) per pass; a file
   * that *shrank* below its watermark is always detected, hash or not.
   */
  verifyHashes?: boolean;
  /**
   * Record a `(blobs, templates)` sample every N blobs. Feeds the eval's
   * template-growth curve, which has to be sampled *within* one pass: slicing
   * the corpus by transcript instead makes slice size swing by two orders of
   * magnitude, and the resulting rates measure transcript size, not clustering.
   */
  sampleEvery?: number;
}

/** One `(blobs seen, templates known)` sample from the growth curve. */
export interface GrowthSample {
  blobs: number;
  templates: number;
  /** Whether any Drain partition was already evicting at this point. */
  evicting: boolean;
}

export interface DrainIngestSummary {
  startedAt: string;
  durationMs: number;
  /** Transcripts discovered in the corpus. */
  transcripts: number;
  /** Transcripts this pass actually opened (the rest were at their watermark). */
  scanned: number;
  unchanged: number;
  /** Transcripts rewound to byte 0 because the source was rewritten. */
  rewound: number;
  linesRead: number;
  /** Lines that were not parseable JSON — counted, skipped, never fatal. */
  malformedLines: number;
  /** Eligible blobs found. */
  blobs: number;
  /** Blobs that clustered successfully (`blobs - ingestErrors`). */
  ingested: number;
  newTemplates: number;
  /** Total templates in the store after this pass. */
  templates: number;
  /** Growth curve samples; empty unless `sampleEvery` was set. */
  curve: GrowthSample[];
  /** Any Drain partition is at its LRU cap — see `DrainTree.atCapacity`. */
  evicting: boolean;
  errors: string[];
}

interface PassCounters {
  linesRead: number;
  malformedLines: number;
  blobs: number;
  ingested: number;
  newTemplates: number;
  curve: GrowthSample[];
  errors: string[];
}

function emptyCounters(): PassCounters {
  return {
    linesRead: 0,
    malformedLines: 0,
    blobs: 0,
    ingested: 0,
    newTemplates: 0,
    curve: [],
    errors: [],
  };
}

/**
 * Where to resume in `absolutePath`, and with what carried-forward tool names.
 *
 * A file shorter than its watermark was rewritten or truncated, so every
 * stored offset past that point is meaningless and the only correct answer is
 * byte 0. `verifyHashes` extends the same check to a same-length rewrite.
 */
async function resumePoint(
  entry: TranscriptState,
  absolutePath: string,
  options: DrainIngestOptions,
): Promise<{ start: number; size: number; rewound: boolean }> {
  const { size } = await fs.stat(absolutePath);
  if (options.full) return { start: 0, size, rewound: false };

  let rewound = size < entry.lastByteOffset;
  if (!rewound && options.verifyHashes && entry.prefixHash !== null) {
    rewound = (await prefixHash(absolutePath, entry.lastByteOffset)) !== entry.prefixHash;
  }
  return { start: rewound ? 0 : entry.lastByteOffset, size, rewound };
}

/** Parse a line, counting (not throwing on) transcript corruption. */
function parseLine(text: string, counters: PassCounters): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    counters.malformedLines++;
    return null;
  }
}

interface TranscriptPass {
  transcriptIndex: number;
  absolutePath: string;
  start: number;
  entry: TranscriptState;
}

/**
 * Read one transcript from its watermark, ingesting every eligible blob.
 *
 * The watermark only ever advances to a *completed* line boundary
 * (`readJsonLines` withholds a trailing partial line), so a transcript being
 * appended to mid-pass resumes cleanly instead of splitting a record.
 */
async function readTranscript(
  pass: TranscriptPass,
  ingestor: MinerIngestor,
  counters: PassCounters,
  options: DrainIngestOptions,
): Promise<void> {
  const toolNames = new Map(Object.entries(pass.entry.pendingToolNames));
  let offset = pass.start;

  for await (const line of readJsonLines(pass.absolutePath, pass.start)) {
    offset = line.byteOffset + line.byteLength + 1;
    counters.linesRead++;
    const parsed = parseLine(line.text, counters);
    if (parsed) {
      for (const [id, name] of collectToolUses(parsed)) toolNames.set(id, name);
      const locator: Locator = [pass.transcriptIndex, line.byteOffset, line.byteLength];
      await ingestLine(parsed, locator, toolNames, ingestor, counters, options.sampleEvery);
    }
    if (options.chunkBytes !== undefined && offset - pass.start >= options.chunkBytes) break;
  }

  pass.entry.lastByteOffset = offset;
  pass.entry.pendingToolNames = trimPendingToolNames(toolNames);
  pass.entry.prefixHash = options.verifyHashes ? await prefixHash(pass.absolutePath, offset) : null;
}

async function ingestLine(
  parsed: Record<string, unknown>,
  locator: Locator,
  toolNames: Map<string, string>,
  ingestor: MinerIngestor,
  counters: PassCounters,
  sampleEvery: number | undefined,
): Promise<void> {
  for (const blob of extractBlobs(parsed, toolNames)) {
    counters.blobs++;
    try {
      const result = await ingestor.ingestBlob({ ...blob, locator });
      counters.ingested++;
      if (result.isNewTemplate) counters.newTemplates++;
      if (sampleEvery !== undefined && counters.blobs % sampleEvery === 0) {
        counters.curve.push({
          blobs: counters.blobs,
          templates: ingestor.templateCount,
          evicting: ingestor.evicting,
        });
      }
    } catch (err) {
      counters.errors.push(
        `${locator[0]}:${locator[1]} ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * One full pass over the corpus. Idempotent in the sense that matters for a
 * template store: re-running it over unchanged transcripts reads nothing and
 * changes nothing, and a chunked sequence of passes converges to the same
 * template set as a single pass (asserted by `tools/eval-drain.mjs`).
 */
export async function runDrainIngest(
  options: DrainIngestOptions = {},
): Promise<DrainIngestSummary> {
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const root = options.root ?? getMinerRoot();
  const corpusRoot = options.corpusRoot ?? transcriptsRoot();

  const discovered = await discoverTranscripts(corpusRoot);
  const visiting = options.limit === undefined ? discovered : discovered.slice(0, options.limit);
  const state: ReaderState = options.full
    ? { version: 1, transcripts: [] }
    : await loadReaderState(root);
  const ingestor = await MinerIngestor.create(root, { buffered: true });

  const counters = emptyCounters();
  let scanned = 0;
  let unchanged = 0;
  let rewound = 0;

  for (const transcript of visiting) {
    const transcriptIndex = transcriptIndexFor(state, transcript.displayPath);
    const entry = state.transcripts[transcriptIndex];
    try {
      const point = await resumePoint(entry, transcript.absolutePath, options);
      if (point.rewound) {
        rewound++;
        entry.pendingToolNames = {};
      }
      if (point.start >= point.size && !point.rewound) {
        unchanged++;
        continue;
      }
      scanned++;
      await readTranscript(
        { transcriptIndex, absolutePath: transcript.absolutePath, start: point.start, entry },
        ingestor,
        counters,
        options,
      );
    } catch (err) {
      counters.errors.push(
        `${transcript.displayPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await ingestor.flush();
  await saveReaderState(state, root);

  return {
    startedAt,
    durationMs: Number(process.hrtime.bigint() - started) / 1e6,
    transcripts: discovered.length,
    scanned,
    unchanged,
    rewound,
    templates: ingestor.templateCount,
    evicting: ingestor.evicting,
    ...counters,
  };
}
