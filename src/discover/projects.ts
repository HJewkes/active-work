import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import type { DiscoveryHit, DiscoverySourceError } from './types.js';
import { expandTilde } from '../utils/paths.js';

/**
 * Scan a "projects root" directory (e.g. `~/code`) and surface each
 * top-level subdir as a potential work item. Skips dotfiles and the
 * conventional `active` worktree-staging dir.
 */

export interface DiscoverProjectsResult {
  hits: DiscoveryHit[];
  errors: DiscoverySourceError[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RECENT_THRESHOLD_DAYS = 30;

export async function discoverProjects(
  projectsRoot: string,
): Promise<DiscoverProjectsResult> {
  const hits: DiscoveryHit[] = [];
  const errors: DiscoverySourceError[] = [];

  if (!projectsRoot) return { hits, errors };

  const resolved = path.resolve(expandTilde(projectsRoot));
  let entries: Dirent[];
  try {
    entries = await fs.readdir(resolved, { withFileTypes: true });
  } catch (err) {
    errors.push({
      source: 'projects',
      error: err instanceof Error ? err.message : String(err),
    });
    return { hits, errors };
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'active') continue;

    const fullPath = path.join(resolved, entry.name);
    let mtimeMs = 0;
    try {
      const stat = await fs.stat(fullPath);
      mtimeMs = stat.mtimeMs;
    } catch (err) {
      errors.push({
        source: `projects:${entry.name}`,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const ageDays = (now - mtimeMs) / MS_PER_DAY;
    const recency =
      ageDays <= RECENT_THRESHOLD_DAYS
        ? `modified <${RECENT_THRESHOLD_DAYS}d ago`
        : 'older';
    hits.push({
      source: 'projects',
      ref: entry.name,
      detail: `${entry.name} (${recency})`,
      metadata: {
        name: entry.name,
        path: fullPath,
        mtime: new Date(mtimeMs).toISOString(),
        ageDays: Math.round(ageDays),
        recency,
      },
    });
  }

  return { hits, errors };
}
