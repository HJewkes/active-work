import { existsSync } from 'node:fs';
import { defaultGraphPath, openGraph, type WorkspaceGraph } from '../session-index/graph.js';
import { deriveQuery, type DerivedQuery } from './derive-query.js';
import { graphDocumentFrequency } from './document-frequency.js';
import { searchWorkspace } from './index.js';
import type { ResolvedHit } from './resolve.js';

/**
 * One query in, one bounded block of openable hits out, empty when anything
 * goes wrong.
 *
 * Retrieval that waits for an agent to ask does not happen, so the callers are
 * triggers that already carry a query: an open loop at bootstrap, a brief at
 * spawn. Both render the result into a prompt that must still assemble when
 * the index is missing, which is why nothing here throws.
 */

/**
 * A rank cap, and deliberately no score dropoff.
 *
 * The design called for `applyDropoff` to cut a weak tail, and it was measured
 * on ten live open loops across four initiatives on 2026-09-16 before being
 * left out. On fused scores it is a class cutoff, not a relevance one: class
 * weights and the affinity boost put a 15-40% step at every class and
 * local/foreign boundary, so a 0.15 threshold cut 4 of 10 lists exactly there
 * (CC-90 kept 2 of 6, dropping its own task) while 0.3 and 0.5 never fired.
 * Applied to each class's BM25 list before fusion it cut on 10 of 10 at 0.15,
 * 6 at 0.3 and 1 at 0.5, each time dropping a relevant local note and
 * backfilling a weaker session record. TP-84 scored this configuration: a cap
 * of six, no dropoff.
 */
export const RELATED_DEFAULT_LIMIT = 6;
export const RELATED_DEFAULT_BUDGET = 1500;

/** Workspace classes only. Transcripts are the raw form of what the notes distil. */
export const RELATED_DEFAULT_CLASSES = ['notes', 'sources', 'tasks', 'sessions'];

export type RelatedHit = Pick<
  ResolvedHit,
  'ref' | 'class' | 'initiative' | 'title' | 'path' | 'excerpt' | 'byteOffset' | 'byteLength'
>;

export interface RelatedDegradation {
  source: string;
  reason: string;
  message: string;
}

export interface RelatedResult {
  hits: RelatedHit[];
  degraded: RelatedDegradation[];
  query: DerivedQuery;
}

export interface RelatedInput {
  text: string;
  initiative?: string;
  limit?: number;
  /** Most rendered characters, summed over hits. */
  budget?: number;
  classes?: string[];
  /** Refs the caller already shows. */
  exclude?: string[];
  /** How the caller renders a hit, so the budget counts what is actually printed. */
  render?: (hit: RelatedHit) => string;
  dbPath?: string;
  activeRoot?: string;
}

const EMPTY_QUERY: DerivedQuery = { terms: [], expression: '' };

function degradedResult(query: DerivedQuery, degradation: RelatedDegradation): RelatedResult {
  return { hits: [], degraded: [degradation], query };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultRender(hit: RelatedHit): string {
  return [hit.ref, hit.title, hit.path, hit.excerpt].filter(Boolean).join(' ');
}

/** Stop at the first hit that would overflow, so the cut never reorders what ranked. */
export function withinBudget<T>(hits: T[], budget: number, render: (hit: T) => string): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const hit of hits) {
    used += render(hit).length;
    if (used > budget) break;
    kept.push(hit);
  }
  return kept;
}

function toRelatedHit(hit: ResolvedHit): RelatedHit {
  const { ref, class: cls, initiative, title, path, excerpt, byteOffset, byteLength } = hit;
  return { ref, class: cls, initiative, title, path, excerpt, byteOffset, byteLength };
}

function openIndex(dbPath: string): WorkspaceGraph | RelatedDegradation {
  // Opening creates the file, and nothing on this path may write to the graph.
  if (!existsSync(dbPath)) {
    return { source: 'index', reason: 'missing', message: `no index at ${dbPath}` };
  }
  try {
    return openGraph(dbPath);
  } catch (err) {
    return { source: 'index', reason: 'error', message: describe(err) };
  }
}

async function searchOpenIndex(
  graph: WorkspaceGraph,
  input: RelatedInput,
  query: DerivedQuery,
): Promise<RelatedResult> {
  const limit = input.limit ?? RELATED_DEFAULT_LIMIT;
  const exclude = new Set(input.exclude ?? []);
  const result = await searchWorkspace(query.expression, {
    graph,
    rawExpression: true,
    limit: limit + exclude.size,
    classes: input.classes ?? RELATED_DEFAULT_CLASSES,
    ...(input.initiative !== undefined ? { initiative: input.initiative } : {}),
    ...(input.activeRoot !== undefined ? { activeRoot: input.activeRoot } : {}),
  });
  const kept = result.hits.filter((hit) => !exclude.has(hit.ref)).slice(0, limit);
  return {
    hits: withinBudget(
      kept.map(toRelatedHit),
      input.budget ?? RELATED_DEFAULT_BUDGET,
      input.render ?? defaultRender,
    ),
    degraded: result.degraded.map(({ retriever, reason, message }) => ({
      source: retriever,
      reason,
      message,
    })),
    query,
  };
}

async function relatedFromIndex(
  graph: WorkspaceGraph,
  input: RelatedInput,
): Promise<RelatedResult> {
  const query = deriveQuery(input.text, graphDocumentFrequency(graph));
  if (query.terms.length === 0) {
    return degradedResult(query, { source: 'query', reason: 'empty', message: 'no query terms' });
  }
  try {
    return await searchOpenIndex(graph, input, query);
  } catch (err) {
    return degradedResult(query, { source: 'search', reason: 'error', message: describe(err) });
  }
}

export async function relatedContext(input: RelatedInput): Promise<RelatedResult> {
  if (input.text.trim().length === 0) {
    return degradedResult(EMPTY_QUERY, { source: 'query', reason: 'empty', message: 'no text' });
  }
  const opened = openIndex(input.dbPath ?? defaultGraphPath());
  if (!('db' in opened)) return degradedResult(EMPTY_QUERY, opened);
  try {
    return await relatedFromIndex(opened, input);
  } catch (err) {
    return degradedResult(EMPTY_QUERY, {
      source: 'query',
      reason: 'error',
      message: describe(err),
    });
  } finally {
    opened.db.close();
  }
}
