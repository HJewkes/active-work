import type { WorkspaceGraph } from '../session-index/graph.js';
import { extractMentions, type RefIndex } from './mentions.js';
import { initiativeRef } from './refs.js';

/**
 * The three derived relations, rebuilt wholesale by this one pass.
 *
 * No other writer asserts them and none asserts an edge as a side effect of
 * doing something else. That is post-mortem finding F3: brain's edges were
 * written by per-module writers that only ever held their own ids, so 191 of
 * 18,696 crossed a module boundary. Cross-domain connection has to come from
 * one pass that sees the whole corpus.
 *
 * Similarity is deliberately absent. Finding F2: brain wrote 10,832 cosine
 * edges and its graph leg became a stale copy of its vector leg, double-counted
 * by the fusion. If vectors arrive they enter as a retriever at query time and
 * write nothing here.
 */

export const RELATIONS = {
  HOLDS: 'holds',
  MENTIONS: 'mentions',
  SHARES_TAG: 'shares_tag',
} as const;

/**
 * `shares_tag` links notes in *different* initiatives that share a tag carried
 * by at most this many notes.
 *
 * Two filters, because they cut different noise (owner, 2026-09-10). Two notes
 * in one initiative are already co-located and `holds` covers them, so a link
 * between them says nothing. And a tag's value as a link falls with the number
 * of notes carrying it: `process` on 45 notes is a filing convention, not a
 * claim about relatedness. Unfiltered, this relation was 3,973 pairs on the
 * live corpus — about 70% of the edge table, the same share brain's cosine
 * edges held. Both filters bring it to 369.
 */
export const SHARES_TAG_MAX_NOTES = 10;

export interface NoteFacts {
  ref: string;
  initiative: string;
  tags: string[];
  body: string;
}

export interface EdgeCounts {
  holds: number;
  mentions: number;
  sharesTag: number;
}

interface Owned {
  ref: string;
  initiative: string;
}

/**
 * Derived edges are deleted and rewritten, not expired.
 *
 * Finding F5's rule is that an asserted edge is expired rather than deleted,
 * and never by a writer that did not create it. These three relations have
 * exactly one writer — this function — and they are a pure function of the
 * files, so their history is the files' history. Expiring instead would grow an
 * audit trail of nothing on a pass the daemon runs every sixty seconds.
 */
export function rebuildEdges(graph: WorkspaceGraph, notes: readonly NoteFacts[]): EdgeCounts {
  const relations = Object.values(RELATIONS);
  const placeholders = relations.map(() => '?').join(', ');
  return graph.db.transaction(() => {
    graph.db.prepare(`DELETE FROM edge WHERE relation IN (${placeholders})`).run(...relations);
    return {
      holds: assertHolds(graph),
      mentions: assertMentions(graph, notes),
      sharesTag: assertSharesTag(graph, notes),
    };
  })();
}

const OWNED_REFS = `
  SELECT note_ref    AS ref, initiative FROM note
  UNION ALL SELECT task_ref    AS ref, initiative FROM workspace_task
  UNION ALL SELECT session_ref AS ref, initiative FROM session_record
  UNION ALL SELECT source_ref  AS ref, initiative FROM source
`;

/** `initiative:<slug> holds <ref>` — free, from the path, and it makes "which initiatives touch this" answerable. */
function assertHolds(graph: WorkspaceGraph): number {
  const rows = graph.db.prepare(OWNED_REFS).all() as Owned[];
  let written = 0;
  for (const row of rows) {
    const inserted = graph.edges.assert({
      sourceRef: initiativeRef(row.initiative),
      relation: RELATIONS.HOLDS,
      targetRef: row.ref,
    });
    if (inserted) written++;
  }
  return written;
}

/**
 * Note bodies are re-read every pass even when their watermark says unchanged,
 * because a mention resolves against the *whole* corpus: filing a new task
 * makes an existing note's previously-unresolvable `TP-40` resolve. Computing
 * this incrementally would let a full rebuild and an incremental sequence
 * disagree, which is the one property this index has to guarantee.
 */
function assertMentions(graph: WorkspaceGraph, notes: readonly NoteFacts[]): number {
  const index = buildRefIndex(graph);
  let written = 0;
  for (const note of notes) {
    for (const target of extractMentions(note.body, note.initiative, index)) {
      if (target === note.ref) continue;
      const inserted = graph.edges.assert({
        sourceRef: note.ref,
        relation: RELATIONS.MENTIONS,
        targetRef: target,
      });
      if (inserted) written++;
    }
  }
  return written;
}

function buildRefIndex(graph: WorkspaceGraph): RefIndex {
  const column = (sql: string): string[] =>
    (graph.db.prepare(sql).all() as { value: string }[]).map((row) => row.value);
  return {
    taskIds: new Set(column('SELECT DISTINCT task_id AS value FROM workspace_task')),
    sessionIds: new Set(column('SELECT DISTINCT session_id AS value FROM session_record')),
    noteRefs: new Set(column('SELECT note_ref AS value FROM note')),
    // `source:` is 7 characters; what remains is the `<slug>/<path>` the ref was minted from.
    sourcePaths: new Set(column('SELECT substr(source_ref, 8) AS value FROM source')),
  };
}

/** Both directions, because a symmetric relation stored once is a half-answer to whoever expands from the other end. */
function assertSharesTag(graph: WorkspaceGraph, notes: readonly NoteFacts[]): number {
  let written = 0;
  for (const group of qualifyingTagGroups(notes)) {
    for (const [a, b] of crossInitiativePairs(group)) {
      for (const edge of [
        { sourceRef: a.ref, targetRef: b.ref },
        { sourceRef: b.ref, targetRef: a.ref },
      ]) {
        if (graph.edges.assert({ ...edge, relation: RELATIONS.SHARES_TAG })) written++;
      }
    }
  }
  return written;
}

/** Tags used in more than one initiative and carried by at most `SHARES_TAG_MAX_NOTES` notes. */
function qualifyingTagGroups(notes: readonly NoteFacts[]): NoteFacts[][] {
  const byTag = new Map<string, NoteFacts[]>();
  for (const note of notes) {
    for (const tag of new Set(note.tags)) {
      const group = byTag.get(tag);
      if (group) group.push(note);
      else byTag.set(tag, [note]);
    }
  }
  return [...byTag.values()].filter(
    (group) =>
      group.length <= SHARES_TAG_MAX_NOTES &&
      new Set(group.map((note) => note.initiative)).size > 1,
  );
}

function crossInitiativePairs(group: NoteFacts[]): [NoteFacts, NoteFacts][] {
  const sorted = [...group].sort((a, b) => a.ref.localeCompare(b.ref));
  const pairs: [NoteFacts, NoteFacts][] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[i].initiative !== sorted[j].initiative) pairs.push([sorted[i], sorted[j]]);
    }
  }
  return pairs;
}
