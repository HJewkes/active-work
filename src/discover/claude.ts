import { promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiscoveryHit, DiscoverySourceError } from './types.js';

/**
 * Scan `~/.claude/projects/` for recent session JSONLs and surface one hit
 * per unique `cwd`. Honors `CLAUDE_PROJECTS_ROOT` for test injection.
 *
 * We do a light scan of each session file — just enough to extract `cwd`,
 * a subject (first user message or last compaction summary), and an mtime.
 * We do NOT filter against claimed slugs here; that's the orchestrator's
 * cross-reference step.
 */

export interface DiscoverClaudeResult {
  hits: DiscoveryHit[];
  errors: DiscoverySourceError[];
}

interface CwdAggregate {
  cwd: string;
  sessionCount: number;
  lastMtimeMs: number;
  subject: string;
  lastSessionId: string;
}

const MAX_SCAN_LINES = 200;
const COMPACTION_SUBJECT_PREFIX = '[compaction] ';

export async function discoverClaudeSessions(): Promise<DiscoverClaudeResult> {
  const root =
    process.env.CLAUDE_PROJECTS_ROOT ?? path.join(os.homedir(), '.claude', 'projects');
  const hits: DiscoveryHit[] = [];
  const errors: DiscoverySourceError[] = [];

  let projectDirs: Dirent[];
  try {
    projectDirs = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    // No claude projects dir at all? That's not an error — return empty.
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { hits, errors };
    errors.push({ source: 'claude-session', error: e.message ?? String(err) });
    return { hits, errors };
  }

  const byCwd = new Map<string, CwdAggregate>();

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(root, dir.name);
    let files: Dirent[];
    try {
      files = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      errors.push({
        source: `claude-session:${dir.name}`,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, file.name);
      try {
        await aggregateSession(filePath, byCwd);
      } catch (err) {
        errors.push({
          source: `claude-session:${file.name}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  for (const agg of byCwd.values()) {
    hits.push({
      source: 'claude-session',
      ref: agg.cwd,
      detail: `${agg.sessionCount} session(s) at ${agg.cwd}${
        agg.subject ? ` — ${agg.subject}` : ''
      }`,
      metadata: {
        cwd: agg.cwd,
        sessionCount: agg.sessionCount,
        lastMtime: new Date(agg.lastMtimeMs).toISOString(),
        lastSessionId: agg.lastSessionId,
        subject: agg.subject,
      },
    });
  }

  return { hits, errors };
}

async function aggregateSession(
  filePath: string,
  byCwd: Map<string, CwdAggregate>,
): Promise<void> {
  const stat = await fs.stat(filePath);
  // Read up to MAX_SCAN_LINES; this is a light scan, not a parser.
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split('\n').slice(0, MAX_SCAN_LINES);

  let cwd: string | undefined;
  let firstUserMessage: string | undefined;
  let lastCompactionSummary: string | undefined;

  for (const line of lines) {
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const rec = record as Record<string, unknown>;
    if (!cwd && typeof rec.cwd === 'string' && rec.cwd.length > 0) {
      cwd = rec.cwd;
    }
    if (!firstUserMessage) {
      const text = extractUserMessageText(rec);
      if (text) firstUserMessage = text;
    }
    const summary = extractCompactionSummary(rec);
    if (summary) lastCompactionSummary = summary;
  }

  if (!cwd) return;
  const subject = lastCompactionSummary
    ? `${COMPACTION_SUBJECT_PREFIX}${truncate(lastCompactionSummary, 120)}`
    : firstUserMessage
      ? truncate(firstUserMessage, 120)
      : '';
  const sessionId = path.basename(filePath, '.jsonl');

  const existing = byCwd.get(cwd);
  if (!existing) {
    byCwd.set(cwd, {
      cwd,
      sessionCount: 1,
      lastMtimeMs: stat.mtimeMs,
      subject,
      lastSessionId: sessionId,
    });
    return;
  }
  existing.sessionCount += 1;
  if (stat.mtimeMs > existing.lastMtimeMs) {
    existing.lastMtimeMs = stat.mtimeMs;
    existing.lastSessionId = sessionId;
    if (subject) existing.subject = subject;
  } else if (!existing.subject && subject) {
    existing.subject = subject;
  }
}

function extractUserMessageText(rec: Record<string, unknown>): string | undefined {
  if (rec.type !== 'user') return undefined;
  const message = rec.message;
  if (!message || typeof message !== 'object') return undefined;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content.trim() || undefined;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'text' &&
        typeof (block as Record<string, unknown>).text === 'string'
      ) {
        const text = ((block as Record<string, unknown>).text as string).trim();
        if (text) return text;
      }
    }
  }
  return undefined;
}

function extractCompactionSummary(rec: Record<string, unknown>): string | undefined {
  if (rec.type !== 'summary') return undefined;
  if (typeof rec.summary === 'string' && rec.summary.trim().length > 0) {
    return rec.summary.trim();
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  return oneline.length > max ? `${oneline.slice(0, max - 1)}…` : oneline;
}
