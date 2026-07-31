import { DrainTree, type DrainTreeOptions, type DrainTreeSnapshot } from './drain/tree.js';

/**
 * The Drain-tree partitions (§C1): route by tool name *before* Drain sees a
 * line, so a `tsc` failure and a `vitest` failure never end up in the same
 * cluster just because their token shapes happen to overlap.
 */
export type ToolType = 'Bash' | 'Read' | 'Edit' | 'generic';

const KNOWN_TOOL_TYPES: Record<string, ToolType> = {
  Bash: 'Bash',
  Read: 'Read',
  Edit: 'Edit',
  MultiEdit: 'Edit',
};

/** Map a Claude Code tool_use name to its Drain-tree partition. */
export function toolTypeFor(toolName: string): ToolType {
  return KNOWN_TOOL_TYPES[toolName] ?? 'generic';
}

/**
 * Lazily-created, per-`ToolType` `DrainTree` instances, so each tool type
 * gets its own independent tree (and its own mask config, matched by the
 * same `toolType` string in `src/miner/masks.ts`).
 */
export class DrainTreeRegistry {
  private readonly trees = new Map<string, DrainTree>();

  constructor(private readonly options?: DrainTreeOptions) {}

  getTree(toolType: string): DrainTree {
    let tree = this.trees.get(toolType);
    if (!tree) {
      tree = new DrainTree(this.options);
      this.trees.set(toolType, tree);
    }
    return tree;
  }

  /** Install a tree rebuilt from a snapshot, replacing any tree for `toolType`. */
  restore(toolType: string, snapshot: DrainTreeSnapshot): void {
    this.trees.set(toolType, DrainTree.fromSnapshot(snapshot, this.options));
  }

  snapshot(): Record<string, DrainTreeSnapshot> {
    return Object.fromEntries([...this.trees].map(([type, tree]) => [type, tree.toSnapshot()]));
  }

  /** True when any partition has hit its LRU cap and is evicting clusters. */
  get anyAtCapacity(): boolean {
    return [...this.trees.values()].some((tree) => tree.atCapacity);
  }

  get partitionedToolTypes(): string[] {
    return [...this.trees.keys()];
  }
}
