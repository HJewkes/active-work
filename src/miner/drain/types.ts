/** The wildcard token a Drain template uses at a generalized position. */
export const WILDCARD = '<*>';

/** A single leaf cluster in the Drain tree: one template + its token count. */
export interface DrainCluster {
  clusterId: number;
  tokens: string[];
  size: number;
}

/** Result of inserting a tokenized line into a `DrainTree`. */
export interface MatchResult {
  cluster: DrainCluster;
  /** True when this insert created a brand-new cluster rather than joining one. */
  isNew: boolean;
  /** True when joining an existing cluster generalized one or more positions. */
  templateChanged: boolean;
}
