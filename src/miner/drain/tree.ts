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
  /**
   * Cap on total clusters in this (single-tool-type) tree. On overflow the
   * *least-supported* cluster is evicted — see `evictIfOverCapacity`.
   *
   * The default is sized from the real corpus (AW-92): 710 transcripts /
   * 23.3k blobs converge on ~2.3k clusters in the busiest partition (`Bash`),
   * so 2000 was below the steady state and the tree evicted continuously over
   * the last ~8% of the corpus. 5000 leaves ~2x headroom while keeping the
   * memory bound the cap exists for (a cluster is one token array; 5000 of
   * them is single-digit MB).
   */
  maxClusters?: number;
}

interface PrefixNode {
  children: Map<string, PrefixNode>;
  clusters?: DrainCluster[];
}

/**
 * A tree's complete clustering state: every live cluster in LRU order, plus
 * the id counter.
 *
 * The prefix nodes themselves are not stored because they are derivable —
 * `walkToLeaf(cluster.tokens)` re-creates the path a cluster belongs on, the
 * same assumption `evictIfOverCapacity` already relies on to unlink a cluster.
 * What matters is that the clusters come back with their *generalized* tokens
 * and their original ids, which is exactly what re-inserting them through
 * `insert()` cannot guarantee.
 */
export interface DrainTreeSnapshot {
  nextClusterId: number;
  /** Access order, oldest first — restoring in order preserves the eviction tie-break. */
  clusters: DrainCluster[];
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
  /** Access order, oldest first: re-inserted on every access, and the tie-break for eviction. */
  private readonly recency = new Map<number, DrainCluster>();
  private nextClusterId = 1;

  constructor(options: DrainTreeOptions = {}) {
    this.depth = options.depth ?? 4;
    this.simTh = options.simTh ?? 0.55;
    this.maxChildren = options.maxChildren ?? 100;
    this.maxClusters = options.maxClusters ?? 5000;
  }

  get clusterCount(): number {
    return this.recency.size;
  }

  /**
   * True once the capacity cap is reached, i.e. every further new cluster
   * evicts an existing one. Past this point clustering is no longer a pure
   * function of the blob multiset — a shape whose cluster was evicted and then
   * recurs mints a fresh cluster — so the eval reports it as the bound on what
   * "incremental equals all-at-once" can mean.
   */
  get atCapacity(): boolean {
    return this.recency.size >= this.maxClusters;
  }

  /** Capture the tree's clustering state for durable storage. */
  toSnapshot(): DrainTreeSnapshot {
    return {
      nextClusterId: this.nextClusterId,
      clusters: [...this.recency.values()].map((c) => ({ ...c, tokens: [...c.tokens] })),
    };
  }

  /**
   * Rebuild a tree from `toSnapshot()` output, re-linking each cluster into
   * its leaf without routing it through `insert()`.
   *
   * Going through `insert()` — what a warm start did before AW-89 — is lossy
   * twice over: two persisted templates similar enough to match would collapse
   * into one cluster, and every restored cluster would get a fresh id, so the
   * `clusterId -> templateId` map could not survive a restart.
   */
  static fromSnapshot(snapshot: DrainTreeSnapshot, options: DrainTreeOptions = {}): DrainTree {
    const tree = new DrainTree(options);
    tree.nextClusterId = snapshot.nextClusterId;
    for (const stored of snapshot.clusters) {
      const cluster: DrainCluster = {
        clusterId: stored.clusterId,
        tokens: [...stored.tokens],
        size: stored.size,
      };
      const leaf = tree.walkToLeaf(cluster.tokens);
      (leaf.clusters ??= []).push(cluster);
      tree.touch(cluster);
    }
    return tree;
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

  /**
   * The cluster to drop on overflow: the one with the fewest occurrences, ties
   * broken by least-recently-used.
   *
   * Recency alone (what this did before AW-92) evicts by arrival order, which
   * is the wrong axis twice over. A recurring shape that happens to be idle —
   * a `tsc` failure seen 200 times, absent for one busy stretch — gets dropped
   * and then re-minted from scratch on its next occurrence, losing its learned
   * wildcards and its `clusterId -> templateId` binding, so the template count
   * climbs instead of settling. And which cluster is idle at the moment of
   * overflow depends on the order blobs arrived in, so two runs over the same
   * blob multiset in different orders diverge.
   *
   * Support is a property of the data rather than of arrival order, so evicting
   * by it keeps the recurring patterns Drain exists to recognize and spends the
   * cap on the one-off long tail (on the real corpus, 1936 of 2408 clusters are
   * singletons). It does not make eviction order-*independent* — nothing does,
   * Drain is an online algorithm — but it bounds the churn to shapes seen once.
   *
   * Iteration is in LRU order and short-circuits on the first singleton, which
   * is the common case, so this is O(1) amortized rather than a full scan.
   */
  private selectVictim(): DrainCluster | undefined {
    let victim: DrainCluster | undefined;
    for (const cluster of this.recency.values()) {
      if (cluster.size === 1) return cluster;
      if (!victim || cluster.size < victim.size) victim = cluster;
    }
    return victim;
  }

  private evictIfOverCapacity(): void {
    if (this.recency.size <= this.maxClusters) return;
    const victim = this.selectVictim();
    if (!victim) return;
    this.recency.delete(victim.clusterId);

    const leaf = this.walkToLeaf(victim.tokens);
    if (!leaf.clusters) return;
    leaf.clusters = leaf.clusters.filter((c) => c.clusterId !== victim.clusterId);
  }
}
