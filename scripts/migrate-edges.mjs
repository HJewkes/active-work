#!/usr/bin/env node
// One-time edge tag-to-field migration (TP-2006). Reads every task under an active root and
// emits a `task apply` JSONL plan, one line per edge:
//   epic:X / parent:X on A  -> set_parent X on A
//   dep:X / blocked-by:X on A -> add_dep X on A
//   blocks:X on A           -> add_dep A on X
// It writes no task. A tag that names no task, an id filed in two initiatives, a parent in
// another initiative or a task with two parents goes to the unresolved list, never guessed.
// The old tags stay; the apply checks every line against the edge graph.
//
//   node scripts/migrate-edges.mjs --root <active root> --out <plan.jsonl> [--unresolved <file.md>]
//
// --root defaults to $ACTIVE_ROOT; there is no other default, so it never reads a root by accident.
// The counts go to stdout as JSON.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { TaskSchema } from '@titan-design/pm';

const PARENT_PREFIXES = ['epic:', 'parent:'];
const DEP_PREFIXES = ['dep:', 'blocked-by:'];
const BLOCKS_PREFIX = 'blocks:';

const isTaskId = (value) => TaskSchema.shape.id.safeParse(value).success;

function tagRefs(tags, prefixes) {
  return tags.flatMap((tag) => {
    const prefix = prefixes.find((p) => tag.startsWith(p));
    return prefix === undefined ? [] : [{ tag, ref: tag.slice(prefix.length) }];
  });
}

function homesOf(bySlug) {
  const homes = new Map();
  for (const [slug, tasks] of bySlug) {
    for (const task of tasks) homes.set(task.id, [...(homes.get(task.id) ?? []), slug]);
  }
  return homes;
}

/** The one initiative a ref is filed in, or the reason it cannot be resolved. */
function resolve(homes, ref) {
  if (!isTaskId(ref)) return { reason: 'not-a-task-id' };
  const slugs = homes.get(ref) ?? [];
  if (slugs.length === 0) return { reason: 'unknown-id' };
  if (slugs.length > 1) return { reason: 'ambiguous-id', detail: slugs.join(', ') };
  return { slug: slugs[0] };
}

class Planner {
  constructor(bySlug) {
    this.homes = homesOf(bySlug);
    this.tasks = new Map(
      [...bySlug].map(([slug, ts]) => [slug, new Map(ts.map((t) => [t.id, t]))]),
    );
    this.lines = new Map();
    this.unresolved = [];
    this.already = { set_parent: 0, add_dep: 0 };
    this.sources = { parent: 0, dep: 0, blocks: 0 };
  }

  reject(slug, id, tag, reason, detail) {
    this.unresolved.push({ slug, id, tag, reason, ...(detail === undefined ? {} : { detail }) });
  }

  emit(slug, id, op, value, source) {
    const key = `${slug}\u0000${id}\u0000${op}\u0000${value}`;
    if (this.lines.has(key)) return;
    const task = this.tasks.get(slug).get(id);
    const present = op === 'set_parent' ? task.parent === value : (task.dep ?? []).includes(value);
    if (present) {
      this.already[op] += 1;
      return;
    }
    this.lines.set(key, { slug, id, ops: [{ [op]: value }] });
    this.sources[source] += 1;
  }

  planParent(slug, task) {
    const targets = new Map();
    if (task.parent !== undefined) targets.set(task.parent, 'parent field');
    for (const { tag, ref } of tagRefs(task.tags ?? [], PARENT_PREFIXES)) {
      const found = resolve(this.homes, ref);
      if (found.reason !== undefined) this.reject(slug, task.id, tag, found.reason, found.detail);
      else if (ref === task.id) this.reject(slug, task.id, tag, 'self-reference');
      else if (found.slug !== slug)
        this.reject(slug, task.id, tag, 'parent-in-other-initiative', found.slug);
      else if (!targets.has(ref)) targets.set(ref, tag);
    }
    if (targets.size > 1) {
      this.reject(slug, task.id, [...targets.values()].join(', '), 'two-parents');
      return;
    }
    const [target] = targets.keys();
    if (target !== undefined) this.emit(slug, task.id, 'set_parent', target, 'parent');
  }

  planDeps(slug, task) {
    for (const { tag, ref } of tagRefs(task.tags ?? [], DEP_PREFIXES)) {
      const found = resolve(this.homes, ref);
      if (found.reason !== undefined) this.reject(slug, task.id, tag, found.reason, found.detail);
      else if (ref === task.id) this.reject(slug, task.id, tag, 'self-reference');
      else this.emit(slug, task.id, 'add_dep', ref, 'dep');
    }
  }

  planBlocks(slug, task) {
    for (const { tag, ref } of tagRefs(task.tags ?? [], [BLOCKS_PREFIX])) {
      const blocked = resolve(this.homes, ref);
      const self = resolve(this.homes, task.id);
      if (blocked.reason !== undefined)
        this.reject(slug, task.id, tag, blocked.reason, blocked.detail);
      else if (self.reason !== undefined) this.reject(slug, task.id, tag, self.reason, self.detail);
      else if (ref === task.id) this.reject(slug, task.id, tag, 'self-reference');
      else this.emit(blocked.slug, ref, 'add_dep', task.id, 'blocks');
    }
  }

  run() {
    for (const [slug, tasks] of this.tasks) {
      for (const task of tasks.values()) {
        this.planParent(slug, task);
        this.planDeps(slug, task);
        this.planBlocks(slug, task);
      }
    }
    return this.result();
  }

  result() {
    const lines = [...this.lines.values()];
    const touched = new Set(lines.map((line) => `${line.slug}/${line.id}`));
    const reasons = {};
    for (const { reason } of this.unresolved) reasons[reason] = (reasons[reason] ?? 0) + 1;
    const counts = {
      edges: { ...this.sources, total: lines.length },
      already_fields: this.already,
      unresolved: { ...reasons, total: this.unresolved.length },
      tasks_touched: touched.size,
    };
    return { lines, unresolved: this.unresolved, counts };
  }
}

/** Pure: plans the migration over tasks grouped by initiative slug. */
export function planEdgeMigration(bySlug) {
  return new Planner(bySlug).run();
}

export function renderUnresolved(unresolved) {
  const header = [
    '# Edge tag migration: unresolved tags',
    '',
    'Each row is a tag the migration did not turn into a field. The tag stays; fix it by hand.',
    '',
    '| initiative | task | tag | reason | detail |',
    '|---|---|---|---|---|',
  ];
  const rows = unresolved.map(
    (u) =>
      `| ${u.slug} | ${u.id} | ${u.tag.replaceAll('|', '\\|')} | ${u.reason} | ${u.detail ?? ''} |`,
  );
  return [...header, ...rows].join('\n') + '\n';
}

async function readSlugTasks(root, slug, unreadable) {
  const dir = path.join(root, slug, 'tasks');
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.yml')).sort();
  const tasks = [];
  for (const file of files) {
    const parsed = TaskSchema.safeParse(
      YAML.parse(await fs.readFile(path.join(dir, file), 'utf8')),
    );
    if (parsed.success) tasks.push(parsed.data);
    else unreadable.push(`${slug}/${file}`);
  }
  return tasks;
}

export async function readRoot(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const slugs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
  const bySlug = new Map();
  const unreadable = [];
  for (const slug of slugs.sort()) bySlug.set(slug, await readSlugTasks(root, slug, unreadable));
  return { bySlug, unreadable };
}

async function main() {
  const { values } = parseArgs({
    options: { root: { type: 'string' }, out: { type: 'string' }, unresolved: { type: 'string' } },
  });
  const root = values.root ?? process.env.ACTIVE_ROOT;
  if (!root || !values.out) {
    process.stderr.write(
      'Usage: migrate-edges.mjs --root <active root> --out <plan.jsonl> [--unresolved <file.md>]\n',
    );
    process.exit(2);
  }
  const { bySlug, unreadable } = await readRoot(root);
  const { lines, unresolved, counts } = planEdgeMigration(bySlug);
  await fs.writeFile(values.out, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  if (values.unresolved !== undefined)
    await fs.writeFile(values.unresolved, renderUnresolved(unresolved));
  process.stdout.write(
    `${JSON.stringify({ ...counts, unreadable_task_files: unreadable }, null, 2)}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
