import { loadHumanOnlyInitiatives } from '../decider/human-only.js';
import { UsageError } from '../errors.js';
import { listInitiativeSlugs } from '../lint/index.js';
import { getActiveRoot } from '../utils/paths.js';
import { validateSlug } from '../utils/slug.js';

interface ListScope {
  slug?: string;
  all_initiatives?: boolean;
}

export interface HumanOnlyPredicate {
  known: boolean;
  isHumanOnly: (slug: string) => boolean;
}

/** The initiatives a list command reads: one slug, or every one with `all_initiatives`. */
export async function resolveListSlugs(command: string, scope: ListScope): Promise<string[]> {
  if (scope.all_initiatives && scope.slug) {
    throw new UsageError(`${command} takes a slug or --all-initiatives, not both`);
  }
  if (scope.all_initiatives) return listInitiativeSlugs(getActiveRoot());
  if (!scope.slug) throw new UsageError(`${command} requires a slug or --all-initiatives`);
  const slugCheck = validateSlug(scope.slug);
  if (!slugCheck.ok) throw new UsageError(`Invalid slug '${scope.slug}': ${slugCheck.error}`);
  return [scope.slug];
}

/** Fails closed: an unreadable charter flags every initiative, so nothing personal leaks into an export. */
export async function humanOnlyPredicate(
  activeRoot: string,
  warnings: string[],
): Promise<HumanOnlyPredicate> {
  try {
    const humanOnly = await loadHumanOnlyInitiatives(activeRoot);
    return { known: true, isHumanOnly: (slug) => humanOnly.has(slug) };
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
    return { known: false, isHumanOnly: () => true };
  }
}
