import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ArtifactsSchema } from '../schemas/artifacts.js';
import { writeYaml } from '../utils/yaml-io.js';
import type { Migration } from './types.js';

/**
 * v1 → v2 (AW-15): collapse `artifacts.yml` to a branches+stashes-only
 * schema and surface dropped PR entries via a migration log.
 *
 * Per-file transforms:
 * - `prs:` is dropped entirely. Each entry is logged at WARN to
 *   `<activeRoot>/.migrations.log` so the user can reconcile manually.
 * - `branches[].last_commit` is dropped.
 * - `stashes[].message` → `stashes[].label`; `created` is dropped; `sha`
 *   is preserved if present.
 *
 * The walk covers active-root initiatives and (best-effort) archived ones
 * under `<archiveRoot>/<domain>/archive/<slug>/artifacts.yml`, where
 * `archiveRoot` is the parent directory of the active root.
 *
 * Idempotent: re-running on already-v2 files leaves them unchanged
 * (extraneous keys like `prs:` simply aren't present in the v2 input).
 */

interface V1Pr {
  number?: number;
  repo?: string;
  title?: string;
  status?: string;
}

interface V1Branch {
  repo?: string;
  name?: string;
  last_commit?: string;
  note?: string;
}

interface V1Stash {
  repo?: string;
  message?: string;
  label?: string;
  created?: string;
  sha?: string;
}

interface RawArtifacts {
  prs?: V1Pr[];
  branches?: V1Branch[];
  stashes?: V1Stash[];
  [key: string]: unknown;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normaliseBranch(b: V1Branch): { repo: string; name: string; note?: string } | null {
  if (typeof b.repo !== 'string' || typeof b.name !== 'string') return null;
  if (b.repo.length === 0 || b.name.length === 0) return null;
  const out: { repo: string; name: string; note?: string } = {
    repo: b.repo,
    name: b.name,
  };
  if (typeof b.note === 'string' && b.note.length > 0) out.note = b.note;
  return out;
}

function normaliseStash(
  s: V1Stash,
): { repo: string; label: string; sha?: string } | null {
  if (typeof s.repo !== 'string' || s.repo.length === 0) return null;
  // v1 used `message`; v2 uses `label`. Prefer label if both present.
  const label =
    typeof s.label === 'string' && s.label.length > 0
      ? s.label
      : typeof s.message === 'string'
        ? s.message
        : '';
  if (label.length === 0) return null;
  const out: { repo: string; label: string; sha?: string } = { repo: s.repo, label };
  if (typeof s.sha === 'string' && s.sha.length > 0) out.sha = s.sha;
  return out;
}

interface MigrateOneResult {
  changed: boolean;
  droppedPrs: V1Pr[];
}

async function migrateOne(filePath: string): Promise<MigrateOneResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return { changed: false, droppedPrs: [] };
  }

  let parsed: RawArtifacts;
  try {
    parsed = (YAML.parse(raw) ?? {}) as RawArtifacts;
  } catch {
    // Malformed YAML — leave it; user will see it on next read.
    return { changed: false, droppedPrs: [] };
  }

  const droppedPrs = asArray<V1Pr>(parsed.prs);
  const branches = asArray<V1Branch>(parsed.branches)
    .map(normaliseBranch)
    .filter((b): b is { repo: string; name: string; note?: string } => b !== null);
  const stashes = asArray<V1Stash>(parsed.stashes)
    .map(normaliseStash)
    .filter((s): s is { repo: string; label: string; sha?: string } => s !== null);

  // Detect a no-op: prs absent, no last_commit on branches, no message-only stashes.
  const branchHadLegacy = asArray<V1Branch>(parsed.branches).some(
    (b) => typeof b.last_commit === 'string',
  );
  const stashHadLegacy = asArray<V1Stash>(parsed.stashes).some(
    (s) => typeof s.message === 'string' || typeof s.created === 'string',
  );
  const hadPrs = droppedPrs.length > 0 || parsed.prs !== undefined;
  if (!branchHadLegacy && !stashHadLegacy && !hadPrs) {
    return { changed: false, droppedPrs: [] };
  }

  const next = ArtifactsSchema.parse({ branches, stashes });
  await writeYaml(filePath, next, ArtifactsSchema);
  return { changed: true, droppedPrs };
}

async function walkArtifactsFiles(activeRoot: string): Promise<string[]> {
  const out: string[] = [];

  // Active initiatives: <activeRoot>/<slug>/artifacts.yml
  try {
    const entries = await fs.readdir(activeRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const candidate = path.join(activeRoot, entry.name, 'artifacts.yml');
      try {
        await fs.access(candidate);
        out.push(candidate);
      } catch {
        // skip
      }
    }
  } catch {
    // active root may not exist; nothing to migrate.
  }

  // Archived initiatives: <archiveRoot>/<domain>/archive/<slug-YYYY-MM>/artifacts.yml
  const archiveRoot = path.resolve(activeRoot, '..');
  try {
    const domains = await fs.readdir(archiveRoot, { withFileTypes: true });
    for (const domain of domains) {
      if (!domain.isDirectory()) continue;
      if (domain.name.startsWith('.')) continue;
      // Skip the active root itself when scanning its parent.
      if (path.join(archiveRoot, domain.name) === path.resolve(activeRoot)) continue;
      const archiveDir = path.join(archiveRoot, domain.name, 'archive');
      let archived: Dirent[];
      try {
        archived = await fs.readdir(archiveDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of archived) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(archiveDir, entry.name, 'artifacts.yml');
        try {
          await fs.access(candidate);
          out.push(candidate);
        } catch {
          // skip
        }
      }
    }
  } catch {
    // best-effort
  }

  return out;
}

async function appendMigrationLog(activeRoot: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  const logPath = path.join(activeRoot, '.migrations.log');
  const stamp = new Date().toISOString();
  const body = lines.map((l) => `${stamp}\tv1->v2\t${l}\n`).join('');
  try {
    await fs.mkdir(activeRoot, { recursive: true });
  } catch {
    // ignore
  }
  await fs.appendFile(logPath, body, 'utf8');
}

export const v1ToV2Artifacts: Migration = {
  from: 1,
  to: 2,
  description: 'Drop prs[] / last_commit / stash.message from artifacts.yml',
  async run(activeRoot: string): Promise<void> {
    const files = await walkArtifactsFiles(activeRoot);
    const logEntries: string[] = [];
    for (const file of files) {
      const { droppedPrs } = await migrateOne(file);
      for (const pr of droppedPrs) {
        const num = typeof pr.number === 'number' ? `#${pr.number}` : '#?';
        const repo = pr.repo ?? '(unknown repo)';
        const title = pr.title ?? '(no title)';
        logEntries.push(`${file}\t${num} (${repo}) ${title}`);
      }
    }
    await appendMigrationLog(activeRoot, logEntries);
  },
};

export default v1ToV2Artifacts;
