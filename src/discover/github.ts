import type { DiscoveryHit, DiscoverySourceError } from './types.js';
import { runCommand, type RunCommand } from './run-command.js';

/**
 * Discover open PRs authored by the current user, per repo.
 *
 * Shells out to `gh pr list --author @me --state open` and converts each
 * PR to a `DiscoveryHit`. Failures (gh missing, auth, network) are
 * captured per-repo and never thrown.
 */

interface GhPullRequest {
  number: number;
  title: string;
  isDraft: boolean;
  headRefName: string;
  updatedAt: string;
}

export interface DiscoverGitHubResult {
  hits: DiscoveryHit[];
  errors: DiscoverySourceError[];
}

export async function discoverGitHub(
  repos: string[],
  run: RunCommand = runCommand,
): Promise<DiscoverGitHubResult> {
  const hits: DiscoveryHit[] = [];
  const errors: DiscoverySourceError[] = [];

  for (const repo of repos) {
    const sourceId = `gh:${repo}`;
    try {
      const result = await run('gh', [
        'pr',
        'list',
        '--author',
        '@me',
        '--state',
        'open',
        '--limit',
        '100',
        '--repo',
        repo,
        '--json',
        'number,title,isDraft,headRefName,updatedAt',
      ]);
      if (result.code !== 0) {
        errors.push({
          source: sourceId,
          error: result.stderr.trim() || `gh exited with code ${result.code}`,
        });
        continue;
      }
      const parsed = JSON.parse(result.stdout) as GhPullRequest[];
      for (const pr of parsed) {
        hits.push({
          source: sourceId,
          ref: pr.headRefName,
          detail: `${pr.isDraft ? '[draft] ' : ''}#${pr.number} ${pr.title}`,
          metadata: {
            repo,
            number: pr.number,
            title: pr.title,
            isDraft: pr.isDraft,
            headRefName: pr.headRefName,
            updatedAt: pr.updatedAt,
          },
        });
      }
    } catch (err) {
      errors.push({
        source: sourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { hits, errors };
}
