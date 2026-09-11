import { promises as fs } from 'node:fs';
import matter from 'gray-matter';
import { z } from 'zod';
import type { WorkspaceGraph } from '../session-index/graph.js';
import { getActiveRoot } from '../utils/paths.js';
import { rebuildEdges, type EdgeCounts, type NoteFacts } from './edges.js';
import { readRecord, type WorkspaceRecord } from './read.js';
import { scanWorkspace, type WorkspaceClass, type WorkspaceFile } from './scan.js';
import { toAbsolute } from './refs.js';
import { WorkspaceWriter } from './write.js';

/**
 * One pass over the whole active root: every initiative, not one.
 *
 * Cross-initiative relevance is a retrieval property rather than a filing
 * property, so there is exactly one index and no scope argument. What an
 * initiative is becomes a ranking signal for TP-25, never a fence here.
 */

export interface WorkspaceRefreshSummary {
  files: number;
  indexed: number;
  unchanged: number;
  /** Files gone from the scan whose rows were deleted. */
  removed: number;
  malformed: { path: string; reason: string }[];
  rows: Record<WorkspaceClass, number>;
  edges: EdgeCounts;
  /**
   * Fraction of FTS rows with no span behind them, across both halves of the
   * database.
   *
   * It is not zero after a deletion and it cannot be. The kit's FTS5 table is
   * `content=''` without `contentless_delete`, so SQLite refuses a plain
   * DELETE and the only supported removal needs the row's original text — which
   * is exactly what a contentless index does not keep. Purging a span therefore
   * strands its FTS row.
   *
   * What is guaranteed is that a stranded row is unreachable: `search` joins
   * through the span table, so a purged span can never be returned. The
   * orphans are wasted bytes, not wrong answers, and `--full` reclaims them by
   * clearing the index and re-streaming every surviving span.
   */
  orphanRatio: number;
}

export interface WorkspaceRefreshOptions {
  activeRoot?: string;
  /** Re-read every file, ignoring the watermarks. Callers reset the tables first. */
  full?: boolean;
}

/**
 * `mtime` plus `size`, the same discriminator `resumePoint` uses, and no
 * prefix hash. Workspace files are rewritten in place rather than appended to,
 * so there is nothing a prefix hash could tell us that the pair does not, and
 * hashing 2,200 files every pass is the cost that gets a check turned off.
 *
 * `lastOffset === 0` is the "never indexed" marker. It has to be, because
 * `rewind` clears the offset but leaves `file_size` and `file_mtime` in place,
 * so a reset followed by a size check alone would report every file unchanged.
 */
function isUnchanged(
  row: { lastOffset: number; fileSize: number | null; fileMtime: string | null },
  file: WorkspaceFile,
): boolean {
  return row.lastOffset > 0 && row.fileSize === file.size && row.fileMtime === file.mtime;
}

/**
 * Files are read in batches and each batch is written in one transaction.
 *
 * Not an optimisation for its own sake: a transaction per file is a WAL commit
 * per file, and 2,162 of them took six seconds where the batched form takes
 * well under one. The batch is bounded rather than whole-corpus so peak memory
 * stays proportional to the batch, since a record carries the text of its own
 * spans until the FTS index has swallowed it.
 */
const BATCH = 200;

interface Attempt {
  file: WorkspaceFile;
  watermarkId: number;
  record: WorkspaceRecord | null;
  reason: string | null;
}

/**
 * One line per rejected file, not the whole zod issue array.
 *
 * `ZodError.message` is the issue list serialised as indented JSON — around 25
 * lines per file. Twelve malformed notes put several hundred lines into every
 * `miner refresh`, which is how a real finding becomes output people scroll
 * past. The field and its reason are the entire signal; the JSON adds nothing.
 */
function describeFailure(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

async function readAttempt(file: WorkspaceFile, watermarkId: number): Promise<Attempt> {
  try {
    return { file, watermarkId, record: await readRecord(file), reason: null };
  } catch (err) {
    return { file, watermarkId, record: null, reason: describeFailure(err) };
  }
}

/**
 * A file that stops parsing loses its rows and is reported as malformed.
 *
 * Keeping the last good row would be the friendlier choice and it is the wrong
 * one: a full rebuild cannot produce that row, so the two would diverge, and
 * convergence is the property everything else here is built on. The row is
 * gone, the watermark says `quarantined`, and the pass names the file.
 */
function applyBatch(graph: WorkspaceGraph, writer: WorkspaceWriter, batch: Attempt[]): void {
  graph.db.transaction(() => {
    for (const attempt of batch) {
      if (attempt.record === null) {
        writer.purge(attempt.file.path, attempt.watermarkId);
        graph.workspaceFiles.markStatus(attempt.file.path, 'quarantined', attempt.reason);
        continue;
      }
      writer.apply(attempt.record, attempt.watermarkId);
      graph.workspaceFiles.advance(attempt.file.path, {
        lastOffset: attempt.file.size,
        fileSize: attempt.file.size,
        fileMtime: attempt.file.mtime,
      });
    }
  })();
}

/**
 * Rows for files the scan no longer sees are deleted, watermark and all.
 *
 * This is the one place the two halves of this database disagree, so it is
 * worth saying plainly. A transcript that disappears keeps its rows: Claude
 * Code prunes transcripts and the sessions they witnessed still happened, so
 * the graph is the last record of them. A workspace file that disappears was
 * archived or deleted by the operator, and keeping its rows would leave the
 * index asserting things about a file that no longer exists — brain's failure,
 * one file at a time.
 */
function removeVanished(
  graph: WorkspaceGraph,
  writer: WorkspaceWriter,
  present: ReadonlySet<string>,
): number {
  let removed = 0;
  for (const row of graph.workspaceFiles.list()) {
    if (present.has(row.sourceKey)) continue;
    writer.purge(row.sourceKey, row.sourceId);
    graph.db.prepare('DELETE FROM workspace_file WHERE source_id = ?').run(row.sourceId);
    removed++;
  }
  return removed;
}

/**
 * Note bodies for the edge pass, read from disk rather than from the index.
 *
 * The index is contentless by design, so it cannot hand back a body — and
 * `mentions` has to be recomputed over the whole corpus every pass anyway,
 * because filing one new task makes an existing note's `TP-40` resolve. 556
 * small files is the price of a full rebuild and an incremental sequence
 * producing the same edges.
 */
async function collectNoteFacts(activeRoot: string, graph: WorkspaceGraph): Promise<NoteFacts[]> {
  const rows = graph.db
    .prepare('SELECT path, note_ref, initiative, tags FROM note ORDER BY path')
    .all() as { path: string; note_ref: string; initiative: string; tags: string | null }[];
  const facts = await Promise.all(
    rows.map(async (row) => ({
      ref: row.note_ref,
      initiative: row.initiative,
      tags: (JSON.parse(row.tags ?? '[]') as string[]) ?? [],
      body: await readBody(toAbsolute(activeRoot, row.path)),
    })),
  );
  return facts;
}

/** The body, not the file: frontmatter is metadata, and `mentions` is defined over prose. */
async function readBody(absolutePath: string): Promise<string> {
  try {
    return matter(await fs.readFile(absolutePath, 'utf8')).content;
  } catch {
    return '';
  }
}

function countRows(graph: WorkspaceGraph): Record<WorkspaceClass, number> {
  const count = (table: string): number =>
    (graph.db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  return {
    initiative: count('initiative'),
    note: count('note'),
    task: count('workspace_task'),
    session: count('session_record'),
    source: count('source'),
  };
}

/** Bring the workspace half of the graph up to date with the active root. */
export async function refreshWorkspace(
  graph: WorkspaceGraph,
  options: WorkspaceRefreshOptions = {},
): Promise<WorkspaceRefreshSummary> {
  const activeRoot = options.activeRoot ?? getActiveRoot();
  const writer = new WorkspaceWriter(graph);
  const files = await scanWorkspace(activeRoot);
  const malformed: { path: string; reason: string }[] = [];
  let indexed = 0;
  let unchanged = 0;

  const changed: { file: WorkspaceFile; watermarkId: number }[] = [];
  graph.db.transaction(() => {
    for (const file of files) {
      const row = graph.workspaceFiles.ensure(file.path);
      if (!options.full && isUnchanged(row, file)) unchanged++;
      else changed.push({ file, watermarkId: row.sourceId });
    }
  })();

  for (let start = 0; start < changed.length; start += BATCH) {
    const batch = await Promise.all(
      changed.slice(start, start + BATCH).map((e) => readAttempt(e.file, e.watermarkId)),
    );
    applyBatch(graph, writer, batch);
    indexed += batch.filter((a) => a.record !== null).length;
    for (const failed of batch.filter((a) => a.record === null)) {
      malformed.push({ path: failed.file.path, reason: failed.reason ?? 'unreadable' });
    }
  }

  const removed = removeVanished(graph, writer, new Set(files.map((f) => f.path)));
  const edges = rebuildEdges(graph, await collectNoteFacts(activeRoot, graph));
  return {
    files: files.length,
    indexed,
    unchanged,
    removed,
    malformed,
    rows: countRows(graph),
    edges,
    orphanRatio: graph.spans.orphanRatio(),
  };
}
