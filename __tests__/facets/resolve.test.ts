import { describe, expect, it } from 'vitest';
import { resolveSlugOrFacet } from '../../src/commands/_open-helpers.js';
import { NotFoundError } from '../../src/errors.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import { SAMPLE_SLUG, addInitiative, writeFacet } from './fixtures.js';

describe('resolveSlugOrFacet', () => {
  it('resolves a facet alias to its owning initiative', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeFacet(activeRoot, SAMPLE_SLUG, 'widgets', [
        'tags: [ui]',
        'about: the widget area',
      ]);

      const resolved = await resolveSlugOrFacet(activeRoot, 'widgets');

      expect(resolved.slug).toBe(SAMPLE_SLUG);
      expect(resolved.facet).toMatchObject({
        name: 'widgets',
        tags: ['ui'],
        about: 'the widget area',
      });
    });
  });

  it('lets an initiative directory shadow a facet of the same name', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await addInitiative(activeRoot, 'widgets');
      await writeFacet(activeRoot, SAMPLE_SLUG, 'widgets', ['tags: [ui]']);

      const resolved = await resolveSlugOrFacet(activeRoot, 'widgets');

      expect(resolved).toEqual({ slug: 'widgets' });
    });
  });

  it('prefers an exact facet alias over an initiative slug it prefixes', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await addInitiative(activeRoot, 'widgets-v2');
      await writeFacet(activeRoot, SAMPLE_SLUG, 'widgets', ['tags: [ui]']);

      const resolved = await resolveSlugOrFacet(activeRoot, 'widgets');

      expect(resolved.slug).toBe(SAMPLE_SLUG);
      expect(resolved.facet?.name).toBe('widgets');
    });
  });

  it('still resolves a unique slug prefix', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      expect(await resolveSlugOrFacet(activeRoot, 'sample')).toEqual({ slug: SAMPLE_SLUG });
    });
  });

  it('names known facets when nothing matches', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeFacet(activeRoot, SAMPLE_SLUG, 'widgets', ['tags: [ui]']);

      const attempt = resolveSlugOrFacet(activeRoot, 'nope');

      await expect(attempt).rejects.toThrow(NotFoundError);
      await expect(attempt).rejects.toThrow(
        `No initiative matches 'nope'. Known: ${SAMPLE_SLUG}. Facets: widgets (${SAMPLE_SLUG})`,
      );
    });
  });

  it('marks a miss as no_match so aw can offer to create it (TP-356)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const attempt = resolveSlugOrFacet(activeRoot, 'nope');

      await expect(attempt).rejects.toMatchObject({ reason: 'no_match' });
    });
  });

  it('leaves an ambiguous prefix without a no_match reason (TP-356)', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await addInitiative(activeRoot, 'sample-other');

      const attempt = resolveSlugOrFacet(activeRoot, 'sample');

      await expect(attempt).rejects.toThrow(/Ambiguous slug/);
      await expect(attempt).rejects.toSatisfy((err: NotFoundError) => err.reason === undefined);
    });
  });

  it('skips an unreadable facet file rather than failing resolution', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await writeFacet(activeRoot, SAMPLE_SLUG, 'broken', ['tags: []']);

      expect(await resolveSlugOrFacet(activeRoot, SAMPLE_SLUG)).toEqual({ slug: SAMPLE_SLUG });
      await expect(resolveSlugOrFacet(activeRoot, 'broken')).rejects.toThrow(NotFoundError);
    });
  });
});
