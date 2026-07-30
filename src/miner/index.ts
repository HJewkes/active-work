import { extractSignature } from './signature.js';
import { applyMasks } from './masks.js';
import { DrainTreeRegistry } from './route.js';
import { templateId as computeTemplateId } from './template-id.js';
import { appendOccurrence, loadTemplates, saveTemplates } from './store.js';
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

function tokenize(signatureLine: string): string[] {
  return signatureLine.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Orchestrates one blob through the full AW-28 pipeline: signature
 * extraction -> masking -> Drain clustering -> template-id assignment ->
 * durable writes (`templates.yml` upsert, `occurrences.jsonl` append).
 *
 * `MinerIngestor` seeds its in-memory Drain trees from the persisted
 * `templates.yml` on construction, so a warm start recognizes previously-seen
 * template shapes rather than re-creating them. This is a *partial* rebuild:
 * it reconstructs each template's leaf by re-inserting its current
 * (possibly already-generalized) tokens, not by replaying the original
 * per-occurrence insertion history, so a template whose leading tokens have
 * since been wildcarded may route to a different leaf on restart than it
 * did originally. Full history-faithful rebuild (via a persisted Drain-tree
 * snapshot or per-occurrence replay) is deferred to the transcript-reader/
 * CLI follow-up — this is the "rebuildable cache" gap called out in
 * sources/deepdive-session-mining-build-specs.md §C1.
 */
export class MinerIngestor {
  private readonly registry = new DrainTreeRegistry();
  private readonly clusterTemplateIds = new Map<string, Map<number, string>>();
  private readonly templates: Map<string, Template>;
  private readonly root: string;

  private constructor(templates: Template[], root: string) {
    this.templates = new Map(templates.map((t) => [t.templateId, t]));
    this.root = root;
    for (const template of templates) {
      const tree = this.registry.getTree(template.toolType);
      const { cluster } = tree.insert(tokenize(template.maskedSignature));
      this.rememberClusterId(template.toolType, cluster.clusterId, template.templateId);
    }
  }

  static async create(root: string = getMinerRoot()): Promise<MinerIngestor> {
    const templates = await loadTemplates(root);
    return new MinerIngestor(templates, root);
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
    await appendOccurrence(occurrence, this.root);

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
    await saveTemplates([...this.templates.values()], this.root);

    return { templateId: id, isNewTemplate };
  }
}
