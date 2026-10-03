import type { LedgerRow } from '@titan-design/decider';
import { createRetrievalEngine, ftsRetriever } from '@titan-design/retrieval';
import { openDatabase, SpanFtsTables, spanFtsTablesDdl, type Db } from '@titan-design/store-sqlite';

/**
 * Rank ledger rows for a query with the same BM25 retriever and fusion engine
 * as workspace search. The index is built in memory per query: the corpus is a
 * few thousand short rows, and keeping it out of the graph keeps conversation
 * text out of any file the miner owns.
 */

export interface PrecedentSearchOptions {
  /** Initiatives whose rows are never returned; required so no caller can forget it. */
  humanOnly: ReadonlySet<string>;
  /** Return rows no initiative claims; off by default (TP-695 Q6). */
  includeUnclaimed?: boolean;
  limit?: number;
  /** Bias towards this initiative. A boost, never a filter. */
  initiative?: string;
  /** Only rows of this category. */
  category?: string;
}

export interface PrecedentHit {
  score: number;
  row: LedgerRow;
}

const AFFINITY_BOOST = 0.007;
const OWNER_PREFIX = 'precedent:';

export function isUnclaimed(row: LedgerRow): boolean {
  return row.unclaimed || row.initiative === null;
}

export function visibleRows(rows: LedgerRow[], options: PrecedentSearchOptions): LedgerRow[] {
  return rows.filter((row) => {
    if (row.initiative !== null && options.humanOnly.has(row.initiative)) return false;
    if (isUnclaimed(row) && options.includeUnclaimed !== true) return false;
    return options.category === undefined || row.category === options.category;
  });
}

function searchableText(row: LedgerRow): string {
  const options = row.options.map((o) => o.label).join(' / ');
  return [row.header, row.question, options, row.answer].filter(Boolean).join('\n');
}

function buildIndex(db: Db, rows: LedgerRow[]): SpanFtsTables {
  db.exec(spanFtsTablesDdl());
  const spans = new SpanFtsTables(db);
  rows.forEach((row, i) => {
    const span = {
      ownerRef: `${OWNER_PREFIX}${i}`,
      field: 'text',
      sourceId: i,
      byteOffset: 0,
      byteLength: 0,
    };
    spans.index(span, searchableText(row));
  });
  return spans;
}

export async function searchPrecedents(
  rows: LedgerRow[],
  query: string,
  options: PrecedentSearchOptions,
): Promise<PrecedentHit[]> {
  const limit = options.limit ?? 8;
  const pool = visibleRows(rows, options);
  if (pool.length === 0) return [];
  const db = openDatabase(':memory:');
  try {
    const engine = createRetrievalEngine({ retrievers: [ftsRetriever(buildIndex(db, pool))] });
    const { results } = await engine.search(query, { limit: limit * 3 });
    return rankHits(pool, results, options.initiative).slice(0, limit);
  } finally {
    db.close();
  }
}

function rankHits(
  pool: LedgerRow[],
  results: { id: string; score: number }[],
  initiative: string | undefined,
): PrecedentHit[] {
  const hits = results.map((result) => {
    const row = pool[Number(result.id.slice(OWNER_PREFIX.length))];
    const boost = initiative !== undefined && row.initiative === initiative;
    return { score: result.score + (boost ? AFFINITY_BOOST : 0), row };
  });
  return hits.sort((a, b) => b.score - a.score);
}
