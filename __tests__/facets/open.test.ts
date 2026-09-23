import { describe, expect, it } from 'vitest';
import openCommand, { sessionAbout } from '../../src/commands/open.js';
import type { LoadedFacet } from '../../src/facets/facet-file.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import { SAMPLE_SLUG, writeFacet } from './fixtures.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

interface OpenEnvelope {
  slug: string;
  facet?: { name: string; tags: string[]; about?: string };
}

async function openAlias(activeRoot: string, about?: string): Promise<OpenEnvelope> {
  await writeFacet(
    activeRoot,
    SAMPLE_SLUG,
    'widgets',
    ['tags: [example]', 'about: the widget area'],
    'Widgets body.',
  );
  const args = { slug: 'widgets', offline: true, ...(about ? { about } : {}) };
  const out = await openCommand.run(openCommand.args.parse(args), makeCtx(activeRoot));
  return openCommand.result.parse(out) as OpenEnvelope;
}

describe('open through a facet alias', () => {
  it('opens the owning initiative and carries the facet on the envelope', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const result = await openAlias(activeRoot);

      expect(result.slug).toBe(SAMPLE_SLUG);
      expect(result.facet).toEqual({
        name: 'widgets',
        tags: ['example'],
        about: 'the widget area',
      });
    });
  });
});

describe('sessionAbout', () => {
  const facet: LoadedFacet = {
    name: 'widgets',
    owner: SAMPLE_SLUG,
    tags: ['ui'],
    about: 'the widget area',
    body: '',
    path: '/unused',
  };

  it('lets an explicit --about win over the facet about', () => {
    expect(sessionAbout('the login bug', facet)).toBe('the login bug');
  });

  it('falls back to the facet about', () => {
    expect(sessionAbout(undefined, facet)).toBe('the widget area');
  });
});
