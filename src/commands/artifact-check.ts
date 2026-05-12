import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { ArtifactsSchema } from '../schemas/artifacts.js';
import { getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { nowIso } from '../utils/today.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
});

const UpdatedSchema = z.object({
  number: z.number(),
  repo: z.string(),
  status: z.enum(['open', 'merged', 'closed']),
  status_changed: z.boolean(),
});

const ErrorSchema = z.object({
  number: z.number(),
  repo: z.string(),
  error: z.string(),
});

const ResultSchema = z.object({
  slug: z.string(),
  updated: z.array(UpdatedSchema),
  errors: z.array(ErrorSchema),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

type PrStatus = 'open' | 'merged' | 'closed';

export interface GhPrFetcher {
  (number: number, repo: string): Promise<{ state: string }>;
}

/** Default fetcher: shell out to `gh pr view <n> --repo <repo> --json state`. */
export const defaultGhFetcher: GhPrFetcher = (number, repo) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'gh',
      ['pr', 'view', String(number), '--repo', repo, '--json', 'state'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `gh exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { state?: unknown };
        if (typeof parsed.state !== 'string') {
          reject(new Error(`gh response missing state field: ${stdout}`));
          return;
        }
        resolve({ state: parsed.state });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });

/** Map gh's uppercase state to our lowercase artifact status. */
export function mapGhState(state: string): PrStatus {
  switch (state.toUpperCase()) {
    case 'OPEN':
      return 'open';
    case 'MERGED':
      return 'merged';
    case 'CLOSED':
      return 'closed';
    default:
      throw new Error(`Unknown gh PR state: ${state}`);
  }
}

let fetcher: GhPrFetcher = defaultGhFetcher;

/** Override the gh fetcher (used by tests). */
export function setGhFetcher(next: GhPrFetcher): void {
  fetcher = next;
}

/** Restore the default gh fetcher. */
export function resetGhFetcher(): void {
  fetcher = defaultGhFetcher;
}

export default defineCommand<Args, Result>({
  name: 'artifact.check',
  description: 'Refresh PR statuses in artifacts.yml via `gh pr view`.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
  },
  async run(args) {
    const artifactsPath = path.join(getInitiativeDir(args.slug), 'artifacts.yml');
    return withFileLock(getLockPath(args.slug), async () => {
      const current = await readYaml(artifactsPath, ArtifactsSchema);
      const updated: Array<z.infer<typeof UpdatedSchema>> = [];
      const errors: Array<z.infer<typeof ErrorSchema>> = [];
      const stamp = nowIso();

      for (const pr of current.prs) {
        try {
          const { state } = await fetcher(pr.number, pr.repo);
          const next = mapGhState(state);
          const changed = next !== pr.status;
          pr.status = next;
          pr.last_checked = stamp;
          updated.push({
            number: pr.number,
            repo: pr.repo,
            status: next,
            status_changed: changed,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ number: pr.number, repo: pr.repo, error: message });
        }
      }

      await writeYaml(artifactsPath, current, ArtifactsSchema);
      return { slug: args.slug, updated, errors };
    });
  },
});
