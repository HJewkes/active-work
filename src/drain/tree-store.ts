import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ClustererSnapshot } from '@titan-design/cluster';
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
 *
 * The schema mirrors `ClustererSnapshot` because that is what
 * `@titan-design/cluster` restores from. It is validated on the way in and out
 * anyway: the package promises a shape, this file is a place a human or a half
 * -written run can corrupt, and a bad snapshot must not take the ingest down.
 */

const PartitionSchema = z.object({
  partition: z.string().min(1),
  nextClusterId: z.number().int().positive(),
  clusters: z.array(
    z.object({
      clusterId: z.number().int().positive(),
      tokens: z.array(z.string()),
      size: z.number().int().nonnegative(),
    }),
  ),
  /** `clusterId -> templateId`, as pairs so the file has a stable order. */
  templateIds: z.array(z.tuple([z.number().int().positive(), z.string().min(1)])),
});

export const TreeSnapshotFileSchema = z.object({
  version: z.literal(1).default(1),
  partitions: z.array(PartitionSchema).default([]),
});

/**
 * The pre-package file, which keyed each tree by `toolType` and called the list
 * `trees`. Read so an upgrade keeps the wildcards the live trees had learned:
 * discarding it instead would cost the ~6% template-set divergence AW-89 was
 * built to remove, once, on every existing store.
 */
const LegacySnapshotFileSchema = z.object({
  version: z.literal(1),
  trees: z.array(PartitionSchema.omit({ partition: true }).extend({ toolType: z.string().min(1) })),
});

function snapshotPath(root: string): string {
  return path.join(root, 'drain-trees.json');
}

function empty(): ClustererSnapshot {
  return { version: 1, partitions: [] };
}

/** A snapshot that will not parse is discarded rather than thrown: it is a cache. */
export async function loadTreeSnapshots(root: string = getMinerRoot()): Promise<ClustererSnapshot> {
  let raw: string;
  try {
    raw = await fs.readFile(snapshotPath(root), 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return empty();
    throw err;
  }
  const value: unknown = JSON.parse(raw);
  // Legacy first: zod strips unknown keys, so the current schema would read a
  // `trees` file as an empty snapshot and report success.
  const legacy = LegacySnapshotFileSchema.safeParse(value);
  if (legacy.success) {
    return {
      version: 1,
      partitions: legacy.data.trees.map(({ toolType, ...tree }) => ({
        partition: toolType,
        ...tree,
      })),
    };
  }
  const parsed = TreeSnapshotFileSchema.safeParse(value);
  return parsed.success ? parsed.data : empty();
}

export async function saveTreeSnapshots(
  snapshot: ClustererSnapshot,
  root: string = getMinerRoot(),
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await atomicWrite(
    snapshotPath(root),
    `${JSON.stringify(TreeSnapshotFileSchema.parse(snapshot))}\n`,
  );
}
