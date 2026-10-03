import { UsageError } from '../errors.js';
import { listInitiativeSlugs } from '../lint/index.js';
import { getActiveRoot } from '../utils/paths.js';

interface ListScope {
  slug?: string;
  all_initiatives?: boolean;
}

/** The initiatives a list command reads: one slug, or every one with `all_initiatives`. */
export async function resolveListSlugs(command: string, scope: ListScope): Promise<string[]> {
  if (scope.all_initiatives && scope.slug) {
    throw new UsageError(`${command} takes a slug or --all-initiatives, not both`);
  }
  if (scope.all_initiatives) return listInitiativeSlugs(getActiveRoot());
  if (!scope.slug) throw new UsageError(`${command} requires a slug or --all-initiatives`);
  return [scope.slug];
}
