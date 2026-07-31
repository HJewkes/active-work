import { extractSignature } from './signature.js';
import { applyMasks } from './masks.js';
import { DrainTreeRegistry } from './route.js';
import { templateId as computeTemplateId } from './template-id.js';
import { appendOccurrence, appendOccurrences, loadTemplates, saveTemplates } from './store.js';
import { loadTreeSnapshots, saveTreeSnapshots, type TreeSnapshotFile } from './tree-store.js';
import { getMinerRoot } from '../utils/paths.js';
import type { Locator, Occurrence, Template } from '../schemas/template.js';

export interface IngestBlobInput {
  toolType: string;
  rawText: string;
  locator: Locator;
  sessionId: string;
  timestamp: string;
}

export interface IngestBlobResult {
  templateId: string;
  isNewTemplate: boolean;
}

export interface MinerIngestorOptions {
  /**
   * Hold occurrence appends and `templates.yml` rewrites in memory until
   * `flush()`. Off by default, so a single-blob caller keeps the durable
   * write-per-blob semantics AW-28 shipped with.
   *
   * A corpus pass ingests tens of thousands of blobs, and rewriting the whole
   * `templates.yml` per blob is O(blobs x templates) file I/O — minutes of
   * fsync for a run whose actual clustering work is seconds. The clustering
   * itself is unaffected: buffering changes only *when* bytes hit disk, never
   * which template a blob routes to.
   */
  buffered?: boolean;
}

function tokenize(signatureLine: string): string[] {
  return signatureLine.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Orchestrates one blob through the full AW-28 pipeline: signature
 * extraction -> masking -> Drain clustering -> template-id assignment ->
 * durable writes (`templates.yml` upsert, `occurrences.jsonl` append).
 *
 * A warm start restores its Drain trees from `<minerRoot>/drain-trees.json`
 * (AW-89), so every cluster comes back with the wildcards it had learned and
 * with its original `clusterId -> templateId` binding. That is what makes a
 * chunked sequence of ingest passes converge on the same template set as one
 * all-at-once pass — `tools/eval-drain.mjs` gates on exactly that.
 *
 * With no snapshot on disk (a pre-AW-89 store, or one whose rebuildable cache
 * was deleted) it falls back to seeding from `templates.yml`. That fallback is
 * the original *partial* rebuild: it re-inserts each template's first-seen
 * masked signature, so a template whose leading tokens were later wildcarded
 * can route to a different leaf than it did originally. It is correct in the
 * sense that nothing is lost — `occurrences.jsonl` remains the source of truth
 * per §C1 — but it is not fidelity-preserving, so the snapshot is the path a
 * normal warm start takes.
 */
export class MinerIngestor {
  private readonly registry = new DrainTreeRegistry();
  private readonly clusterTemplateIds = new Map<string, Map<number, string>>();
  private readonly templates: Map<string, Template>;
  private readonly root: string;
  private readonly buffered: boolean;
  private readonly pending: Occurrence[] = [];

  private constructor(
    templates: Template[],
    root: string,
    options: MinerIngestorOptions,
    snapshots: TreeSnapshotFile,
  ) {
    this.templates = new Map(templates.map((t) => [t.templateId, t]));
    this.root = root;
    this.buffered = options.buffered ?? false;
    if (snapshots.trees.length > 0) this.restoreTrees(snapshots);
    else this.seedFromTemplates(templates);
  }

  private restoreTrees(snapshots: TreeSnapshotFile): void {
    for (const tree of snapshots.trees) {
      this.registry.restore(tree.toolType, {
        nextClusterId: tree.nextClusterId,
        clusters: tree.clusters,
      });
      for (const [clusterId, id] of tree.templateIds) {
        this.rememberClusterId(tree.toolType, clusterId, id);
      }
    }
  }

  /** Pre-AW-89 fallback: rebuild leaves from first-seen masked signatures. */
  private seedFromTemplates(templates: Template[]): void {
    for (const template of templates) {
      const tree = this.registry.getTree(template.toolType);
      const { cluster } = tree.insert(tokenize(template.maskedSignature));
      this.rememberClusterId(template.toolType, cluster.clusterId, template.templateId);
    }
  }

  static async create(
    root: string = getMinerRoot(),
    options: MinerIngestorOptions = {},
  ): Promise<MinerIngestor> {
    const [templates, snapshots] = await Promise.all([
      loadTemplates(root),
      loadTreeSnapshots(root),
    ]);
    return new MinerIngestor(templates, root, options, snapshots);
  }

  /** Serialize every live tree plus its cluster→template bindings. */
  private treeSnapshotFile(): TreeSnapshotFile {
    const trees = Object.entries(this.registry.snapshot()).map(([toolType, snapshot]) => ({
      toolType,
      nextClusterId: snapshot.nextClusterId,
      clusters: snapshot.clusters,
      templateIds: [...(this.clusterTemplateIds.get(toolType) ?? new Map())].map(
        ([clusterId, id]): [number, string] => [clusterId, id],
      ),
    }));
    return { version: 1, trees };
  }

  private async persistTemplates(): Promise<void> {
    await saveTemplates([...this.templates.values()], this.root);
    await saveTreeSnapshots(this.treeSnapshotFile(), this.root);
  }

  private rememberClusterId(toolType: string, clusterId: number, id: string): void {
    let byCluster = this.clusterTemplateIds.get(toolType);
    if (!byCluster) {
      byCluster = new Map();
      this.clusterTemplateIds.set(toolType, byCluster);
    }
    byCluster.set(clusterId, id);
  }

  private lookupClusterId(toolType: string, clusterId: number): string | undefined {
    return this.clusterTemplateIds.get(toolType)?.get(clusterId);
  }

  async ingestBlob(input: IngestBlobInput): Promise<IngestBlobResult> {
    const signature = extractSignature(input.toolType, input.rawText);
    const { maskedSignature, extractedParams } = applyMasks(
      input.toolType,
      signature.signatureLine,
    );

    const tree = this.registry.getTree(input.toolType);
    const { cluster } = tree.insert(tokenize(maskedSignature));

    let id = this.lookupClusterId(input.toolType, cluster.clusterId);
    if (id === undefined) {
      id = computeTemplateId(input.toolType, maskedSignature);
      this.rememberClusterId(input.toolType, cluster.clusterId, id);
    }
    const existing = this.templates.get(id);
    const isNewTemplate = existing === undefined;

    const occurrence: Occurrence = {
      templateId: id,
      locator: input.locator,
      sessionId: input.sessionId,
      timestamp: input.timestamp,
      ...(Object.keys(extractedParams).length > 0 ? { extractedParams } : {}),
    };
    if (this.buffered) this.pending.push(occurrence);
    else await appendOccurrence(occurrence, this.root);

    const updated: Template = existing
      ? { ...existing, occurrenceCount: existing.occurrenceCount + 1 }
      : {
          templateId: id,
          toolType: input.toolType,
          maskedSignature,
          createdAt: input.timestamp,
          occurrenceCount: 1,
          exemplarLocator: input.locator,
        };
    this.templates.set(id, updated);
    if (!this.buffered) await this.persistTemplates();

    return { templateId: id, isNewTemplate };
  }

  /**
   * Write everything buffered since the last flush. A no-op in unbuffered
   * mode, so callers can flush unconditionally.
   */
  async flush(): Promise<void> {
    if (!this.buffered) return;
    await appendOccurrences(this.pending, this.root);
    this.pending.length = 0;
    await this.persistTemplates();
  }

  get templateCount(): number {
    return this.templates.size;
  }

  /** True once any Drain partition is at its LRU cap (see `DrainTree.atCapacity`). */
  get evicting(): boolean {
    return this.registry.anyAtCapacity;
  }
}
