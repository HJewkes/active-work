import { describe, expect, it } from 'vitest';

import {
  relatedForLoops,
  renderSeeLine,
  type LoopRetriever,
} from '../../src/bootstrap/loop-context.js';
import type { RelatedHit, RelatedInput } from '../../src/search/related.js';
import type { OpenLoop } from '../../src/sessions/open-loops.js';

/**
 * Per-loop retrieval without an index.
 *
 * The retriever is the seam, so the budget, dedupe and exclusion rules are
 * asserted on their own. It honours `exclude` and `limit` the way the real one
 * does, so a test fails when the caller forgets to pass them.
 */

function loop(ref: string, fields: Partial<OpenLoop> = {}): OpenLoop {
  return {
    ref,
    text: `loop ${ref}`,
    kind: 'prose',
    sessionFile: ref.split('#')[0]!,
    sessionId: `sid-${ref}`,
    openedAt: '2026-09-10T00:00:00Z',
    ageDays: 1,
    ...fields,
  };
}

function hit(ref: string, initiative = 'alpha', title = `Title ${ref}`): RelatedHit {
  return { ref, class: 'notes', initiative, title, path: null, excerpt: null };
}

const retrieverOf = (pool: RelatedHit[], calls: RelatedInput[] = []): LoopRetriever => {
  return async (input) => {
    calls.push(input);
    const exclude = new Set(input.exclude ?? []);
    const hits = pool.filter((h) => !exclude.has(h.ref)).slice(0, input.limit);
    return { hits, degraded: [], query: { terms: [], expression: '' } };
  };
};

const pool = (n: number) => Array.from({ length: n }, (_, i) => hit(`note:alpha/n${i}.md`));

const run = (loops: OpenLoop[], retriever: LoopRetriever, shown: string[] = []) =>
  relatedForLoops({ loops, labels: loops.map((l) => l.text), slug: 'alpha', shown, retriever });

describe('relatedForLoops', () => {
  it('gives every loop its best hit before any loop gets a second', async () => {
    const loops = [loop('s#a'), loop('s#b')];

    const context = await run(loops, retrieverOf(pool(10)));

    // Both loops rank the same pool, so a hit taken once is never repeated.
    expect(context.hits.get('s#a')!.map((h) => h.ref)).toEqual([
      'note:alpha/n0.md',
      'note:alpha/n2.md',
    ]);
    expect(context.hits.get('s#b')!.map((h) => h.ref)).toEqual([
      'note:alpha/n1.md',
      'note:alpha/n3.md',
    ]);
  });

  it('spreads six hits over six of seven loops rather than two each over three', async () => {
    const loops = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => loop(`s#${id}`));
    const perLoop: LoopRetriever = async (input) => ({
      hits: [hit(`note:alpha/${input.text}-1.md`), hit(`note:alpha/${input.text}-2.md`)],
      degraded: [],
      query: { terms: [], expression: '' },
    });

    const context = await run(loops, perLoop);

    expect([...context.hits.keys()]).toEqual(['s#a', 's#b', 's#c', 's#d', 's#e', 's#f']);
    expect([...context.hits.values()].every((hits) => hits.length === 1)).toBe(true);
    expect(context.hits.get('s#a')![0]!.ref).toBe('note:alpha/loop s#a-1.md');
  });

  it('stops at 1,200 rendered characters across every loop', async () => {
    const long = Array.from({ length: 20 }, (_, i) =>
      hit(`note:alpha/long-${i}.md`, 'alpha', 'x'.repeat(250)),
    );
    const loops = ['a', 'b', 'c'].map((id) => loop(`s#${id}`));

    const context = await run(loops, retrieverOf(long));

    const lines = [...context.hits.values()].flat().map((h) => renderSeeLine(h, 'alpha') + '\n');
    expect(lines.join('').length).toBeLessThanOrEqual(1200);
    expect(lines.length).toBe(4);
  });

  it("excludes the loop's own session, its target task and whatever the prompt already shows", async () => {
    const calls: RelatedInput[] = [];
    const target = loop('s#a', { kind: 'task', targetRef: 'tp-27', sessionId: 'sess-1' });

    await run([target], retrieverOf(pool(2), calls), ['note:alpha/shown.md']);

    expect(calls[0]!.exclude).toEqual(
      expect.arrayContaining(['note:alpha/shown.md', 'session:sess-1', 'task:TP-27']),
    );
    expect(calls[0]).toMatchObject({
      text: 'loop s#a',
      initiative: 'alpha',
      classes: ['notes', 'sources', 'tasks', 'sessions'],
    });
  });

  it('does not exclude a PR number as if it were a task', async () => {
    const calls: RelatedInput[] = [];

    await run([loop('s#a', { kind: 'pr', targetRef: '57' })], retrieverOf([], calls));

    expect(calls[0]!.exclude).not.toContain('task:57');
  });

  it('carries on past a loop whose retriever throws, and says so once', async () => {
    let call = 0;
    const flaky: LoopRetriever = async (input) => {
      call += 1;
      if (call === 1) throw new Error('graph locked');
      return retrieverOf(pool(2))(input);
    };

    const context = await run([loop('s#a'), loop('s#b'), loop('s#c')], flaky);

    expect(context.hits.has('s#a')).toBe(false);
    expect(context.hits.get('s#b')!.map((h) => h.ref)).toEqual(['note:alpha/n0.md']);
    expect(context.hits.get('s#c')!.map((h) => h.ref)).toEqual(['note:alpha/n1.md']);
    expect(context.degraded).toEqual([
      { source: 'loop-retriever', reason: 'error', message: 'graph locked' },
    ]);
  });
});

describe('renderSeeLine', () => {
  it('labels a foreign hit with its initiative, like the foreign notes section', () => {
    expect(renderSeeLine(hit('note:relay/x.md', 'relay', 'Relay lesson'), 'alpha')).toBe(
      '    see: [from `relay`] note:relay/x.md "Relay lesson"',
    );
    expect(renderSeeLine(hit('note:alpha/y.md', 'alpha', 'Local lesson'), 'alpha')).toBe(
      '    see: note:alpha/y.md "Local lesson"',
    );
  });
});
