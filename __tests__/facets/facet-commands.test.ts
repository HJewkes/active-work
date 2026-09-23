import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import facetAdd from '../../src/commands/facet-add.js';
import facetList from '../../src/commands/facet-list.js';
import { ValidationError } from '../../src/errors.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import { SAMPLE_SLUG, addInitiative, writeFacet } from './fixtures.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

describe('facet add', () => {
  it('writes a facet file that resolves back through facet list', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const ctx = makeCtx(activeRoot);

      const added = await facetAdd.run(
        { slug: SAMPLE_SLUG, alias: 'widgets', tags: ['ui', 'forms'], about: 'the widget area' },
        ctx,
      );
      const listed = await facetList.run({}, ctx);

      expect(await fs.readFile(added.path, 'utf8')).toContain('Describe this facet');
      expect(listed.facets).toEqual([
        expect.objectContaining({
          alias: 'widgets',
          owner: SAMPLE_SLUG,
          tags: ['ui', 'forms'],
          about: 'the widget area',
          shadowed: false,
        }),
      ]);
    });
  });

  it('refuses an alias equal to an initiative slug', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await addInitiative(activeRoot, 'widgets');

      const attempt = facetAdd.run(
        { slug: SAMPLE_SLUG, alias: 'widgets', tags: ['ui'] },
        makeCtx(activeRoot),
      );

      await expect(attempt).rejects.toThrow(ValidationError);
      await expect(attempt).rejects.toThrow(/would be shadowed/);
    });
  });

  it('refuses to overwrite an existing facet', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeFacet(activeRoot, SAMPLE_SLUG, 'widgets', ['tags: [ui]'], 'Hand-written body.');

      const attempt = facetAdd.run(
        { slug: SAMPLE_SLUG, alias: 'widgets', tags: ['other'] },
        makeCtx(activeRoot),
      );

      await expect(attempt).rejects.toThrow(/already exists/);
    });
  });
});

describe('facet list', () => {
  it('marks an alias shadowed by an initiative directory', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeFacet(activeRoot, SAMPLE_SLUG, 'widgets', ['tags: [ui]']);
      await addInitiative(activeRoot, 'widgets');

      const listed = await facetList.run({}, makeCtx(activeRoot));

      expect(listed.facets.map((f) => [f.alias, f.shadowed])).toEqual([['widgets', true]]);
    });
  });

  it('reports an unreadable facet instead of dropping it', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeFacet(activeRoot, SAMPLE_SLUG, 'broken', ['tags: []']);

      const listed = await facetList.run({ slug: SAMPLE_SLUG }, makeCtx(activeRoot));

      expect(listed.facets).toEqual([]);
      expect(listed.errors[0]?.path).toMatch(/facets\/broken\.md$/);
    });
  });
});
