import { promises as fs } from 'node:fs';
import matter from 'gray-matter';
import YAML from 'yaml';
import { NoteFrontmatterSchema } from '../schemas/note.js';
import { TaskSchema } from '../schemas/task.js';
import { SessionFrontmatterSchema } from '../schemas/session.js';
import { BriefFrontmatterSchema } from '../schemas/brief.js';
import { coerceDates } from '../utils/coerce-dates.js';
import { initiativeRef, noteRef, sessionRef, sourceRef, taskRef } from './refs.js';
import type { WorkspaceFile } from './scan.js';
import { bodyByteOffset, locate, sectionSpans, type IndexedSpan } from './spans.js';

/**
 * One file in, one record out. The shapes come from `src/schemas/`; nothing
 * here restates them, so a schema change is felt here as a type error rather
 * than as an index that quietly disagrees with the store.
 *
 * A file that will not parse throws, and the pass records it as malformed
 * rather than skipping it in silence — the same rule `loadNotesFromDir`
 * follows, for the same reason.
 */

export interface WorkspaceRecord {
  file: WorkspaceFile;
  ref: string;
  /** Column values for the class's table, minus `path` and the ref. */
  row: Record<string, string | number | null>;
  spans: IndexedSpan[];
  /** Notes only: what `shares_tag` groups on and what `mentions` is scanned for. */
  tags: string[];
  body: string;
}

const READERS = {
  initiative: readInitiative,
  note: readNote,
  task: readTask,
  session: readSession,
  source: readSource,
} as const;

export async function readRecord(file: WorkspaceFile): Promise<WorkspaceRecord> {
  const raw = await fs.readFile(file.absolutePath, 'utf8');
  return READERS[file.class](file, raw);
}

function frontmatter(raw: string): { data: unknown; body: string } {
  const parsed = matter(raw);
  return { data: coerceDates(parsed.data), body: parsed.content };
}

function jsonTags(tags: string[]): string | null {
  return tags.length === 0 ? null : JSON.stringify(tags);
}

function readInitiative(file: WorkspaceFile, raw: string): WorkspaceRecord {
  const { data, body } = frontmatter(raw);
  const brief = BriefFrontmatterSchema.parse(data);
  const lead = firstProse(body);
  return {
    file,
    ref: initiativeRef(file.slug),
    row: {
      slug: file.slug,
      title: brief.title,
      state: brief.state,
      rank: brief.rank ?? null,
      ship_target: brief.ship_target ?? null,
      owner: brief.owner ?? null,
      task_prefix: brief.task_prefix,
      updated: brief.updated,
    },
    spans: compact([
      locate(raw, 'title', brief.title),
      lead === undefined ? null : locate(raw, 'body', lead),
    ]),
    tags: [],
    body: '',
  };
}

function readNote(file: WorkspaceFile, raw: string): WorkspaceRecord {
  const { data, body } = frontmatter(raw);
  const note = NoteFrontmatterSchema.parse(data);
  const tags = note.tags ?? [];
  return {
    file,
    ref: noteRef(`${file.slug}/${basename(file.path)}`),
    row: {
      initiative: file.slug,
      filename: basename(file.path),
      kind: note.kind,
      title: note.title,
      created: note.created,
      tags: jsonTags(tags),
      // `hits` and `promoted_at` are the promotion machinery of the design's
      // §4 and the one thing here not derivable from the files, so a rebuild
      // resets them to zero. Owner accepted that on 2026-09-10.
      hits: 0,
      promoted_at: null,
    },
    spans: [
      ...compact([locate(raw, 'title', note.title)]),
      ...sectionSpans(body, bodyByteOffset(raw)),
    ],
    tags,
    body,
  };
}

function readTask(file: WorkspaceFile, raw: string): WorkspaceRecord {
  const task = TaskSchema.parse(coerceDates(YAML.parse(raw)));
  return {
    file,
    ref: taskRef(task.id),
    row: {
      initiative: file.slug,
      task_id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      severity: task.severity ?? null,
      estimate: task.estimate ?? null,
      tags: jsonTags(task.tags ?? []),
      created: task.created,
      updated: task.updated,
      done_at: task.done_at,
    },
    spans: compact([
      locate(raw, 'title', task.title),
      task.done_when !== undefined && locate(raw, 'done_when', task.done_when),
      task.notes !== undefined && locate(raw, 'notes', task.notes),
    ]),
    tags: [],
    body: '',
  };
}

function readSession(file: WorkspaceFile, raw: string): WorkspaceRecord {
  const { data, body } = frontmatter(raw);
  const session = SessionFrontmatterSchema.parse(data);
  return {
    file,
    ref: sessionRef(session.session_id),
    row: {
      initiative: file.slug,
      session_id: session.session_id,
      started: session.started,
      ended: session.ended,
      track: session.track,
      parent_session_id: session.parent_session_id ?? null,
    },
    spans: sectionSpans(body, bodyByteOffset(raw)),
    tags: [],
    body: '',
  };
}

/**
 * A markdown source is indexed title *and* body. §5 of the spec lists only the
 * title, deferring text to TP-29 — but TP-29 is about extracting text from
 * non-markdown, and §6 sizes the class at roughly twenty spans per source,
 * which is body content. The design documents this initiative runs on are
 * sources; leaving their prose out would make `search` miss them.
 */
function readSource(file: WorkspaceFile, raw: string): WorkspaceRecord {
  const title = firstHeading(raw) ?? basename(file.path).replace(/\.md$/, '');
  return {
    file,
    ref: sourceRef(`${file.slug}/${sourcesRelative(file.path)}`),
    row: {
      initiative: file.slug,
      title,
      kind: inferSourceKind(basename(file.path)),
      added: null,
    },
    spans: [...compact([locate(raw, 'title', title)]), ...sectionSpans(raw, 0)],
    tags: [],
    body: '',
  };
}

const PR_FILENAME = /^pr-\d+-/;
const DEEPDIVE_FILENAME = /^deepdive-/;
const SESSION_FILENAME = /^\d{4}-\d{2}-\d{2}-/;

/** The same four names `listSources` infers, so the index and `source list` agree. */
function inferSourceKind(filename: string): string {
  if (PR_FILENAME.test(filename)) return 'pr';
  if (DEEPDIVE_FILENAME.test(filename)) return 'deepdive';
  if (SESSION_FILENAME.test(filename)) return 'session';
  return 'pointer';
}

function basename(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1);
}

/** `<slug>/sources/a/b.md` -> `a/b.md`, so the ref survives TP-29's nesting. */
function sourcesRelative(relativePath: string): string {
  return relativePath.replace(/^[^/]+\/sources\//, '');
}

function firstHeading(text: string): string | undefined {
  for (const line of text.split('\n', 200)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** The brief's first prose paragraph — the first block that is neither a heading nor blank. */
function firstProse(body: string): string | undefined {
  for (const block of body.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (trimmed.length > 0 && !trimmed.startsWith('#')) return trimmed;
  }
  return undefined;
}

function compact(spans: (IndexedSpan | null | undefined | false)[]): IndexedSpan[] {
  return spans.filter((span): span is IndexedSpan => Boolean(span));
}
