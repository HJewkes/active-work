/**
 * Deterministic ID-join lookup across an active root (AW-85).
 *
 * The data model cross-references by ID — task ids (`AW-12`), loop refs
 * (`<session file stem>#<next_step id>`), and artifact branch/worktree names
 * that embed a task id. Tracing those links used to mean hand-rolled grep.
 *
 * This command is *exact-join only*: every match is a literal, token-bounded
 * occurrence of the queried id. Topic/paraphrase similarity ("related sources
 * by topic") is deliberately NOT here — it is a separate, fuzzy concern and
 * bundling it would make these results non-deterministic.
 */
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { TaskSchema } from '../schemas/task.js';
import { SessionFrontmatterSchema } from '../schemas/session.js';
import { ArtifactsSchema, type Artifacts } from '../schemas/artifacts.js';
import { getActiveRoot, getInitiativeDir } from '../utils/paths.js';
import { readYaml } from '../utils/yaml-io.js';
import { readFrontmatter } from '../utils/gray-matter-io.js';

const TASK_ID_REGEX = /^[A-Z][A-Z0-9]*-\d+$/;
const MAX_SNIPPET = 160;

const ArgsSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1).optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const ReferenceSchema = z.object({
  slug: z.string(),
  source: z.enum(['task', 'session', 'artifacts']),
  /** Path relative to the initiative directory. */
  file: z.string(),
  /** Dotted/indexed path of the field that carried the match. */
  field: z.string(),
  text: z.string(),
});

const SubjectSchema = z.object({
  kind: z.enum(['task', 'session', 'loop']),
  slug: z.string(),
  file: z.string(),
  title: z.string(),
});

const ResultSchema = z.object({
  id: z.string(),
  kind: z.enum(['task', 'session', 'loop']),
  subject: SubjectSchema.nullable(),
  references: z.array(ReferenceSchema),
  initiatives_scanned: z.array(z.string()),
  errors: z.array(z.object({ file: z.string(), error: z.string() })),
});

type Reference = z.infer<typeof ReferenceSchema>;
type Subject = z.infer<typeof SubjectSchema>;
type Result = z.infer<typeof ResultSchema>;

/** Accumulates one initiative's worth of findings. */
interface Scan {
  references: Reference[];
  errors: { file: string; error: string }[];
  subject: Subject | null;
}

/**
 * Classify the query lexically. `#` is the loop-ref separator and is banned
 * from both halves of a ref, so its presence is unambiguous.
 */
function classify(id: string): 'task' | 'loop' | 'session' {
  if (id.includes('#')) return 'loop';
  if (TASK_ID_REGEX.test(id)) return 'task';
  return 'session';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Token-bounded, case-insensitive matcher. Case-insensitive because task ids
 * appear lowercased inside branch names (`feat/aw-85-context-graph`); the
 * alphanumeric guards keep `AW-8` from matching `AW-85`.
 */
function buildMatcher(id: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegex(id)}(?![A-Za-z0-9])`, 'i');
}

function snippet(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_SNIPPET ? `${trimmed.slice(0, MAX_SNIPPET)}…` : trimmed;
}

async function listSlugs(): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(getActiveRoot(), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((e) => e.endsWith(ext)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Emit a reference for every free-text field that literally contains the id. */
function matchFields(
  match: RegExp,
  base: Omit<Reference, 'field' | 'text'>,
  fields: [field: string, value: string | undefined][],
): Reference[] {
  const out: Reference[] = [];
  for (const [field, value] of fields) {
    if (value && match.test(value)) {
      out.push({ ...base, field, text: snippet(value) });
    }
  }
  return out;
}

async function scanTasks(slug: string, id: string, match: RegExp, scan: Scan) {
  const dir = path.join(getInitiativeDir(slug), 'tasks');
  for (const file of await listFiles(dir, '.yml')) {
    const rel = path.join('tasks', file);
    try {
      const task = await readYaml(path.join(dir, file), TaskSchema);
      if (task.id === id) {
        scan.subject = { kind: 'task', slug, file: rel, title: task.title };
        continue;
      }
      const base = { slug, source: 'task' as const, file: rel };
      scan.references.push(
        ...matchFields(match, base, [
          ['title', task.title],
          ['done_when', task.done_when],
          ['notes', task.notes],
          ['tags', (task.tags ?? []).join(', ')],
        ]),
      );
    } catch (err) {
      scan.errors.push({ file: rel, error: errorText(err) });
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Body matches are reported per line so the caller gets a locatable hit. */
function matchBody(
  match: RegExp,
  base: Omit<Reference, 'field' | 'text'>,
  body: string,
): Reference[] {
  const out: Reference[] = [];
  body.split(/\r?\n/).forEach((line, index) => {
    if (match.test(line)) {
      out.push({ ...base, field: `body:L${index + 1}`, text: snippet(line) });
    }
  });
  return out;
}

interface SessionScanInput {
  slug: string;
  stem: string;
  rel: string;
  id: string;
  match: RegExp;
  frontmatter: z.infer<typeof SessionFrontmatterSchema>;
  body: string;
}

/**
 * The loop a `<stem>#<step id>` query names is the *subject*, not a reference
 * to itself — everything else in the same file is still fair game.
 */
function scanSessionFile(input: SessionScanInput, scan: Scan): void {
  const { slug, stem, rel, id, match, frontmatter, body } = input;
  const base = { slug, source: 'session' as const, file: rel };

  if (id === stem || id === frontmatter.session_id) {
    scan.subject = { kind: 'session', slug, file: rel, title: stem };
  }

  frontmatter.next_steps.forEach((step, i) => {
    if (`${stem}#${step.id}` === id) {
      scan.subject = { kind: 'loop', slug, file: rel, title: step.text };
      return;
    }
    scan.references.push(
      ...matchFields(match, base, [
        [`next_steps[${i}].ref`, step.ref],
        [`next_steps[${i}].text`, step.text],
      ]),
    );
  });

  frontmatter.resolves.forEach((entry, i) => {
    scan.references.push(
      ...matchFields(match, base, [
        [`resolves[${i}].ref`, entry.ref],
        [`resolves[${i}].note`, entry.note],
      ]),
    );
  });

  scan.references.push(...matchBody(match, base, body));
}

async function scanSessions(slug: string, id: string, match: RegExp, scan: Scan) {
  const dir = path.join(getInitiativeDir(slug), 'sessions');
  for (const file of await listFiles(dir, '.md')) {
    const rel = path.join('sessions', file);
    try {
      const { frontmatter, body } = await readFrontmatter(
        path.join(dir, file),
        SessionFrontmatterSchema,
      );
      const stem = file.slice(0, -'.md'.length);
      scanSessionFile({ slug, stem, rel, id, match, frontmatter, body }, scan);
    } catch (err) {
      scan.errors.push({ file: rel, error: errorText(err) });
    }
  }
}

function artifactFields(artifacts: Artifacts): [field: string, value: string | undefined][] {
  const fields: [string, string | undefined][] = [];
  artifacts.branches.forEach((b, i) => {
    fields.push([`branches[${i}].name`, b.name], [`branches[${i}].note`, b.note]);
  });
  artifacts.stashes.forEach((s, i) => {
    fields.push([`stashes[${i}].label`, s.label]);
  });
  artifacts.worktrees.forEach((w, i) => {
    fields.push(
      [`worktrees[${i}].branch`, w.branch],
      [`worktrees[${i}].holding`, w.holding],
      [`worktrees[${i}].note`, w.note],
    );
  });
  return fields;
}

async function scanArtifacts(slug: string, match: RegExp, scan: Scan) {
  const rel = 'artifacts.yml';
  const file = path.join(getInitiativeDir(slug), rel);
  try {
    await fs.access(file);
  } catch {
    return;
  }
  try {
    const artifacts = await readYaml(file, ArtifactsSchema);
    const base = { slug, source: 'artifacts' as const, file: rel };
    scan.references.push(...matchFields(match, base, artifactFields(artifacts)));
  } catch (err) {
    scan.errors.push({ file: rel, error: errorText(err) });
  }
}

export default defineCommand<Args, Result>({
  name: 'context.graph',
  description:
    'Trace every exact-ID reference to a task id, session, or loop ref across tasks, sessions, and artifacts',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['id'],
    options: {
      slug: {
        long: '--slug',
        description: 'Limit the scan to one initiative (default: every initiative)',
      },
    },
    usage: 'context graph <id> [--slug SLUG]',
  },
  async run(args) {
    const match = buildMatcher(args.id);
    const slugs = args.slug ? [args.slug] : await listSlugs();

    const scan: Scan = { references: [], errors: [], subject: null };
    for (const slug of slugs) {
      await scanTasks(slug, args.id, match, scan);
      await scanSessions(slug, args.id, match, scan);
      await scanArtifacts(slug, match, scan);
    }

    return {
      id: args.id,
      kind: classify(args.id),
      subject: scan.subject,
      references: scan.references,
      initiatives_scanned: slugs,
      errors: scan.errors,
    };
  },
});
