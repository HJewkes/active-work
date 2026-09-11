import { fuseByRRF } from '@titan-design/retrieval';
import type { LoadedNote } from '../notes/note-file.js';
import { defaultGraphPath, openGraph } from '../session-index/graph.js';

/**
 * Which notes the bootstrap shows, and in what order.
 *
 * Date order answers "what did I write last", which is the right question only
 * on the day after writing it. What a session needs is "what do I already know
 * that bears on what I am about to do", so notes are ranked against the
 * session's subject and fused with recency rather than ordered by it.
 *
 * Every path falls open. The index is derived and disposable, so a bootstrap
 * that could fail without it would make it load-bearing: anything going wrong
 * yields exactly today's date-ordered behaviour and `ranked: false`.
 */

export interface NoteRanking {
  /** This initiative's notes, best first. Date order when ranking was unavailable. */
  local: LoadedNote[];
  /** Notes from other initiatives that cleared the floor, best first. At most `FOREIGN_CAP`. */
  foreign: ForeignNote[];
  /** False when the index was absent or the query failed, and `local` is plain date order. */
  ranked: boolean;
}

export interface ForeignNote {
  initiative: string;
  title: string;
  ref: string;
}

/**
 * At most three, as a hard cap rather than a proportional slice.
 *
 * Three is a budget an operator can learn to trust, so the bootstrap's shape
 * stays the same session over session. A proportional cut would let a
 * well-indexed foreign initiative crowd out the local record exactly when the
 * local record is thin, which is when it is needed most.
 */
const FOREIGN_CAP = 3;

/**
 * How well a foreign note must match, as BM25 per query term.
 *
 * Absolute, and normalised by query length. Both parts were measured rather
 * than chosen. A *relative* floor — "within 90% of the best hit" — does not
 * work, because within one ranked list an RRF score is a fixed function of
 * rank, so the floor becomes a rank cutoff wearing a percentage: 22 of 28
 * initiatives would have shown a foreign note. Raw BM25 fails differently: its
 * magnitude ran from 10 to 56 across subjects purely with query length, and the
 * initiatives that fired were the ones whose best hit was *weakest*.
 *
 * Per-term BM25 with a floor of 3.5 fires for 5 of 25 initiatives, which is the
 * "most sessions see zero" the design asks for. Spot-checking those five, three
 * are the payoff the whole design exists for — `audiobook`'s XTTS-on-a-5090
 * task surfacing `basement-server`'s note that the 5090 needs torch>=2.7 while
 * Coqui TTS pins 2.5.1 — and two are merely same-genre. That is a good rate for
 * three slots.
 *
 * Known bias: a two-word subject inflates per-term score, since each term
 * carries more of the match. Left alone because the one case in this corpus
 * (`denver-rezzy` reaching a parked restaurant note) was correct.
 */
const FOREIGN_FLOOR_PER_TERM = 3.5;

/** How many note owners to consider. Well past any cap; the floor does the cutting. */
const SEARCH_DEPTH = 300;

/**
 * Words that match everything and therefore rank nothing.
 *
 * The subject is a title rather than a deliberate query, and the FTS default
 * ORs every token — so `or`, `the` and `with` pull in the whole corpus and BM25
 * ends up ranking on document length. Dropping them is what makes a title
 * usable as a query at all.
 */
const STOP_WORDS = new Set(
  (
    'a an and are as at be but by for from in into is it of on or the to with via than then that ' +
    'this these those over under new old add fix use using not no all any each per'
  ).split(' '),
);

/** Distinct, meaningful tokens of the subject. */
export function subjectTerms(subject: string): string[] {
  const tokens = subject.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length > 2 && !STOP_WORDS.has(token)))];
}

/**
 * What this session is about, in the words the corpus would use.
 *
 * The top task's title plus the brief's: the two sentences that already
 * describe the work, neither of which the operator has to write. `about`
 * overrides both, for a session that is not about the top task.
 */
export function subjectOf(input: {
  about?: string;
  briefTitle?: string;
  topTaskTitle?: string;
}): string {
  if (input.about !== undefined && input.about.trim().length > 0) return input.about.trim();
  return [input.topTaskTitle, input.briefTitle].filter(Boolean).join(' ').trim();
}

/** One note the query matched: its ref, BM25 normalised by query length, and its title. */
export interface NoteHit {
  ref: string;
  scorePerTerm: number;
  /** Absent when the row is gone but its span is not; the renderer falls back to the ref. */
  title?: string;
}

export type NoteRelevance = (terms: string[]) => NoteHit[];

/**
 * Best-matching notes for a set of terms, straight off the span index.
 *
 * A notes-only query rather than a trip through `search`, because this asks a
 * narrower question — the bootstrap wants notes, not the best of six classes —
 * and because it needs the BM25 score itself, which fusion discards.
 */
export function graphNoteRelevance(dbPath?: string): NoteRelevance {
  return (terms) => {
    const graph = openGraph(dbPath ?? defaultGraphPath());
    try {
      const expression = terms.map((term) => `"${term}"`).join(' OR ');
      const titleOf = graph.db.prepare('SELECT title FROM note WHERE note_ref = ? LIMIT 1');
      const seen = new Set<string>();
      const hits: NoteHit[] = [];
      for (const span of graph.spans.search(expression, SEARCH_DEPTH, { ownerPrefix: 'note:' })) {
        if (seen.has(span.ownerRef)) continue;
        seen.add(span.ownerRef);
        const row = titleOf.get(span.ownerRef) as { title: string } | undefined;
        // SQLite's bm25() is negative, with better matches more negative.
        hits.push({
          ref: span.ownerRef,
          scorePerTerm: -span.rank / terms.length,
          ...(row ? { title: row.title } : {}),
        });
      }
      return hits;
    } finally {
      graph.db.close();
    }
  };
}

export interface RankNotesInput {
  notes: LoadedNote[];
  slug: string;
  subject: string;
  /** Injectable for tests; defaults to a query against the live graph. */
  relevance?: NoteRelevance;
}

/** `note:<initiative>/<filename>` — how the indexer keys a note. */
function refOf(slug: string, note: LoadedNote): string {
  return `note:${slug}/${note.filename}`;
}

function initiativeOf(ref: string): string {
  return ref.slice('note:'.length).split('/')[0] ?? '';
}

/**
 * Fuse relevance with recency.
 *
 * RRF over two ranked lists of the same notes: the recency order they arrive
 * in, and the relevance order the query returns. Equal weights, so leading
 * requires being both recent and relevant while either alone can still place.
 * A note the query never matched keeps its recency rank alone, which is what
 * makes a partial index harmless rather than wrong.
 */
function fuseWithRecency(notes: LoadedNote[], slug: string, relevantRefs: string[]): LoadedNote[] {
  const byRef = new Map(notes.map((note) => [refOf(slug, note), note]));
  const fused = fuseByRRF([
    { name: 'recency', hits: notes.map((note, i) => ({ id: refOf(slug, note), rank: i + 1 })) },
    {
      name: 'relevance',
      hits: relevantRefs
        .filter((ref) => byRef.has(ref))
        .map((ref, i) => ({ id: ref, rank: i + 1 })),
    },
  ]);
  return fused.map((result) => byRef.get(result.id)).filter((note): note is LoadedNote => !!note);
}

export function rankNotes(input: RankNotesInput): NoteRanking {
  const dateOrder: NoteRanking = { local: input.notes, foreign: [], ranked: false };
  if (input.notes.length === 0) return dateOrder;

  const terms = subjectTerms(input.subject);
  if (terms.length === 0) return dateOrder;

  let hits: NoteHit[];
  try {
    hits = (input.relevance ?? graphNoteRelevance())(terms);
  } catch {
    return dateOrder;
  }
  if (hits.length === 0) return dateOrder;

  const foreign = hits
    .filter((hit) => initiativeOf(hit.ref) !== input.slug)
    .filter((hit) => hit.scorePerTerm >= FOREIGN_FLOOR_PER_TERM)
    .slice(0, FOREIGN_CAP)
    .map((hit) => ({
      initiative: initiativeOf(hit.ref),
      title: hit.title ?? hit.ref,
      ref: hit.ref,
    }));

  const localRefs = hits
    .filter((hit) => initiativeOf(hit.ref) === input.slug)
    .map((hit) => hit.ref);

  return { local: fuseWithRecency(input.notes, input.slug, localRefs), foreign, ranked: true };
}
