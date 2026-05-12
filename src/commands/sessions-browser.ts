import { promises as fs, createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { z } from 'zod';
import { getActiveRoot, expandTilde } from '../utils/paths.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  limit: z.number().int().positive().optional(),
  include_active: z.boolean().optional(),
});

const SessionEntrySchema = z.object({
  session_id: z.string(),
  cwd: z.string(),
  ended: z.string(),
  summary: z.string(),
});

const ResultSchema = z.object({
  sessions: z.array(SessionEntrySchema),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;
type SessionEntry = z.infer<typeof SessionEntrySchema>;

const DEFAULT_LIMIT = 50;
const SUMMARY_MAX = 150;
const CONTINUATION_MARKER = 'This session is being continued from a previous conversation';

function claudeProjectsRoot(): string {
  const override = process.env.CLAUDE_PROJECTS_ROOT;
  if (override && override.length > 0) {
    return path.resolve(expandTilde(override));
  }
  return path.join(os.homedir(), '.claude', 'projects');
}

interface ScannedSession {
  sessionId: string;
  cwd: string;
  mtimeMs: number;
  filePath: string;
}

/**
 * Walk the projects root looking for `*.jsonl` session files. Each
 * subdirectory under projects root holds sessions for one safe-encoded
 * working directory.
 */
async function listJsonlFiles(root: string): Promise<string[]> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(root, { withFileTypes: true }).then((entries) =>
      entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)),
    );
  } catch {
    return [];
  }
  const all: string[] = [];
  for (const dir of projectDirs) {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) {
        all.push(path.join(dir, f));
      }
    }
  }
  return all;
}

/**
 * Read the first line containing a `"cwd"` field without slurping the
 * whole file. Returns `null` when no such line is found.
 */
async function lightScanCwd(filePath: string): Promise<string | null> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"cwd"')) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const cwd = parsed.cwd;
        if (typeof cwd === 'string' && cwd.length > 0) {
          return cwd;
        }
      } catch {
        // ignore malformed line; keep scanning
      }
    }
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function scanSession(filePath: string): Promise<ScannedSession | null> {
  const cwd = await lightScanCwd(filePath);
  if (!cwd) return null;
  const stat = await fs.stat(filePath);
  const sessionId = path.basename(filePath, '.jsonl');
  return { sessionId, cwd, mtimeMs: stat.mtimeMs, filePath };
}

async function listActiveInitiativeRoots(): Promise<string[]> {
  const activeRoot = getActiveRoot();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(activeRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(activeRoot, e.name));
}

function isPathPrefix(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (p === c) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

function extractFirstUserText(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type !== 'user') return null;
    const message = parsed.message as Record<string, unknown> | undefined;
    if (!message) return null;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (
          part &&
          typeof part === 'object' &&
          'text' in part &&
          typeof (part as { text: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

/**
 * Stream the jsonl file to extract a summary: prefer the most recent
 * compaction-continuation marker, otherwise fall back to the first
 * user message text.
 */
async function extractSummary(filePath: string): Promise<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let latestContinuation: string | null = null;
  let firstUser: string | null = null;
  try {
    for await (const line of rl) {
      if (line.includes(CONTINUATION_MARKER)) {
        const text = extractFirstUserText(line);
        if (text) latestContinuation = text;
      } else if (firstUser === null) {
        const text = extractFirstUserText(line);
        if (text) firstUser = text;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  const raw = latestContinuation ?? firstUser ?? '';
  return truncate(raw, SUMMARY_MAX);
}

export async function runSessions(args: Args): Promise<Result> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const includeActive = args.include_active ?? false;

  const root = claudeProjectsRoot();
  const files = await listJsonlFiles(root);

  const scanned: ScannedSession[] = [];
  for (const f of files) {
    try {
      const entry = await scanSession(f);
      if (entry) scanned.push(entry);
    } catch {
      // ignore unreadable files
    }
  }

  let filtered = scanned;
  if (!includeActive) {
    const activeRoots = await listActiveInitiativeRoots();
    if (activeRoots.length > 0) {
      filtered = scanned.filter(
        (s) => !activeRoots.some((root) => isPathPrefix(root, s.cwd)),
      );
    }
  }

  filtered.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = filtered.slice(0, limit);

  const sessions: SessionEntry[] = [];
  for (const entry of top) {
    const summary = await extractSummary(entry.filePath);
    sessions.push({
      session_id: entry.sessionId,
      cwd: entry.cwd,
      ended: new Date(entry.mtimeMs).toISOString(),
      summary,
    });
  }

  return { sessions };
}

const sessions = defineCommand<Args, Result>({
  name: 'sessions',
  description: 'Browse recent Claude sessions discovered under ~/.claude/projects.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      limit: { long: '--limit', description: 'Max sessions to return (default 50).' },
      include_active: {
        long: '--include-active',
        description: 'Include sessions whose cwd lives under an active initiative.',
      },
    },
    usage: 'aw sessions [--limit N] [--include-active]',
  },
  async run(args) {
    return runSessions(args);
  },
});

export default sessions;
