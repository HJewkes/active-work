import {
  createRetrievalEngine,
  ftsRetriever,
  type Degradation,
  type Retriever,
} from '@titan-design/retrieval';
import { defaultGraphPath, openGraph, type WorkspaceGraph } from '../session-index/graph.js';
import { getActiveRoot } from '../utils/paths.js';
import { SEARCH_CLASSES, capFor, type SearchClass } from './classes.js';
import { resolveHits, type ResolvedHit } from './resolve.js';

/**
 * Search over every initiative at once.
 *
 * There is no scope argument and no default filter, because cross-initiative
 * relevance is a retrieval property rather than a filing one: a fact learned in
 * one initiative has to be findable from another without anyone having filed it
 * twice. `initiative` biases the ranking; it never removes a result. A strong
 * foreign hit beating a weak local one is the entire point.
 */

export interface SearchOptions {
  limit?: number;
  /** Bias towards this initiative. A boost, never a filter. */
  initiative?: string;
  activeRoot?: string;
  dbPath?: string;
  /** Reuse an open graph (the daemon holds one); otherwise one is opened and closed. */
  graph?: WorkspaceGraph;
  excerptWidth?: number;
  /** Search only these classes, by name. Every class when absent. */
  classes?: string[];
  /** The query is already an FTS5 expression; pass it through untouched. */
  rawExpression?: boolean;
}

export interface SearchResult {
  hits: ResolvedHit[];
  /** Retrievers that failed or timed out. Their absence narrows results; it never fails the search. */
  degraded: Degradation[];
  timingsMs: Record<string, number>;
}

/**
 * How much a local hit gains.
 *
 * Bounded on purpose. RRF scores sit around `weight / 60`, so the top of one
 * list is roughly 0.07 and a tenth of that reorders ties and near-ties without
 * letting a weak local hit climb over a strong foreign one.
 */
const AFFINITY_BOOST = 0.007;

function selectClasses(names: string[] | undefined): SearchClass[] {
  return names === undefined
    ? SEARCH_CLASSES
    : SEARCH_CLASSES.filter((cls) => names.includes(cls.name));
}

function classRetriever(
  graph: WorkspaceGraph,
  cls: SearchClass,
  limit: number,
  options: SearchOptions,
): Retriever {
  return ftsRetriever(graph.spans, {
    name: cls.name,
    scope: cls.scope,
    cap: capFor(cls, limit),
    ...(options.rawExpression ? { toMatchExpression: (query: string) => query } : {}),
  });
}

export async function searchWorkspace(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const activeRoot = options.activeRoot ?? getActiveRoot();
  const graph = options.graph ?? openGraph(options.dbPath ?? defaultGraphPath());
  const owned = options.graph === undefined;
  const limit = options.limit ?? 10;
  try {
    const classes = selectClasses(options.classes);
    const engine = createRetrievalEngine({
      retrievers: classes.map((cls) => classRetriever(graph, cls, limit, options)),
      fusion: {
        weights: Object.fromEntries(classes.map((cls) => [cls.name, cls.weight])),
      },
    });

    const response = await engine.search(query, { limit });
    const resolved = await resolveHits(
      graph,
      response.results,
      activeRoot,
      options.excerptWidth ?? 160,
    );

    const boosted = options.initiative
      ? resolved
          .map((hit) =>
            hit.initiative === options.initiative
              ? { ...hit, score: hit.score + AFFINITY_BOOST }
              : hit,
          )
          .sort((a, b) => b.score - a.score)
      : resolved;

    return {
      hits: boosted.slice(0, limit),
      degraded: response.degraded,
      timingsMs: response.timingsMs,
    };
  } finally {
    if (owned) graph.db.close();
  }
}
