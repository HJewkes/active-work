#!/usr/bin/env node
/* eslint-disable no-undef -- Node ESM build tool */
/**
 * mine-session-signals.mjs — a deterministic, one-pass extractor for the FULL
 * signal surface of Claude Code session transcripts, scoped to one repo.
 *
 * Beyond file touches it pulls out the cross-session assets and metrics that let
 * you navigate engineering history: PRs, branches, commits/pushes, files, tasks,
 * subagents, artifacts, and per-session derived metrics (tokens, errors, turn
 * durations, compaction points, decisions, mode phases) — every asset carrying
 * back-references to the sessions/turns that touched it.
 *
 * Deterministic: same transcripts in → same output. Streams line-by-line.
 *
 * Usage: node mine-session-signals.mjs --repo <absoluteRepoPath> [--top N] [--out file.ts]
 */
import { promises as fs, createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const pexec = promisify(execFile);

/**
 * A repo plus every worktree it was ever edited from is ONE logical repo. Build
 * a resolver that maps any absolute path to a repo-relative path (or null).
 * Covers: the main repo, current linked worktrees (`git worktree list`), and —
 * for worktrees since removed — a sibling naming pattern `<repo>[-<suffix>]/`.
 */
async function buildRepoResolver(repo) {
  const parent = path.dirname(repo);
  const name = path.basename(repo);
  const roots = new Set([repo]);
  try {
    const { stdout } = await pexec('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
    for (const line of stdout.split('\n'))
      if (line.startsWith('worktree ')) roots.add(line.slice('worktree '.length).trim());
  } catch {
    /* not a repo / git missing — main root only */
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // sibling worktree: <parent>/<name>[-<suffix>]/<rel>  (catches removed worktrees)
  const siblingRe = new RegExp('^' + esc(parent + '/' + name) + '(?:-[^/]+)?/(.+)$');
  const rootList = [...roots].sort((a, b) => b.length - a.length); // longest first
  return (p) => {
    if (typeof p !== 'string') return null;
    for (const root of rootList) {
      if (p === root) return '';
      if (p.startsWith(root + '/')) return p.slice(root.length + 1);
    }
    const m = p.match(siblingRe);
    return m ? m[1] : null;
  };
}

const IGNORE = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|\.turbo|storybook-static)(\/|$)/;
const TASK_ID = /\b([A-Z]{1,5}-\d+)\b/;

function parseArgs(argv) {
  const a = { repo: null, top: 80, out: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--repo') a.repo = argv[++i];
    else if (argv[i] === '--top') a.top = Number(argv[++i]);
    else if (argv[i] === '--out') a.out = argv[++i];
  }
  return a;
}

async function transcripts() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const dirs = await fs.readdir(root);
  const out = [];
  for (const d of dirs) {
    let fl;
    try {
      fl = await fs.readdir(path.join(root, d));
    } catch {
      continue;
    }
    for (const f of fl) if (f.endsWith('.jsonl')) out.push({ dir: d, file: path.join(root, d, f) });
  }
  return out;
}

/** Strip leading `cd X && …` so we reach the real command verb. */
function realCmd(c) {
  if (typeof c !== 'string') return '';
  let s = c.trim();
  for (let i = 0; i < 4; i++) {
    const m = s.match(/^cd\s+[^&;]+(?:&&|;)\s*/);
    if (m) s = s.slice(m[0].length).trim();
    else break;
  }
  return s;
}

function ensure(map, key, make) {
  let v = map.get(key);
  if (!v) map.set(key, (v = make()));
  return v;
}

const B = "['\"]?([^\\s'\"&|;]+)"; // a branch-name capture (unquoted token)
const RE_NEW = new RegExp('\\bgit\\s+(?:-C\\s+\\S+\\s+)?(?:checkout\\s+-[bB]|switch\\s+-c)\\s+' + B);
const RE_SWITCH = new RegExp('\\bgit\\s+(?:-C\\s+\\S+\\s+)?(?:checkout|switch)\\s+(?![-\\d])' + B);
const RE_WT = new RegExp('\\bgit\\s+worktree\\s+add\\b[^&|;]*?\\s-b\\s+' + B);
const RE_PUSH_B = new RegExp('\\bgit\\s+push\\b[^&|;]*?\\borigin\\s+(?:-u\\s+)?' + B);
const RE_HEAD = new RegExp('\\bgh\\s+pr\\s+create\\b[^&|;]*?--head\\s+' + B);
const RE_MERGE = /\bgh\s+pr\s+merge\s+(\d+)/;

/** Extract branch/commit/push/merge intent from a raw (compound) Bash command. */
function parseGit(raw) {
  if (typeof raw !== 'string' || (!raw.includes('git') && !raw.includes('gh '))) return null;
  const clean = (n) => (n || '').replace(/^origin\//, '').replace(/['"]/g, '');
  const setBranch =
    (RE_NEW.exec(raw) || RE_WT.exec(raw) || RE_HEAD.exec(raw) || RE_PUSH_B.exec(raw) || RE_SWITCH.exec(raw))?.[1];
  const mergePr = RE_MERGE.exec(raw)?.[1];
  const commit = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(raw);
  const push = /\bgit\s+(?:-C\s+\S+\s+)?push\b/.test(raw);
  const b = setBranch ? clean(setBranch) : null;
  return { setBranch: b && b !== 'HEAD' && !b.startsWith('-') ? b : null, mergePr: mergePr ? Number(mergePr) : null, commit, push };
}

/**
 * Fold one assistant turn's `usage` into the session, bucketed by model. Tokens
 * are NOT fungible across models (Opus vs Sonnet price differently), so we keep
 * a per-model breakdown alongside the session totals, plus cache-creation and
 * billable server-tool (web search/fetch) counts that the earlier miner dropped.
 */
function addUsage(s, model, u) {
  if (!u) return;
  const inTok = u.input_tokens ?? 0;
  const outTok = u.output_tokens ?? 0;
  const cr = u.cache_read_input_tokens ?? 0;
  const cc = u.cache_creation_input_tokens ?? 0;
  s.tokensIn += inTok;
  s.tokensOut += outTok;
  s.cacheRead += cr;
  s.cacheCreation += cc;
  const stu = u.server_tool_use;
  if (stu && typeof stu === 'object') for (const v of Object.values(stu)) if (typeof v === 'number') s.serverToolUse += v;
  if (u.service_tier) s.serviceTiers[u.service_tier] = (s.serviceTiers[u.service_tier] ?? 0) + 1;
  if (model) {
    const m = s.tokensByModel[model] ?? (s.tokensByModel[model] = { in: 0, out: 0, cacheRead: 0, cacheCreation: 0 });
    m.in += inTok;
    m.out += outTok;
    m.cacheRead += cr;
    m.cacheCreation += cc;
  }
}

async function mine({ repo, topN }) {
  const repoName = path.basename(repo);
  const repoRel = await buildRepoResolver(repo); // path -> repo-relative | null (worktree-aware)
  const sessions = new Map();
  const prs = new Map(); // number -> rec
  const branches = new Map(); // name -> rec
  const files = new Map(); // relpath -> rec
  const tasks = new Map(); // id -> rec
  const subagents = [];
  const artifacts = [];
  const branchStats = new Map(); // branch name -> { commits, pushes } (from commands)
  let events = 0;
  let turnDurations = [];

  const sess = (id) =>
    ensure(sessions, id, () => ({
      id,
      dir: null,
      aiTitle: null,
      seedPrompt: null,
      bridgeSessionId: null,
      firstTs: null,
      lastTs: null,
      turns: 0,
      userPrompts: 0,
      version: null,
      branches: new Set(),
      codeBranches: new Set(), // branch names seen in this session's git/gh commands
      curBranch: null, // the code branch currently checked out (from commands)
      prs: new Set(),
      tasks: new Set(),
      fileTouches: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheCreation: 0,
      serverToolUse: 0,
      serviceTiers: {},
      tokensByModel: {}, // model -> { in, out, cacheRead, cacheCreation }
      thinkingBlocks: 0,
      thinkingChars: 0,
      textBlocks: 0,
      phases: [], // ordered mode/permission spans: { kind, value, loc }
      maxTurnsHits: 0,
      humanEdits: 0, // user-authored file edits (edited_text_file attachments)
      commits: 0,
      pushes: 0,
      errors: 0,
      compactions: 0,
      decisions: 0,
      subagents: 0,
      artifacts: 0,
      tools: {},
    }));

  const files_ = (rel) =>
    ensure(files, rel, () => ({
      path: rel,
      reads: 0,
      writes: 0,
      edits: 0,
      humanEdits: 0, // user edits from edited_text_file attachments (not Claude)
      charsAdded: 0,
      charsRemoved: 0,
      sessions: new Set(),
      branches: new Set(),
      firstTs: null,
      lastTs: null,
      touchLocs: [],
      locSessions: new Set(), // one locator per distinct session that mutated it
      humanLocSessions: new Set(), // one human-edit locator per distinct session
    }));

  // Transcript index: each locator points back into the raw JSONL by
  // (transcriptIndex, byteOffset, byteLength) so the UI can seek+read exactly
  // one line to get an event's full text, without copying it into the index.
  const transcriptList = [];
  const transcriptIdx = new Map();
  const tIdxFor = (p) => {
    let i = transcriptIdx.get(p);
    if (i === undefined) {
      i = transcriptList.length;
      transcriptList.push(p);
      transcriptIdx.set(p, i);
    }
    return i;
  };

  // Record a mode/permission-mode transition. `mode` and `permission` lines
  // interleave and fire often, so dedup against the last value *per kind* (not the
  // last entry overall) — we only want genuine phase changes. No timestamp on
  // these events, so the locator gives position/order.
  const lastPhaseVal = new Map(); // `${sessionId}:${kind}` -> value
  const pushPhase = (s, kind, value, loc) => {
    const k = s.id + ':' + kind;
    if (lastPhaseVal.get(k) === value) return;
    lastPhaseVal.set(k, value);
    s.phases.push({ kind, value, loc });
  };

  // Fold an attachment line into the session. Two subtypes carry real signal:
  // edited_text_file = a user-authored edit (invisible to the Read/Write/Edit
  // tool path), and max_turns_reached = a turn-limit friction hit.
  const handleAttachment = (s, o, loc) => {
    const a = o.attachment;
    if (!a || typeof a !== 'object') return;
    if (a.type === 'max_turns_reached') {
      s.maxTurnsHits++;
      return;
    }
    if (a.type !== 'edited_text_file' || typeof a.filename !== 'string') return;
    const rel = repoRel(a.filename);
    if (!rel || IGNORE.test(rel)) return;
    const f = files_(rel);
    const ts = o.timestamp ?? null;
    f.humanEdits++;
    s.humanEdits++;
    f.sessions.add(s.id);
    if (s.curBranch) f.branches.add(s.curBranch);
    if (ts) {
      if (!f.firstTs || ts < f.firstTs) f.firstTs = ts;
      if (!f.lastTs || ts > f.lastTs) f.lastTs = ts;
    }
    if (!f.humanLocSessions.has(s.id)) {
      f.humanLocSessions.add(s.id);
      f.touchLocs.push({ session: s.id, ts, tool: 'edited_text_file', loc });
    }
  };

  for (const { dir, file } of await transcripts()) {
    const tIdx = tIdxFor(file.replace(os.homedir(), '~'));
    let byteOffset = 0;
    const rl = readline.createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      // locator for THIS line; advance the byte cursor for every line (incl. blanks)
      const loc = [tIdx, byteOffset, Buffer.byteLength(line, 'utf8')];
      byteOffset += loc[2] + 1; // +1 for the '\n'
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const id = o.sessionId;
      const ts = o.timestamp ?? null;
      const branch = typeof o.gitBranch === 'string' && o.gitBranch ? o.gitBranch : null;
      const cwd = o.cwd;
      const inRepo = repoRel(cwd) !== null; // cwd is in the repo or one of its worktrees

      // ---- typed event lines (asset records) ----
      if (o.type === 'pr-link' && typeof o.prRepository === 'string' && o.prRepository.endsWith('/' + repoName)) {
        const pr = ensure(prs, o.prNumber, () => ({
          number: o.prNumber,
          url: o.prUrl,
          repo: o.prRepository,
          firstTs: ts,
          lastTs: ts,
          merged: false,
          branch: null,
          sessions: new Set(),
          linkLoc: loc,
        }));
        pr.lastTs = ts;
        pr.linkLoc = loc;
        if (id) {
          pr.sessions.add(id);
          sess(id).prs.add(o.prNumber);
          // The code branch checked out in this session when the PR was linked.
          if (!pr.branch && sess(id).curBranch) pr.branch = sess(id).curBranch;
        }
        events++;
        continue;
      }
      if (o.type === 'ai-title' && id) {
        sess(id).aiTitle = o.aiTitle;
        continue;
      }
      if (o.type === 'last-prompt' && id && !sess(id).seedPrompt) {
        sess(id).seedPrompt = String(o.lastPrompt ?? '').slice(0, 240);
        continue;
      }
      if (o.type === 'bridge-session' && id) {
        sess(id).bridgeSessionId = o.bridgeSessionId;
        continue;
      }
      if (o.type === 'frame-link') {
        artifacts.push({ session: id, url: o.frameUrl, title: o.title ?? null, path: o.path ?? null });
        if (id) sess(id).artifacts++;
        continue;
      }
      if (o.type === 'system') {
        if (o.subtype === 'compact_boundary' && id) sess(id).compactions++;
        if (o.subtype === 'turn_duration' && typeof o.durationMs === 'number') turnDurations.push(o.durationMs);
        continue;
      }
      if (o.type === 'mode' && id && typeof o.mode === 'string') {
        pushPhase(sess(id), 'mode', o.mode, loc);
        continue;
      }
      if (o.type === 'permission-mode' && id && typeof o.permissionMode === 'string') {
        pushPhase(sess(id), 'permission', o.permissionMode, loc);
        continue;
      }
      if (o.type === 'attachment' && id) {
        handleAttachment(sess(id), o, loc);
        continue;
      }

      // ---- conversation lines ----
      if (!id) continue;
      const s = sess(id);
      s.dir = s.dir ?? dir;
      if (!s.startLoc) s.startLoc = loc;
      if (ts) {
        if (!s.firstTs || ts < s.firstTs) s.firstTs = ts;
        if (!s.lastTs || ts > s.lastTs) s.lastTs = ts;
      }
      if (o.version) s.version = o.version;
      // gitBranch is only a usable fallback when it's a real branch name (not
      // detached HEAD) and the cwd is in the repo; the primary branch signal is
      // parsed from git/gh commands below (works for the workspace pattern too).
      if (branch && branch !== 'HEAD' && inRepo && !s.curBranch) s.curBranch = branch;

      const content = o.message?.content;
      if (o.type === 'user') {
        if (typeof content === 'string' || (Array.isArray(content) && content.some((b) => b.type === 'text')))
          s.userPrompts++;
        if (Array.isArray(content))
          for (const b of content) if (b.type === 'tool_result' && b.is_error) s.errors++;
        continue;
      }
      if (o.type !== 'assistant' || !Array.isArray(content)) continue;
      s.turns++;
      addUsage(s, o.message?.model ?? null, o.message?.usage);

      for (const b of content) {
        if (b.type === 'thinking') {
          s.thinkingBlocks++;
          s.thinkingChars += (b.thinking ?? '').length;
          continue;
        }
        if (b.type === 'text') {
          s.textBlocks++;
          continue;
        }
        if (b.type !== 'tool_use') continue;
        events++;
        s.tools[b.name] = (s.tools[b.name] ?? 0) + 1;
        const fp = b.input?.file_path ?? b.input?.notebook_path;

        if ((b.name === 'Read' || b.name === 'Write' || b.name === 'Edit' || b.name === 'MultiEdit') && typeof fp === 'string') {
          const rel = repoRel(fp); // worktree-aware; merges the same file across worktrees
          if (rel && !IGNORE.test(rel)) {
            const f = files_(rel);
            f.sessions.add(id);
            if (s.curBranch) f.branches.add(s.curBranch); // the code branch checked out now
            if (ts) {
              if (!f.firstTs || ts < f.firstTs) f.firstTs = ts;
              if (!f.lastTs || ts > f.lastTs) f.lastTs = ts;
            }
            s.fileTouches++;
            if (b.name === 'Read') f.reads++;
            else if (b.name === 'Write') {
              f.writes++;
              f.charsAdded += (b.input?.content ?? '').length;
            } else {
              f.edits++;
              const arr = b.name === 'MultiEdit' ? b.input?.edits ?? [] : [b.input ?? {}];
              for (const e of arr) {
                const d = (e.new_string ?? '').length - (e.old_string ?? '').length;
                if (d >= 0) f.charsAdded += d;
                else f.charsRemoved += -d;
              }
            }
            // One jump-to-log locator per distinct session that touched the file
            // (read or write), tagged with the tool; trimmed to most-recent later.
            if (!f.locSessions.has(id)) {
              f.locSessions.add(id);
              f.touchLocs.push({ session: id, ts, tool: b.name, loc });
            }
          }
        } else if (b.name === 'Agent') {
          s.subagents++;
          if (subagents.length < 400)
            subagents.push({ session: id, label: b.input?.description ?? null, type: b.input?.subagent_type ?? null });
        } else if (b.name === 'AskUserQuestion') {
          s.decisions++;
        } else if (b.name === 'Artifact') {
          s.artifacts++;
          artifacts.push({ session: id, title: b.input?.description ?? null, path: b.input?.file_path ?? null, url: null });
        } else if (b.name === 'Bash') {
          const raw = b.input?.command;
          // Branch/commit/push/merge parsed from the raw (possibly compound) command.
          const g = parseGit(raw);
          if (g) {
            if (g.setBranch) {
              s.curBranch = g.setBranch;
              s.codeBranches.add(g.setBranch);
            }
            if (g.commit) {
              s.commits++;
              if (s.curBranch) ensure(branchStats, s.curBranch, () => ({ commits: 0, pushes: 0 })).commits++;
            }
            if (g.push) {
              s.pushes++;
              if (s.curBranch) ensure(branchStats, s.curBranch, () => ({ commits: 0, pushes: 0 })).pushes++;
            }
            if (g.mergePr != null) {
              const pr = prs.get(g.mergePr);
              if (pr) pr.merged = true;
            }
          }
          const cmd = realCmd(raw);
          const w = cmd.split(/\s+/);
          // active-work task/session ops, scoped to THIS repo's initiative (the
          // slug token must equal the repo name — otherwise it's another
          // initiative's task and doesn't belong to this repo's index).
          if ((w[0] === 'active-work' || w[0] === 'aw') && w.includes(repoName)) {
            const sub = w[1] === 'task' ? w[2] : w[1];
            const m = cmd.match(TASK_ID);
            if (m) {
              const t = ensure(tasks, m[1], () => ({ id: m[1], sessions: new Set(), actions: {} }));
              t.sessions.add(id);
              t.actions[sub] = (t.actions[sub] ?? 0) + 1;
              s.tasks.add(m[1]);
            }
          }
        }
      }
    }
  }

  // Build the branch index from command-derived branch usage in repo-relevant
  // sessions (a session that touched repo files or PRs).
  for (const s of sessions.values()) {
    if (!(s.fileTouches > 0 || s.prs.size > 0)) continue;
    for (const name of s.codeBranches) {
      const b = ensure(branches, name, () => ({
        name,
        sessions: new Set(),
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        files: new Set(),
      }));
      b.sessions.add(s.id);
      if (s.firstTs && (!b.firstTs || s.firstTs < b.firstTs)) b.firstTs = s.firstTs;
      if (s.lastTs && (!b.lastTs || s.lastTs > b.lastTs)) b.lastTs = s.lastTs;
    }
  }
  // files → branch
  for (const f of files.values())
    for (const name of f.branches) branches.get(name)?.files.add(f.path);

  // Derive PR ↔ branch ↔ sessions: a PR's branch is the code branch checked out
  // when it was linked; every session that worked that branch helped build it.
  const branchPrs = new Map(); // branch -> Set<prNumber>
  for (const pr of prs.values()) {
    if (pr.branch && branches.has(pr.branch)) {
      for (const sid of branches.get(pr.branch).sessions) pr.sessions.add(sid);
      ensure(branchPrs, pr.branch, () => new Set()).add(pr.number);
    }
  }

  // co-change for files (within the top set), mutated-together per session
  const perSessionMutations = new Map();
  for (const f of files.values())
    for (const sid of f.sessions) {
      if (f.writes + f.edits === 0) continue;
      ensure(perSessionMutations, sid, () => new Set()).add(f.path);
    }
  const pair = new Map();
  for (const set of perSessionMutations.values()) {
    const arr = [...set];
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++) {
        const k = arr[i] < arr[j] ? arr[i] + ' ' + arr[j] : arr[j] + ' ' + arr[i];
        pair.set(k, (pair.get(k) ?? 0) + 1);
      }
  }

  const fileArr = [...files.values()]
    .map((f) => ({ ...f, touches: f.reads + f.writes + f.edits + f.humanEdits }))
    .sort((a, b) => b.touches - a.touches)
    .slice(0, topN)
    .map((f) => {
      const co = [];
      for (const [k, c] of pair) {
        const [a, b] = k.split(' ');
        if (a === f.path) co.push({ path: b, count: c });
        else if (b === f.path) co.push({ path: a, count: c });
      }
      co.sort((x, y) => y.count - x.count);
      return {
        path: f.path,
        reads: f.reads,
        writes: f.writes,
        edits: f.edits,
        humanEdits: f.humanEdits,
        touches: f.touches,
        sessions: [...f.sessions],
        branches: [...f.branches],
        netGrowth: f.charsAdded - f.charsRemoved,
        firstTouched: f.firstTs,
        lastTouched: f.lastTs,
        coChange: co.slice(0, 6),
        // most-recent sessions first, capped — these carry the jump-to-log links
        touchLocs: [...f.touchLocs].sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 40),
      };
    });

  const ser = (m, fn) => [...m.values()].map(fn);
  const sessionsArr = ser(sessions, (s) => ({
    id: s.id,
    dir: s.dir,
    aiTitle: s.aiTitle,
    seedPrompt: s.seedPrompt,
    bridgeSessionId: s.bridgeSessionId,
    firstTs: s.firstTs,
    lastTs: s.lastTs,
    durationMs: s.firstTs && s.lastTs ? new Date(s.lastTs) - new Date(s.firstTs) : 0,
    turns: s.turns,
    userPrompts: s.userPrompts,
    version: s.version,
    branches: [...s.codeBranches],
    prs: [...s.prs],
    tasks: [...s.tasks],
    fileTouches: s.fileTouches,
    humanEdits: s.humanEdits,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    cacheRead: s.cacheRead,
    cacheCreation: s.cacheCreation,
    serverToolUse: s.serverToolUse,
    serviceTiers: s.serviceTiers,
    tokensByModel: s.tokensByModel,
    thinkingBlocks: s.thinkingBlocks,
    thinkingChars: s.thinkingChars,
    textBlocks: s.textBlocks,
    phases: s.phases,
    maxTurnsHits: s.maxTurnsHits,
    commits: s.commits,
    pushes: s.pushes,
    errors: s.errors,
    compactions: s.compactions,
    decisions: s.decisions,
    subagents: s.subagents,
    artifacts: s.artifacts,
    tools: s.tools,
    startLoc: s.startLoc ?? null,
  }))
    // Repo-relevant only: touched a repo file, a repo PR, or a repo task.
    // (Turns/tokens still reflect the whole session, which may span repos.)
    .filter((s) => s.fileTouches > 0 || s.prs.length > 0 || s.tasks.length > 0)
    .sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));

  const prsArr = ser(prs, (p) => ({
    number: p.number,
    url: p.url,
    repo: p.repo,
    merged: p.merged,
    branch: p.branch,
    firstTs: p.firstTs,
    lastTs: p.lastTs,
    sessions: [...p.sessions],
    linkLoc: p.linkLoc,
  })).sort((a, b) => b.number - a.number);

  const branchesArr = ser(branches, (b) => ({
    name: b.name,
    sessions: [...b.sessions],
    firstTs: b.firstTs,
    lastTs: b.lastTs,
    commits: branchStats.get(b.name)?.commits ?? 0,
    pushes: branchStats.get(b.name)?.pushes ?? 0,
    files: b.files.size,
    prs: [...(branchPrs.get(b.name) ?? [])],
  })).sort((a, b) => b.prs.length + b.sessions.length - (a.prs.length + a.sessions.length));

  const tasksArr = ser(tasks, (t) => ({ id: t.id, sessions: [...t.sessions], actions: t.actions })).sort(
    (a, b) => b.sessions.length - a.sessions.length,
  );

  turnDurations.sort((a, b) => a - b);
  const pct = (p) => turnDurations[Math.floor((turnDurations.length - 1) * p)] ?? 0;

  // Global per-model token rollup — the sum across models is not meaningful for
  // cost (different prices), so keep the breakdown at the top level too.
  const tokensByModel = {};
  for (const s of sessionsArr)
    for (const [model, v] of Object.entries(s.tokensByModel)) {
      const t = tokensByModel[model] ?? (tokensByModel[model] = { in: 0, out: 0, cacheRead: 0, cacheCreation: 0 });
      t.in += v.in;
      t.out += v.out;
      t.cacheRead += v.cacheRead;
      t.cacheCreation += v.cacheCreation;
    }

  const metrics = {
    tokensIn: sessionsArr.reduce((n, s) => n + s.tokensIn, 0),
    tokensOut: sessionsArr.reduce((n, s) => n + s.tokensOut, 0),
    cacheRead: sessionsArr.reduce((n, s) => n + s.cacheRead, 0),
    cacheCreation: sessionsArr.reduce((n, s) => n + s.cacheCreation, 0),
    serverToolUse: sessionsArr.reduce((n, s) => n + s.serverToolUse, 0),
    tokensByModel,
    thinkingBlocks: sessionsArr.reduce((n, s) => n + s.thinkingBlocks, 0),
    humanEdits: sessionsArr.reduce((n, s) => n + s.humanEdits, 0),
    maxTurnsHits: sessionsArr.reduce((n, s) => n + s.maxTurnsHits, 0),
    errors: sessionsArr.reduce((n, s) => n + s.errors, 0),
    decisions: sessionsArr.reduce((n, s) => n + s.decisions, 0),
    compactions: sessionsArr.reduce((n, s) => n + s.compactions, 0),
    commits: sessionsArr.reduce((n, s) => n + s.commits, 0),
    pushes: sessionsArr.reduce((n, s) => n + s.pushes, 0),
    subagents: sessionsArr.reduce((n, s) => n + s.subagents, 0),
    turnDurationMs: { p50: pct(0.5), p85: pct(0.85), p99: pct(0.99), count: turnDurations.length },
  };

  return {
    repo: repoName,
    repoPath: repo,
    transcripts: transcriptList,
    locatorFormat: '[transcriptIndex, byteOffset, byteLength] into transcripts[]; seek+read one JSONL line',
    generatedFrom: { sessions: sessionsArr.length, events },
    sessions: sessionsArr,
    prs: prsArr,
    branches: branchesArr,
    files: fileArr,
    tasks: tasksArr,
    subagents,
    artifacts,
    metrics,
  };
}

function toTs(data) {
  return `// AUTO-GENERATED by tools/mine-session-signals.mjs — deterministic full-signal
// extraction of Claude Code session transcripts, scoped to one repo. Re-run to refresh.
/* eslint-disable */
export const sessionSignals = ${JSON.stringify(data, null, 2)} as const;
export type SessionSignals = typeof sessionSignals;
`;
}

async function main() {
  const { repo, top, out } = parseArgs(process.argv);
  if (!repo) {
    console.error('usage: node mine-session-signals.mjs --repo <absoluteRepoPath> [--top N] [--out file.ts]');
    process.exit(2);
  }
  const data = await mine({ repo, topN: top });
  const outPath = out ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'session-signals.ts');
  await fs.writeFile(outPath, toTs(data), 'utf8');

  const m = data.metrics;
  console.log(`repo: ${data.repo}  (${data.repoPath})`);
  console.log(`sessions: ${data.sessions.length}  events: ${data.generatedFrom.events}`);
  console.log(
    `assets → PRs ${data.prs.length} (merged ${data.prs.filter((p) => p.merged).length}) · ` +
      `branches ${data.branches.length} · files ${data.files.length} · tasks ${data.tasks.length} · ` +
      `subagents ${data.subagents.length} · artifacts ${data.artifacts.length}`,
  );
  console.log(
    `metrics → tokens in/out ${(m.tokensIn / 1e6).toFixed(1)}M/${(m.tokensOut / 1e6).toFixed(1)}M · ` +
      `cacheCreate ${(m.cacheCreation / 1e6).toFixed(1)}M · commits ${m.commits} · pushes ${m.pushes} · errors ${m.errors} · ` +
      `decisions ${m.decisions} · compactions ${m.compactions} · turn p50/p85 ${(m.turnDurationMs.p50 / 1000) | 0}s/${(m.turnDurationMs.p85 / 1000) | 0}s`,
  );
  console.log(
    `signals → human edits ${m.humanEdits} · maxTurnsHits ${m.maxTurnsHits} · thinking blocks ${m.thinkingBlocks} · serverToolUse ${m.serverToolUse}`,
  );
  console.log('tokens by model (in/out/cacheCreate):');
  for (const [model, v] of Object.entries(m.tokensByModel))
    console.log(`  ${model}: ${(v.in / 1e6).toFixed(1)}M / ${(v.out / 1e6).toFixed(1)}M / ${(v.cacheCreation / 1e6).toFixed(1)}M`);
  console.log('\ntop PRs (number · sessions · merged):');
  for (const p of data.prs.slice(0, 6)) console.log(`  #${p.number}  ${p.sessions.length}s  ${p.merged ? 'merged' : 'open'}`);
  console.log('\ntop branches (name · commits+pushes · sessions · files):');
  for (const b of data.branches.slice(0, 6))
    console.log(`  ${b.commits}c ${b.pushes}p  ${b.sessions.length}s  ${b.files}f  ${b.name}`);
  console.log('\ntop sessions (title · turns · files · prs):');
  for (const s of data.sessions.slice(0, 6))
    console.log(`  ${s.turns}t ${s.fileTouches}f pr[${s.prs.join(',')}]  ${(s.aiTitle ?? s.id).slice(0, 60)}`);
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
