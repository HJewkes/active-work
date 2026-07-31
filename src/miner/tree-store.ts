import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '../utils/fs-atomic.js';
import { getMinerRoot } from '../utils/paths.js';

/**
 * `<minerRoot>/drain-trees.json` — the Drain clustering state, persisted so a
 * warm start resumes from the tree it left off with.
 *
 * Still a *rebuildable cache* in the §C1 sense: deleting it costs clustering
 * fidelity across the restart, not data, since `occurrences.jsonl` plus a
 * re-run of `ingestBlob` reconstructs everything. What it buys is that a
 * chunked sequence of ingest passes produces the same templates as one
 * all-at-once pass. Before AW-89 a warm start re-inserted each template's
 * *first-seen* masked signature through `insert()`, losing every wildcard the
 * live tree had learned; `tools/eval-drain.mjs` measured that as a real ~6%
 * template-set divergence on the operator's corpus, which is why this exists.
 */

const ClusterSchema = z.object({
  clusterId: z.number().int().positive(),
  tokens: z.array(z.string()),
  size: z.number().int().nonnegative(),
});

const TreeSchema = z.object({
  toolType: z.string().min(1),
  nextClusterId: z.number().int().positive(),
  clusters: z.array(ClusterSchema),
  /** `clusterId -> templateId`, as pairs so the file has a stable order. */
  templateIds: z.array(z.tuple([z.number().int().positive(), z.string().min(1)])),
});

export const TreeSnapshotFileSchema = z.object({
  version: z.literal(1).default(1),
  trees: z.array(TreeSchema).default([]),
});

export type TreeSnapshotFile = z.infer<typeof TreeSnapshotFileSchema>;

function snapshotPath(root: string): string {
  return path.join(root, 'drain-trees.json');
}

export async function loadTreeSnapshots(root: string = getMinerRoot()): Promise<TreeSnapshotFile> {
  try {
    const raw = await fs.readFile(snapshotPath(root), 'utf8');
    return TreeSnapshotFileSchema.parse(JSON.parse(raw));
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return { version: 1, trees: [] };
    }
    throw err;
  }
}

export async function saveTreeSnapshots(
  file: TreeSnapshotFile,
  root: string = getMinerRoot(),
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await atomicWrite(snapshotPath(root), `${JSON.stringify(TreeSnapshotFileSchema.parse(file))}\n`);
}
