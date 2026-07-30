import { mergeTemplate, tokenSimilarity } from './similarity.js';
import type { DrainCluster, MatchResult } from './types.js';
import { WILDCARD } from './types.js';

export interface DrainTreeOptions {
  /**
   * Fixed depth of the prefix tree, matching Drain3's convention: depth
   * includes the root and the token-count branch, so `depth - 2` levels of
   * the tree branch on literal first-tokens before reaching leaf clusters.
   */
  depth?: number;
  /** Minimum token-position similarity (§similarity.ts) to join a cluster. */
  simTh?: number;
  /** Max distinct literal-token children per internal node before overflow collapses to a wildcard branch. */
  maxChildren?: number;
  /** LRU cap on total clusters across the tree; oldest-accessed cluster is evicted on overflow. */
  maxClusters?: number;
}

interface PrefixNode {
  children: Map<string, PrefixNode>;
  clusters?: DrainCluster[];
}

function newNode(): PrefixNode {
  return { children: new Map() };
}

/**
 * A fixed-depth Drain prefix tree (ICWS 2017), partitioned by token count at
 * the root, then by literal first-tokens down to `depth - 2` levels, with
 * leaf nodes holding the clusters matched by token-position similarity.
 *
 * One `DrainTree` instance is one partition (one tool type) — see
 * `src/miner/route.ts` for the per-tool-type registry.
 */
export class DrainTree {
  private readonly depth: number;
  private readonly simTh: number;
  private readonly maxChildren: number;
  private readonly maxClusters: number;

  private readonly lengthRoots = new Map<number, PrefixNode>();
  /** Recency order for LRU eviction: re-inserted on every access, oldest key evicted first. */
  private readonly recency = new Map<number, DrainCluster>();
  private nextClusterId = 1;

  constructor(options: DrainTreeOptions = {}) {
    this.depth = options.depth ?? 4;
    this.simTh = options.simTh ?? 0.55;
    this.maxChildren = options.maxChildren ?? 100;
    this.maxClusters = options.maxClusters ?? 2000;
  }

  get clusterCount(): number {
    return this.recency.size;
  }

  /** Insert a tokenized line, returning the cluster it joined or created. */
  insert(tokens: string[]): MatchResult {
    const leaf = this.walkToLeaf(tokens);
    const clusters = (leaf.clusters ??= []);

    const best = this.bestMatch(clusters, tokens);
    if (best) {
      const merged = mergeTemplate(best.tokens, tokens);
      const templateChanged = merged.some((t, i) => t !== best.tokens[i]);
      best.tokens = merged;
      best.size += 1;
      this.touch(best);
      return { cluster: best, isNew: false, templateChanged };
    }

    const cluster: DrainCluster = { clusterId: this.nextClusterId++, tokens: [...tokens], size: 1 };
    clusters.push(cluster);
    this.touch(cluster);
    this.evictIfOverCapacity();
    return { cluster, isNew: true, templateChanged: false };
  }

  private bestMatch(clusters: DrainCluster[], tokens: string[]): DrainCluster | undefined {
    let best: DrainCluster | undefined;
    let bestSim = -1;
    for (const cluster of clusters) {
      const sim = tokenSimilarity(cluster.tokens, tokens);
      if (sim >= this.simTh && sim > bestSim) {
        best = cluster;
        bestSim = sim;
      }
    }
    return best;
  }

  private walkToLeaf(tokens: string[]): PrefixNode {
    let node = this.lengthRoots.get(tokens.length);
    if (!node) {
      node = newNode();
      this.lengthRoots.set(tokens.length, node);
    }

    const prefixLevels = Math.min(Math.max(this.depth - 2, 0), tokens.length);
    for (let i = 0; i < prefixLevels; i++) {
      node = this.step(node, tokens[i]);
    }
    return node;
  }

  private step(node: PrefixNode, token: string): PrefixNode {
    let child = node.children.get(token);
    if (child) return child;

    const distinctChildren = [...node.children.keys()].filter((k) => k !== WILDCARD).length;
    const key = distinctChildren >= this.maxChildren ? WILDCARD : token;

    child = node.children.get(key);
    if (!child) {
      child = newNode();
      node.children.set(key, child);
    }
    return child;
  }

  private touch(cluster: DrainCluster): void {
    this.recency.delete(cluster.clusterId);
    this.recency.set(cluster.clusterId, cluster);
  }

  private evictIfOverCapacity(): void {
    if (this.recency.size <= this.maxClusters) return;
    const oldestId = this.recency.keys().next().value as number;
    const oldest = this.recency.get(oldestId);
    this.recency.delete(oldestId);
    if (!oldest) return;

    const leaf = this.walkToLeaf(oldest.tokens);
    if (!leaf.clusters) return;
    leaf.clusters = leaf.clusters.filter((c) => c.clusterId !== oldest.clusterId);
  }
}
