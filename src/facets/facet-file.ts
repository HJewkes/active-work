import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FacetFrontmatterSchema, type FacetFrontmatter } from '../schemas/facet.js';
import { readMarkdownWithSchema } from '../bootstrap/prompt.js';
import { writeFrontmatter } from '../utils/gray-matter-io.js';

/** A sub-area alias that opens its owning initiative scoped to some tags. */
export interface LoadedFacet {
  name: string;
  owner: string;
  tags: string[];
  about?: string;
  body: string;
  path: string;
}

export interface MalformedFacet {
  path: string;
  error: string;
}

export interface LoadedFacets {
  facets: LoadedFacet[];
  malformed: MalformedFacet[];
}

export function getFacetPath(activeRoot: string, owner: string, alias: string): string {
  return path.join(activeRoot, owner, 'facets', `${alias}.md`);
}

async function listFacetFiles(activeRoot: string, owner: string): Promise<string[]> {
  try {
    const names = await fs.readdir(path.join(activeRoot, owner, 'facets'));
    return names.filter((name) => name.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

async function loadFacet(activeRoot: string, owner: string, file: string): Promise<LoadedFacet> {
  const name = file.slice(0, -'.md'.length);
  const facetPath = getFacetPath(activeRoot, owner, name);
  const { frontmatter, body } = await readMarkdownWithSchema(facetPath, FacetFrontmatterSchema);
  return {
    name,
    owner,
    tags: frontmatter.tags,
    ...(frontmatter.about !== undefined ? { about: frontmatter.about } : {}),
    body: body.trim(),
    path: facetPath,
  };
}

/** Every facet under the given initiatives; an unreadable file is reported, never fatal. */
export async function listFacets(activeRoot: string, owners: string[]): Promise<LoadedFacets> {
  const result: LoadedFacets = { facets: [], malformed: [] };
  for (const owner of owners) {
    for (const file of await listFacetFiles(activeRoot, owner)) {
      try {
        result.facets.push(await loadFacet(activeRoot, owner, file));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        result.malformed.push({ path: path.join(activeRoot, owner, 'facets', file), error });
      }
    }
  }
  return result;
}

export async function writeFacetFile(
  facetPath: string,
  frontmatter: FacetFrontmatter,
  body: string,
): Promise<void> {
  await fs.mkdir(path.dirname(facetPath), { recursive: true });
  await writeFrontmatter(facetPath, frontmatter, body, FacetFrontmatterSchema);
}
