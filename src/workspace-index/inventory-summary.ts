import type { InventoryClass, InventoryFile } from './inventory.js';

/** File count, total bytes and newest mtime over a set of files. */
export interface InventoryStat {
  files: number;
  bytes: number;
  newest_mtime: string | null;
}

export interface NestedDirStat extends InventoryStat {
  /** The top-level `sources/` subdirectory, relative to the initiative. */
  dir: string;
}

export interface InitiativeInventory {
  slug: string;
  /** Listed in the charter's `human_only_initiatives`: keep out of fixtures and exports. */
  human_only: boolean;
  total: InventoryStat;
  classes: Record<InventoryClass, InventoryStat>;
  nested_dirs: NestedDirStat[];
}

export const INVENTORY_CLASSES: readonly InventoryClass[] = [
  'initiative',
  'task',
  'session',
  'note',
  'source',
  'nested_source',
];

function emptyStat(): InventoryStat {
  return { files: 0, bytes: 0, newest_mtime: null };
}

function addFile(stat: InventoryStat, file: InventoryFile): void {
  stat.files += 1;
  stat.bytes += file.size;
  if (stat.newest_mtime === null || file.mtime > stat.newest_mtime) stat.newest_mtime = file.mtime;
}

function emptyClasses(): Record<InventoryClass, InventoryStat> {
  return Object.fromEntries(INVENTORY_CLASSES.map((cls) => [cls, emptyStat()])) as Record<
    InventoryClass,
    InventoryStat
  >;
}

/** `<slug>/sources/<dir>/...` names its nested dir at segment 2. */
function nestedDirOf(file: InventoryFile): string {
  return `sources/${file.path.split('/')[2]}`;
}

function summarizeNestedDirs(files: InventoryFile[]): NestedDirStat[] {
  const byDir = new Map<string, NestedDirStat>();
  for (const file of files) {
    if (file.class !== 'nested_source') continue;
    const dir = nestedDirOf(file);
    const stat = byDir.get(dir) ?? { dir, ...emptyStat() };
    addFile(stat, file);
    byDir.set(dir, stat);
  }
  return [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

function summarizeInitiative(
  slug: string,
  files: InventoryFile[],
  humanOnly: (slug: string) => boolean,
): InitiativeInventory {
  const total = emptyStat();
  const classes = emptyClasses();
  for (const file of files) {
    addFile(total, file);
    addFile(classes[file.class], file);
  }
  return {
    slug,
    human_only: humanOnly(slug),
    total,
    classes,
    nested_dirs: summarizeNestedDirs(files),
  };
}

/** One row per initiative slug, including initiatives that hold no files yet. */
export function summarizeInventory(
  slugs: readonly string[],
  files: readonly InventoryFile[],
  humanOnly: (slug: string) => boolean,
): InitiativeInventory[] {
  const bySlug = new Map<string, InventoryFile[]>(slugs.map((slug) => [slug, []]));
  for (const file of files) bySlug.get(file.slug)?.push(file);
  return [...bySlug.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slug, owned]) => summarizeInitiative(slug, owned, humanOnly));
}

function mergeStat(into: InventoryStat, from: InventoryStat): void {
  into.files += from.files;
  into.bytes += from.bytes;
  const newest = from.newest_mtime;
  if (newest !== null && (into.newest_mtime === null || newest > into.newest_mtime)) {
    into.newest_mtime = newest;
  }
}

/** Sums across initiatives, per class and overall. */
export function totalInventory(rows: readonly InitiativeInventory[]): {
  total: InventoryStat;
  classes: Record<InventoryClass, InventoryStat>;
} {
  const total = emptyStat();
  const classes = emptyClasses();
  for (const row of rows) {
    mergeStat(total, row.total);
    for (const cls of INVENTORY_CLASSES) mergeStat(classes[cls], row.classes[cls]);
  }
  return { total, classes };
}
