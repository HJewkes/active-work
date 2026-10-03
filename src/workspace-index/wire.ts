import { promises as fs } from 'node:fs';
import type { InventoryClass } from './inventory.js';

/**
 * Record class names as they appear on the wire: plural, matching `search`'s
 * `hit.class` (`classOf` in `search/classes.ts`). Internal `WorkspaceClass`
 * values stay singular because they mirror the `note:` / `task:` ref prefixes.
 */
export const WIRE_CLASSES = [
  'initiatives',
  'tasks',
  'sessions',
  'notes',
  'sources',
  'nested_sources',
] as const;

export type WireClass = (typeof WIRE_CLASSES)[number];

const TO_WIRE: Record<InventoryClass, WireClass> = {
  initiative: 'initiatives',
  task: 'tasks',
  session: 'sessions',
  note: 'notes',
  source: 'sources',
  nested_source: 'nested_sources',
};

export function wireClass(cls: InventoryClass): WireClass {
  return TO_WIRE[cls];
}

/**
 * A list item's stable id, `<slug>:<class>:<filename>`. Filenames repeat
 * across initiatives, so the slug is part of it; a nested source's filename
 * is its path under `sources/`, and it shares the `sources` class.
 */
export function itemId(slug: string, cls: 'notes' | 'sources', filename: string): string {
  return `${slug}:${cls}:${filename}`;
}

/** A file's mtime as an ISO timestamp, or null when it vanished before the stat. */
export async function mtimeOf(file: string): Promise<string | null> {
  try {
    return (await fs.stat(file)).mtime.toISOString();
  } catch {
    return null;
  }
}
