import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { assembleBootstrap, type BootstrapInput } from '../../src/bootstrap/prompt.js';
import type { LoopRetriever } from '../../src/bootstrap/loop-context.js';
import type { HitLogEntry, HitLogWriter } from '../../src/search/hit-log.js';
import type { RelatedHit } from '../../src/search/related.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

/**
 * The bootstrap's per-loop `see:` lines and the hit log, end to end through
 * `assembleBootstrap` with the retriever and the log injected.
 */

const SLUG = 'sample-initiative';
const NOW = new Date('2026-05-12T16:00:00Z');

async function writeLoopSession(root: string): Promise<void> {
  const front = [
    '---',
    'session_id: loop-session',
    'started: 2026-05-11T09:00:00Z',
    'ended: 2026-05-11T16:00:00Z',
    'track: canonical',
    'next_steps:',
    '  - id: s1',
    '    text: "Mint note refs"',
    '    kind: task',
    "    ref: 'SI-1'",
    '  - id: s2',
    '    text: "Decide the eval harness"',
    '    kind: prose',
    '---',
    '',
    '- Loop session\n',
  ].join('\n');
  await fs.writeFile(
    path.join(root, SLUG, 'sessions', '2026-05-11-0900-loop-session.md'),
    front,
    'utf8',
  );
}

function hit(ref: string, initiative: string, title: string): RelatedHit {
  return { ref, class: 'notes', initiative, title, path: null, excerpt: null };
}

const fixed =
  (hits: RelatedHit[]): LoopRetriever =>
  async (input) => ({
    hits: hits.filter((h) => !(input.exclude ?? []).includes(h.ref)).slice(0, input.limit),
    degraded: [],
    query: { terms: [], expression: '' },
  });

function recorder(): { writer: HitLogWriter; entries: HitLogEntry[] } {
  const entries: HitLogEntry[] = [];
  return {
    entries,
    writer: async (batch) => {
      entries.push(...batch);
      return null;
    },
  };
}

/** The one line that carries wall-clock time; everything else must match byte for byte. */
const withoutClock = (prompt: string) => prompt.replace(/^- Bootstrap: .*$/m, '- Bootstrap: <now>');

const bootstrap = (root: string, extra: Partial<BootstrapInput>) =>
  assembleBootstrap({
    activeRoot: root,
    slug: SLUG,
    now: NOW,
    includeLiveStatus: false,
    detectSiblings: false,
    ...extra,
  });

describe('bootstrap loop retrieval', () => {
  it('renders see: lines under their loop, labelling a foreign hit', async () => {
    await withTempActiveRoot(async (root) => {
      await writeLoopSession(root);
      const retriever = fixed([
        hit('note:sample-initiative/2026-05-01-refs.md', SLUG, 'Refs are minted at write'),
        hit('note:relay/2026-04-01-ids.md', 'relay', 'Ids need a prefix'),
      ]);

      const { prompt } = await bootstrap(root, {
        loopRetriever: retriever,
        hitLog: recorder().writer,
      });

      expect(prompt).toContain(
        '(from 2026-05-11, ref 2026-05-11-0900-loop-session#s1)\n' +
          '    see: note:sample-initiative/2026-05-01-refs.md "Refs are minted at write"\n' +
          '    see: [from `relay`] note:relay/2026-04-01-ids.md "Ids need a prefix"\n' +
          '- [1d] Decide the eval harness',
      );
    });
  });

  it('logs every rendered hit, loop and foreign note alike, with its query and rank', async () => {
    await withTempActiveRoot(async (root) => {
      await writeLoopSession(root);
      await fs.mkdir(path.join(root, SLUG, 'sources', 'notes'), { recursive: true });
      await fs.writeFile(
        path.join(root, SLUG, 'sources', 'notes', '2026-05-01-local.md'),
        "---\nkind: fyi\ntitle: Local\ncreated: '2026-05-01'\n---\n\nbody\n",
      );
      const log = recorder();

      await bootstrap(root, {
        loopRetriever: fixed([hit('note:sample-initiative/a.md', SLUG, 'A')]),
        noteRelevance: () => [{ ref: 'note:relay/b.md', scorePerTerm: 9, title: 'B' }],
        hitLog: log.writer,
      });

      expect(log.entries.map(({ ts: _ts, ...rest }) => rest)).toEqual([
        {
          slug: SLUG,
          trigger: 'bootstrap-loop',
          query: 'SI-1 Mint note refs',
          ref: 'note:sample-initiative/a.md',
          rank: 1,
        },
        {
          slug: SLUG,
          trigger: 'bootstrap-foreign',
          query: expect.stringContaining('SI-'),
          ref: 'note:relay/b.md',
          rank: 1,
        },
      ]);
    });
  });

  it('never shows a note the notes section already shows', async () => {
    await withTempActiveRoot(async (root) => {
      await writeLoopSession(root);
      await fs.mkdir(path.join(root, SLUG, 'sources', 'notes'), { recursive: true });
      await fs.writeFile(
        path.join(root, SLUG, 'sources', 'notes', '2026-05-01-local.md'),
        "---\nkind: fyi\ntitle: Local\ncreated: '2026-05-01'\n---\n\nbody\n",
      );

      const { prompt } = await bootstrap(root, {
        loopRetriever: fixed([hit('note:sample-initiative/2026-05-01-local.md', SLUG, 'Local')]),
        hitLog: recorder().writer,
      });

      expect(prompt).not.toContain('see:');
    });
  });

  it('renders exactly the loops of old when the index is absent', async () => {
    await withTempActiveRoot(async (root) => {
      await writeLoopSession(root);
      const noRetrieval = await bootstrap(root, {
        loopRetriever: async () => {
          throw new Error('retrieval disabled');
        },
        hitLog: recorder().writer,
      });

      const absent = await bootstrap(root, { hitLog: recorder().writer });

      expect(existsSync(path.join(root, '.miner', 'graph.sqlite3'))).toBe(false);
      expect(withoutClock(absent.prompt)).toBe(withoutClock(noRetrieval.prompt));
      expect(absent.prompt).not.toContain('see:');
      expect(absent.metadata.retrieval_degraded).toEqual([
        expect.stringMatching(/^index: missing/),
      ]);
    });
  });

  it('still renders the hits when the log cannot be written, and reports it', async () => {
    await withTempActiveRoot(async (root) => {
      await writeLoopSession(root);

      const { prompt, metadata } = await bootstrap(root, {
        loopRetriever: fixed([hit('note:sample-initiative/a.md', SLUG, 'A')]),
        hitLog: async () => 'EACCES: permission denied',
      });

      expect(prompt).toContain('    see: note:sample-initiative/a.md "A"');
      expect(metadata.retrieval_degraded).toEqual(['hit-log: error (EACCES: permission denied)']);
    });
  });
});
