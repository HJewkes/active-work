import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleBootstrap } from '../../src/bootstrap/prompt.js';
import type { BootstrapFacet } from '../../src/bootstrap/facet.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import { SAMPLE_SLUG, writeOpenTask } from './fixtures.js';

const FIXTURE_NOW = new Date('2026-05-12T16:00:00Z');

const FACET: BootstrapFacet = {
  name: 'widgets',
  tags: ['ui', 'forms'],
  about: 'the widget area',
  body: 'Widgets live under src/widgets.',
};

function bootstrap(activeRoot: string, facet?: BootstrapFacet) {
  return assembleBootstrap({
    activeRoot,
    slug: SAMPLE_SLUG,
    now: FIXTURE_NOW,
    includeLiveStatus: false,
    detectSiblings: false,
    hitLog: async () => null,
    ...(facet ? { facet } : {}),
  });
}

/** One session whose ledger opens a loop per target (task id, or undefined for prose). */
async function writeLoops(activeRoot: string, targets: Array<string | undefined>): Promise<void> {
  const steps = targets.flatMap((ref, i) => [
    `  - id: n${i}`,
    `    text: "loop ${ref ?? 'prose'}"`,
    `    kind: ${ref ? 'task' : 'prose'}`,
    ...(ref ? [`    ref: '${ref}'`] : []),
  ]);
  const session = [
    '---',
    'session_id: loops01',
    'started: 2026-05-11T10:00:00Z',
    'ended: 2026-05-11T11:00:00Z',
    'track: canonical',
    'next_steps:',
    ...steps,
    '---',
    'Session body.',
  ].join('\n');
  const file = path.join(activeRoot, SAMPLE_SLUG, 'sessions', '2026-05-11-1000-loops01.md');
  await fs.writeFile(file, session);
}

describe('assembleBootstrap with a facet', () => {
  it('names the facet in the header and renders its body after the brief excerpt', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt, metadata } = await bootstrap(activeRoot, FACET);

      expect(prompt).toContain(
        'Starting a session on `sample-initiative` (Sample Initiative), scoped to facet `widgets`.',
      );
      const brief = prompt.indexOf("# Why we're doing this");
      const facet = prompt.indexOf('# Facet: widgets\nWidgets live under src/widgets.');
      expect(brief).toBeGreaterThanOrEqual(0);
      expect(facet).toBeGreaterThan(brief);
      expect(facet).toBeLessThan(prompt.indexOf('# Open loops'));
      expect(metadata.facet).toBe('widgets');
    });
  });

  it('shows only tasks carrying any facet tag and counts the rest', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeOpenTask(activeRoot, 'SI-3', 2, ['forms', 'backend']);
      await writeOpenTask(activeRoot, 'SI-4', 3, ['backend']);

      const { prompt } = await bootstrap(activeRoot, FACET);

      expect(prompt).toContain('[SI-3]');
      expect(prompt).not.toContain('[SI-4]');
      expect(prompt).not.toContain('[SI-1]');
      expect(prompt).toContain(
        '(2 other open tasks outside this facet — `active-work task list sample-initiative --json`)',
      );
    });
  });

  it('falls back to every open task when none carries a facet tag', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { prompt } = await bootstrap(activeRoot, FACET);

      expect(prompt).toContain('[SI-1]');
      expect(prompt).toContain('_No open tasks carry the facet tags [ui, forms]; showing all._');
    });
  });

  it('hides loops aimed at out-of-facet tasks and keeps untargeted and foreign ones', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeOpenTask(activeRoot, 'SI-3', 2, ['ui']);
      await writeLoops(activeRoot, ['SI-3', 'SI-1', 'OTHER-9', undefined]);

      const { prompt } = await bootstrap(activeRoot, FACET);

      expect(prompt).toContain('loop SI-3');
      expect(prompt).not.toContain('loop SI-1');
      expect(prompt).toContain('loop OTHER-9');
      expect(prompt).toContain('loop prose');
      expect(prompt).toContain(
        '(1 other open loop outside this facet — `active-work loops sample-initiative`)',
      );
    });
  });

  it('renders no facet section or filter without a facet', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeOpenTask(activeRoot, 'SI-4', 3, ['backend']);

      const { prompt, metadata } = await bootstrap(activeRoot);

      expect(prompt).not.toContain('# Facet:');
      expect(prompt).toContain('[SI-4]');
      expect(metadata.facet).toBeUndefined();
    });
  });
});
