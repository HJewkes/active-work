import type { Statement } from 'better-sqlite3';
import type { WorkspaceGraph } from '../session-index/graph.js';
import type { WorkspaceClass } from './scan.js';
import type { WorkspaceRecord } from './read.js';
import { WORKSPACE_SPAN_SOURCE_BASE } from './schema.js';

/**
 * Rows and spans for one file, replaced whole.
 *
 * A workspace file is rewritten in place constantly — every `task edit`
 * rewrites a YAML file — so there is no append-only fast path and no partial
 * update. A changed file has its row and its spans deleted and rewritten, which
 * at roughly 2,200 small files costs less than the machinery to avoid it.
 */

interface ClassTable {
  table: string;
  refColumn: string;
  columns: readonly string[];
}

/** Column order per class, matching `schema.ts`. `path` and the ref column are prepended by the writer. */
const TABLES: Record<WorkspaceClass, ClassTable> = {
  initiative: {
    table: 'initiative',
    refColumn: 'initiative_ref',
    columns: ['slug', 'title', 'state', 'rank', 'ship_target', 'owner', 'task_prefix', 'updated'],
  },
  note: {
    table: 'note',
    refColumn: 'note_ref',
    columns: ['initiative', 'filename', 'kind', 'title', 'created', 'tags', 'hits', 'promoted_at'],
  },
  task: {
    table: 'workspace_task',
    refColumn: 'task_ref',
    columns: [
      'initiative',
      'task_id',
      'title',
      'status',
      'priority',
      'severity',
      'estimate',
      'tags',
      'created',
      'updated',
      'done_at',
    ],
  },
  session: {
    table: 'session_record',
    refColumn: 'session_ref',
    columns: ['initiative', 'session_id', 'started', 'ended', 'track', 'parent_session_id'],
  },
  source: {
    table: 'source',
    refColumn: 'source_ref',
    columns: ['initiative', 'title', 'kind', 'added'],
  },
};

const CLASSES = Object.keys(TABLES) as WorkspaceClass[];

function insertSql({ table, refColumn, columns }: ClassTable): string {
  const all = ['path', refColumn, ...columns];
  const names = all.map((c) => `"${c}"`).join(', ');
  return `INSERT OR REPLACE INTO "${table}" (${names}) VALUES (${all.map(() => '?').join(', ')})`;
}

/** The span locator for a workspace file; see `WORKSPACE_SPAN_SOURCE_BASE`. */
export function spanSourceId(watermarkId: number): number {
  return WORKSPACE_SPAN_SOURCE_BASE + watermarkId;
}

/** Prepared statements over the workspace tables. Construct once per pass. */
export class WorkspaceWriter {
  private readonly inserts: Record<WorkspaceClass, Statement>;
  private readonly deletes: Statement[];
  private readonly deleteSpans: Statement;

  constructor(private readonly graph: WorkspaceGraph) {
    this.inserts = Object.fromEntries(
      CLASSES.map((cls) => [cls, graph.db.prepare(insertSql(TABLES[cls]))]),
    ) as Record<WorkspaceClass, Statement>;
    this.deletes = CLASSES.map((cls) =>
      graph.db.prepare(`DELETE FROM "${TABLES[cls].table}" WHERE path = ?`),
    );
    this.deleteSpans = graph.db.prepare('DELETE FROM search_span WHERE source_id = ?');
  }

  /**
   * Delete every row and span one file produced.
   *
   * Spans go by `source_id`, not by owner ref: `session:` owners are shared
   * with the transcript side of the same table, so purging by owner would take
   * a mined transcript's spans with it. The offset id names the file alone.
   *
   * This is the *opposite* of the transcript policy in the same database. A
   * transcript that disappears keeps its rows on purpose — Claude Code prunes
   * transcripts, and the sessions they witnessed still happened. A workspace
   * file that disappears was deleted or archived by the operator, and its rows
   * are a claim about a file that no longer says anything.
   */
  purge(relativePath: string, watermarkId: number): void {
    for (const statement of this.deletes) statement.run(relativePath);
    this.deleteSpans.run(spanSourceId(watermarkId));
  }

  /**
   * Write one record's row and spans, replacing whatever the file produced
   * before. Not transactional on its own — the caller batches many of these
   * into one transaction, because a WAL commit per file is the difference
   * between a pass that runs in a moment and one that does not.
   */
  apply(record: WorkspaceRecord, watermarkId: number): void {
    const spec = TABLES[record.file.class];
    this.purge(record.file.path, watermarkId);
    this.inserts[record.file.class].run(
      record.file.path,
      record.ref,
      ...spec.columns.map((column) => record.row[column] ?? null),
    );
    for (const span of record.spans) {
      this.graph.spans.index(
        {
          ownerRef: record.ref,
          field: span.field,
          sourceId: spanSourceId(watermarkId),
          byteOffset: span.byteOffset,
          byteLength: span.byteLength,
        },
        span.text,
      );
    }
  }
}

/**
 * Clear every workspace table and rewind every workspace watermark.
 *
 * The mirror of `session-graph`'s `resetIndex`, and it exists for the same
 * reason: rewinding alone is not enough, because the next pass would write a
 * second copy of everything. Edges and FTS spans live in tables the session
 * graph shares, so `resetIndex` clears those; this clears what is ours alone.
 */
export function resetWorkspaceIndex(graph: WorkspaceGraph): void {
  graph.db.transaction(() => {
    for (const cls of CLASSES) graph.db.exec(`DELETE FROM "${TABLES[cls].table}"`);
    for (const row of graph.workspaceFiles.list()) graph.workspaceFiles.rewind(row.sourceKey);
  })();
}
