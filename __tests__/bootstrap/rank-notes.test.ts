import { describe, expect, it } from 'vitest';

import {
  rankNotes,
  subjectOf,
  subjectTerms,
  type NoteHit,
  type NoteRelevance,
} from '../../src/bootstrap/rank-notes.js';
import type { LoadedNote } from '../../src/notes/note-file.js';

/**
 * The ranker, without a database.
 *
 * `relevance` is the whole seam: everything below drives it directly, so the
 * ordering rules are asserted on their own rather than through an index that
 * would make the tests about FTS.
 */

function note(filename: string, title: string): LoadedNote {
  return {
    filename,
    path: `/active/alpha/sources/notes/${filename}`,
    frontmatter: { kind: 'gotcha', title, created: '2026-09-01' },
    body: title,
  } as unknown as LoadedNote;
}

const NOTES = [note('a.md', 'Newest'), note('b.md', 'Middle'), note('c.md', 'Oldest')];

const relevance =
  (hits: NoteHit[]): NoteRelevance =>
  () =>
    hits;

const titles = (ranking: { local: LoadedNote[] }) => ranking.local.map((n) => n.frontmatter.title);

describe('subjectOf', () => {
  it('uses the top task and the brief, so nobody has to say what the session is about', () => {
    expect(subjectOf({ topTaskTitle: 'Split the ui package', briefTitle: 'Titan platform' })).toBe(
      'Split the ui package Titan platform',
    );
  });

  it('lets an explicit subject override both', () => {
    expect(subjectOf({ about: 'npm publishing', topTaskTitle: 'Split it', briefTitle: 'X' })).toBe(
      'npm publishing',
    );
    // Blank is not an override; it is an absent one.
    expect(subjectOf({ about: '   ', briefTitle: 'X' })).toBe('X');
  });
});

describe('subjectTerms', () => {
  it('drops the words that match everything and therefore rank nothing', () => {
    // The subject is a title, not a query, and FTS ORs every token — so `or`
    // and `the` pull in the whole corpus and BM25 ranks on document length.
    expect(subjectTerms('Prune or cap the .cache/ growth')).toEqual([
      'prune',
      'cap',
      'cache',
      'growth',
    ]);
  });

  it('deduplicates, so a repeated word does not weight the query twice', () => {
    expect(subjectTerms('index the index indexer')).toEqual(['index', 'indexer']);
  });
});

describe('rankNotes', () => {
  it('falls back to date order when the relevance source throws', () => {
    const ranking = rankNotes({
      notes: NOTES,
      slug: 'alpha',
      subject: 'anything at all',
      relevance: () => {
        throw new Error('no index');
      },
    });

    expect(ranking.ranked).toBe(false);
    expect(titles(ranking)).toEqual(['Newest', 'Middle', 'Oldest']);
    expect(ranking.foreign).toEqual([]);
  });

  it('falls back to date order when the subject is all stop words', () => {
    const ranking = rankNotes({ notes: NOTES, slug: 'alpha', subject: 'the and of it' });
    expect(ranking.ranked).toBe(false);
    expect(titles(ranking)).toEqual(['Newest', 'Middle', 'Oldest']);
  });

  it('fuses relevance with recency rather than replacing one with the other', () => {
    const ranking = rankNotes({
      notes: NOTES,
      slug: 'alpha',
      subject: 'matching subject',
      relevance: relevance([
        { ref: 'note:alpha/c.md', scorePerTerm: 9 },
        { ref: 'note:alpha/b.md', scorePerTerm: 8 },
      ]),
    });

    expect(ranking.ranked).toBe(true);
    // Oldest is last by date and first by relevance; Middle is second in both.
    // Oldest wins, because 1/63 + 1/61 > 2/62 — being top of one list beats
    // being middling in two, which is the behaviour that makes an old note
    // findable at all.
    //
    // Newest is first by date and matched nothing, so it lands last on the
    // strength of one list. Recency is a vote here, not the ordering.
    expect(titles(ranking)).toEqual(['Oldest', 'Middle', 'Newest']);
  });

  it('keeps a note the query never matched, on its recency rank alone', () => {
    const ranking = rankNotes({
      notes: NOTES,
      slug: 'alpha',
      subject: 'matching subject',
      relevance: relevance([{ ref: 'note:alpha/c.md', scorePerTerm: 9 }]),
    });

    // A partial index must not drop notes, only reorder them.
    expect(titles(ranking).sort()).toEqual(['Middle', 'Newest', 'Oldest']);
  });

  it('shows a foreign note only when it matches well in absolute terms', () => {
    const weak = rankNotes({
      notes: NOTES,
      slug: 'alpha',
      subject: 'matching subject',
      relevance: relevance([{ ref: 'note:beta/x.md', scorePerTerm: 2.0, title: 'Weak' }]),
    });
    expect(weak.foreign).toEqual([]);

    const strong = rankNotes({
      notes: NOTES,
      slug: 'alpha',
      subject: 'matching subject',
      relevance: relevance([{ ref: 'note:beta/x.md', scorePerTerm: 5.0, title: 'Strong' }]),
    });
    expect(strong.foreign).toEqual([
      { initiative: 'beta', title: 'Strong', ref: 'note:beta/x.md' },
    ]);
  });

  it('is a floor on the match, not on the rest of the field', () => {
    // The foreign note is the single best hit here. It still has to clear the
    // floor — a relative floor would admit it for being top of a weak field,
    // which is the failure mode that made 22 of 28 initiatives show one.
    const ranking = rankNotes({
      notes: NOTES,
      slug: 'alpha',
      subject: 'matching subject',
      relevance: relevance([
        { ref: 'note:beta/x.md', scorePerTerm: 1.2, title: 'Best of a bad lot' },
      ]),
    });
    expect(ranking.foreign).toEqual([]);
  });

  it('caps foreign notes at three however many clear the floor', () => {
    const ranking = rankNotes({
      notes: NOTES,
      slug: 'alpha',
      subject: 'matching subject',
      relevance: relevance(
        Array.from({ length: 8 }, (_, i) => ({
          ref: `note:beta/${i}.md`,
          scorePerTerm: 9 - i * 0.1,
          title: `Foreign ${i}`,
        })),
      ),
    });

    expect(ranking.foreign).toHaveLength(3);
    expect(ranking.foreign.map((n) => n.title)).toEqual(['Foreign 0', 'Foreign 1', 'Foreign 2']);
  });

  it('falls back to the ref when the row behind a span is gone', () => {
    const ranking = rankNotes({
      notes: NOTES,
      slug: 'alpha',
      subject: 'matching subject',
      relevance: relevance([{ ref: 'note:beta/x.md', scorePerTerm: 9 }]),
    });
    expect(ranking.foreign[0]!.title).toBe('note:beta/x.md');
  });
});
