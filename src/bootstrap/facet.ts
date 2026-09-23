import type { Task } from '../schemas/task.js';
import type { OpenLoop } from '../sessions/open-loops.js';

/** The slice of a facet the bootstrap renders (TP-326). */
export interface BootstrapFacet {
  name: string;
  tags: string[];
  about?: string;
  body: string;
}

export interface FacetTaskSelection {
  tasks: Task[];
  hidden: number;
  /** True when no open task carries a facet tag, so the list is unfiltered. */
  fallback: boolean;
}

function carriesAnyTag(task: Task, tags: string[]): boolean {
  return (task.tags ?? []).some((tag) => tags.includes(tag));
}

export function selectFacetTasks(
  openTasks: Task[],
  tags: string[] | undefined,
): FacetTaskSelection {
  if (tags === undefined) return { tasks: openTasks, hidden: 0, fallback: false };
  const matched = openTasks.filter((task) => carriesAnyTag(task, tags));
  if (matched.length === 0) return { tasks: openTasks, hidden: 0, fallback: true };
  return { tasks: matched, hidden: openTasks.length - matched.length, fallback: false };
}

/**
 * Hide only a loop aimed at one of this initiative's tasks that carries no
 * facet tag; untargeted, PR and foreign-task loops stay visible.
 */
export function selectFacetLoops(
  loops: OpenLoop[],
  tasks: Task[],
  tags: string[] | undefined,
): { loops: OpenLoop[]; hidden: number } {
  if (tags === undefined) return { loops, hidden: 0 };
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const shown = loops.filter((loop) => {
    if (loop.kind !== 'task' || loop.targetRef === undefined) return true;
    const target = byId.get(loop.targetRef);
    return target === undefined || carriesAnyTag(target, tags);
  });
  return { loops: shown, hidden: loops.length - shown.length };
}

export function renderFacetSection(facet: BootstrapFacet): string {
  const tagList = facet.tags.join(', ');
  const scope = `_Tasks and loops below are filtered to the tags [${tagList}]._`;
  const body = facet.body || '_(no facet body)_';
  return `# Facet: ${facet.name}\n${body}\n\n${scope}`;
}

export function renderFacetTaskNote(
  selection: FacetTaskSelection,
  tags: string[],
  slug: string,
): string | null {
  if (selection.fallback) {
    return `_No open tasks carry the facet tags [${tags.join(', ')}]; showing all._`;
  }
  if (selection.hidden === 0) return null;
  return `(${selection.hidden} other open tasks outside this facet — \`active-work task list ${slug} --json\`)`;
}

export function renderHiddenLoopsNote(hidden: number, slug: string): string | null {
  if (hidden === 0) return null;
  return `(${hidden} other open loops outside this facet — \`active-work loops ${slug}\`)`;
}
