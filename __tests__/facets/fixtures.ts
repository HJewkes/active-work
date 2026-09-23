import { promises as fs } from 'node:fs';
import path from 'node:path';

export const SAMPLE_SLUG = 'sample-initiative';

export async function writeFacet(
  activeRoot: string,
  owner: string,
  alias: string,
  frontmatter: string[],
  body = '',
): Promise<void> {
  const dir = path.join(activeRoot, owner, 'facets');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${alias}.md`),
    ['---', ...frontmatter, '---', body].join('\n'),
  );
}

/** A second initiative dir with a parseable brief, cloned from the fixture's. */
export async function addInitiative(activeRoot: string, slug: string): Promise<void> {
  const dir = path.join(activeRoot, slug);
  await fs.mkdir(path.join(dir, 'tasks'), { recursive: true });
  await fs.copyFile(path.join(activeRoot, SAMPLE_SLUG, 'brief.md'), path.join(dir, 'brief.md'));
}
