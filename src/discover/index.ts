import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getActiveRoot } from '../utils/paths.js';
import type {
  DiscoveryConfig,
  DiscoveryHit,
  DiscoveryResult,
  DiscoverySourceError,
} from './types.js';
import { discoverGitHub } from './github.js';
import { discoverGit } from './git.js';
import { discoverProjects } from './projects.js';
import { discoverClaudeSessions } from './claude.js';

/**
 * Run every discovery source the config asks for, aggregate hits, then
 * cross-reference against the set of known initiative slugs sitting in
 * `<activeRoot>/*` and suppress anything already triaged via
 * `<activeRoot>/.triaged.log`.
 */

export async function runDiscovery(config: DiscoveryConfig): Promise<DiscoveryResult> {
  const allHits: DiscoveryHit[] = [];
  const allErrors: DiscoverySourceError[] = [];

  const githubRepos = config.github_repos ?? [];
  const localRepos = config.local_repos ?? [];
  const projectsRoot = config.projects_root ?? '';

  if (githubRepos.length > 0) {
    const r = await discoverGitHub(githubRepos);
    allHits.push(...r.hits);
    allErrors.push(...r.errors);
  }
  if (localRepos.length > 0) {
    const r = await discoverGit(localRepos);
    allHits.push(...r.hits);
    allErrors.push(...r.errors);
  }
  if (projectsRoot.length > 0) {
    const r = await discoverProjects(projectsRoot);
    allHits.push(...r.hits);
    allErrors.push(...r.errors);
  }
  // Claude session scanning is cheap and config-free, so always run it.
  const claude = await discoverClaudeSessions();
  allHits.push(...claude.hits);
  allErrors.push(...claude.errors);

  const activeRoot = getActiveRoot();
  const slugs = await loadSlugs(activeRoot);
  const suppressed = await loadTriagedRefs(activeRoot);

  const filtered: DiscoveryHit[] = [];
  for (const hit of allHits) {
    if (suppressed.has(hit.ref)) continue;
    const match = matchSlug(hit, slugs);
    if (match) {
      hit.slug_match = match;
      hit.untracked = false;
    } else {
      hit.untracked = true;
    }
    filtered.push(hit);
  }

  return { hits: filtered, errors: allErrors };
}

async function loadSlugs(activeRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(activeRoot, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function loadTriagedRefs(activeRoot: string): Promise<Set<string>> {
  const logPath = path.join(activeRoot, '.triaged.log');
  const refs = new Set<string>();
  try {
    const raw = await fs.readFile(logPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      // Format: <iso>\t<action>\t<ref>\t<extra>
      const ref = parts[2];
      if (ref) refs.add(ref);
    }
  } catch {
    // No log yet — nothing to suppress.
  }
  return refs;
}

function matchSlug(hit: DiscoveryHit, slugs: string[]): string | undefined {
  const haystacks: string[] = [hit.ref.toLowerCase()];
  const cwd = hit.metadata?.cwd;
  if (typeof cwd === 'string') haystacks.push(cwd.toLowerCase());
  for (const slug of slugs) {
    const needle = slug.toLowerCase();
    if (haystacks.some((h) => h.includes(needle))) return slug;
  }
  return undefined;
}

export type { DiscoveryConfig, DiscoveryHit, DiscoveryResult } from './types.js';
