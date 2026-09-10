import { Clusterer } from '@titan-design/cluster';
import { appendOccurrence, appendOccurrences, loadTemplates, saveTemplates } from './store.js';
import { loadTreeSnapshots, saveTreeSnapshots } from './tree-store.js';
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

/**
 * Puts one blob through `@titan-design/cluster` and durably records what came
 * out: a `templates.yml` upsert and an `occurrences.jsonl` append.
 *
 * The clustering — signature extraction, masking, Drain, template id — is the
 * package's. What is active-work's is the store on either side of it, and the
 * fact that a template's occurrence count is a property of that store rather
 * than of the live clusterer.
 *
 * A warm start restores the Drain trees from `<minerRoot>/drain-trees.json`
 * (AW-89), so every cluster comes back with the wildcards it had learned and
 * with its original `clusterId -> templateId` binding. That is what makes a
 * chunked sequence of ingest passes converge on the same template set as one
 * all-at-once pass — `tools/eval-drain.mjs` gates on exactly that.
 */
export class MinerIngestor {
  private readonly clusterer: Clusterer;
  private readonly templates: Map<string, Template>;
  private readonly root: string;
  private readonly buffered: boolean;
  private readonly pending: Occurrence[] = [];

  private constructor(
    clusterer: Clusterer,
    templates: Template[],
    root: string,
    options: MinerIngestorOptions,
  ) {
    this.clusterer = clusterer;
    this.templates = new Map(templates.map((t) => [t.templateId, t]));
    this.root = root;
    this.buffered = options.buffered ?? false;
  }

  static async create(
    root: string = getMinerRoot(),
    options: MinerIngestorOptions = {},
  ): Promise<MinerIngestor> {
    const [templates, snapshot] = await Promise.all([loadTemplates(root), loadTreeSnapshots(root)]);
    return new MinerIngestor(Clusterer.fromSnapshot(snapshot), templates, root, options);
  }

  private async persistTemplates(): Promise<void> {
    await saveTemplates([...this.templates.values()], this.root);
    await saveTreeSnapshots(this.clusterer.snapshot(), this.root);
  }

  async ingestBlob(input: IngestBlobInput): Promise<IngestBlobResult> {
    const clustered = this.clusterer.cluster({ partition: input.toolType, text: input.rawText });
    const existing = this.templates.get(clustered.templateId);
    // The store decides what "new" means, not the clusterer: a template already
    // in `templates.yml` is not new just because this process minted its id for
    // the first time (a cold start with no snapshot does exactly that).
    const isNewTemplate = existing === undefined;

    const occurrence: Occurrence = {
      templateId: clustered.templateId,
      locator: input.locator,
      sessionId: input.sessionId,
      timestamp: input.timestamp,
      ...(Object.keys(clustered.extractedParams).length > 0
        ? { extractedParams: clustered.extractedParams }
        : {}),
    };
    if (this.buffered) this.pending.push(occurrence);
    else await appendOccurrence(occurrence, this.root);

    const updated: Template = existing
      ? { ...existing, occurrenceCount: existing.occurrenceCount + 1 }
      : {
          templateId: clustered.templateId,
          toolType: input.toolType,
          maskedSignature: clustered.maskedSignature,
          createdAt: input.timestamp,
          occurrenceCount: 1,
          exemplarLocator: input.locator,
        };
    this.templates.set(clustered.templateId, updated);
    if (!this.buffered) await this.persistTemplates();

    return { templateId: clustered.templateId, isNewTemplate };
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

  /** True once any Drain partition is at its cluster cap (see `DrainTree.atCapacity`). */
  get evicting(): boolean {
    return this.clusterer.evicting;
  }
}
