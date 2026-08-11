import type { ExtractAccumulator } from './accumulator.js';
import type { RawLine } from './json-lines.js';
import {
  IGNORED_PATH,
  commandCwd,
  parseGitIntent,
  parsePrCreateTitle,
  parseTaskId,
  realCommand,
} from './bash-parse.js';
import type { GitIntent } from './bash-parse.js';
import {
  agentRef,
  artifactRef,
  branchRef,
  fileRef,
  humanEditedFile,
  prRef,
  repoForCwd,
  sessionLinkedPr,
  sessionProducedArtifact,
  sessionRanTask,
  sessionRef,
  sessionSpawnedSubagent,
  sessionTouchedFile,
  sessionWorkedBranch,
  subagentTranscribedIn,
  taskRef,
  toRepoRelative,
} from './edges.js';

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function str(source: Json | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function int(source: Json | null, key: string): number {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function blocks(message: Json | null): Json[] {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.map(asObject).filter((b): b is Json => b !== null);
}

interface LineContext {
  line: Json;
  loc: RawLine;
  sessionId: string;
  ts: string;
  cwd: string | null;
  gitBranch: string | null;
  repo: string | null;
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit']);

type SpanField = 'prompt' | 'assistant_response' | 'tool_input' | 'tool_result';

/**
 * Per-span cap on indexed text. A pasted build log or a 2MB file read would
 * otherwise dominate the FTS index for no retrieval benefit; the locator still
 * points at the full record on disk.
 */
export const SPAN_TEXT_CAP = 16 * 1024;

/**
 * Collect the string leaves of an already-parsed tool input.
 *
 * Deliberately not `JSON.stringify`: indexing the raw JSON would fill the FTS
 * index with field names (`file_path`, `old_string`, …) that match every
 * document and discriminate nothing. The leaves are the actual commands, paths
 * and prompts a search is looking for.
 */
function stringLeaves(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || out.length > 64) return;
  if (typeof value === 'string') {
    if (value.length > 0) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out, depth + 1);
    return;
  }
  const object = asObject(value);
  if (object) for (const item of Object.values(object)) stringLeaves(item, out, depth + 1);
}

/** A `tool_result` block's content is either a bare string or text blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => str(asObject(block), 'text') ?? '')
    .filter(Boolean)
    .join('\n');
}

/**
 * Split `output_tokens` into the share attributable to extended thinking.
 *
 * The API reports one `output_tokens` figure covering thinking, text and
 * tool_use alike, so this is necessarily an estimate: the character share of
 * the thinking blocks against all generated content on the same line. Derived
 * here rather than as a rollup because it is a *stateless per-line* function of
 * data that is all on this JSONL record — so it survives any chunk boundary and
 * an incremental pass converges with a full rebuild by construction.
 */
function thinkingTokens(message: Json | null, outputTokens: number): number {
  if (outputTokens <= 0) return 0;
  let thinking = 0;
  let total = 0;
  for (const block of blocks(message)) {
    const leaves: string[] = [];
    if (block.type === 'thinking') stringLeaves(block.thinking, leaves);
    else if (block.type === 'text') stringLeaves(block.text, leaves);
    else if (block.type === 'tool_use') stringLeaves(block.input, leaves);
    else continue;
    const length = leaves.reduce((sum, part) => sum + part.length, 0);
    total += length;
    if (block.type === 'thinking') thinking += length;
  }
  if (total === 0 || thinking === 0) return 0;
  return Math.min(outputTokens, Math.round((outputTokens * thinking) / total));
}

/**
 * Project the prose out of a parsed line for the FTS index.
 *
 * Done here, at extraction time, because the line is already parsed — the
 * alternative (re-reading the byte range at write time) would mean a second
 * pass over every transcript. The writer tokenizes this and discards it; it is
 * never stored, which is what keeps `searchable_spans` a pure locator table.
 */
export function searchText(message: Json | null, field: SpanField): string {
  const content = message?.content;
  if (typeof content === 'string') return content.slice(0, SPAN_TEXT_CAP);

  const parts: string[] = [];
  for (const block of blocks(message)) {
    if (field === 'tool_input') {
      if (block.type === 'tool_use') stringLeaves(block.input, parts);
    } else if (field === 'tool_result') {
      if (block.type === 'tool_result') parts.push(toolResultText(block.content));
    } else if (block.type === 'text') {
      parts.push(str(block, 'text') ?? '');
    }
  }
  return parts.filter(Boolean).join('\n').slice(0, SPAN_TEXT_CAP);
}

/**
 * Translates one transcript JSONL line into typed index rows.
 *
 * Every rule here is *stateless across lines*: a row's content depends only on
 * the line that produced it. That is what makes "index incrementally from a
 * watermark" and "rebuild the whole file in one pass" produce identical row
 * sets — a cross-line accumulator (e.g. the AW-22 prototype's `curBranch`)
 * would silently diverge whenever a chunk boundary split its state. The
 * per-line `gitBranch`/`cwd` fields carry the same signal without the state.
 */
export class LineHandler {
  /**
   * `fallbackSessionId` covers `file-history-snapshot`/`file-history-delta`
   * lines, which carry no `sessionId` field of their own — every transcript is
   * one session, and its filename (the caller's basename, minus `.jsonl`) is
   * that session's id, the same id these lines' own backup paths are keyed
   * under on disk (`~/.claude/file-history/<sessionId>/...`).
   */
  /**
   * `subagentId` marks this transcript as a subagent sidechain. Those files
   * are the one case where a line's own `sessionId` is *not* its session: it
   * names the parent that dispatched the subagent. Taking it at face value
   * would file every subagent's turns, tokens and file touches under the
   * parent, inflating its metrics with work it did not do. So the subagent
   * gets its own identity here, and the field it displaced becomes the parent
   * edge instead — which is precisely the link AW-26 wants.
   */
  constructor(
    private readonly acc: ExtractAccumulator,
    private readonly fallbackSessionId: string | null = null,
    private readonly subagentId: string | null = null,
  ) {}

  handle(line: Json, loc: RawLine): void {
    // In a sidechain the fallback is the FILE's basename, `agent-<id>`, while
    // `subagentId` is the bare `<id>` — so a line carrying no `sessionId` of
    // its own used to resolve to a spelling of this very session that nothing
    // else uses, and `observeSubagentParent`'s self-reference guard could not
    // see it was the same session. That wrote 15 `session:agent-X --spawned-->
    // session:X` self-loops, every dangling session endpoint in the index
    // (AW-107). A line with no sessionId inside a sidechain belongs to the
    // subagent; it cannot be naming a parent.
    const ownSessionId = str(line, 'sessionId') ?? this.subagentId ?? this.fallbackSessionId;
    const sessionId = this.subagentId ?? ownSessionId;
    if (!sessionId) return;
    const branch = str(line, 'gitBranch');
    const cwd = str(line, 'cwd');
    const ctx: LineContext = {
      line,
      loc,
      sessionId,
      // `file-history-snapshot` has no top-level `timestamp`; its own clock is
      // nested at `snapshot.timestamp`. Other types never have `line.snapshot`,
      // so this fallback is a no-op for them.
      ts: str(line, 'timestamp') ?? str(asObject(line.snapshot), 'timestamp') ?? '',
      cwd,
      gitBranch: branch === 'HEAD' ? null : branch,
      repo: repoForCwd(cwd),
    };
    this.observeSession(ctx);
    if (this.subagentId) this.observeSubagentParent(ctx, ownSessionId);
    this.dispatch(ctx, str(line, 'type') ?? 'unknown');
  }

  /**
   * Emitted per line rather than once per file, on purpose: the accumulator and
   * the `edges` unique index both dedupe, and a once-per-file rule would be
   * cross-line state — exactly what breaks incremental/full equivalence when a
   * chunk boundary falls after the first line (see the class header).
   *
   * `parentSessionId` is the sidechain line's own `sessionId`, which names the
   * dispatching session, not this one.
   */
  private observeSubagentParent(ctx: LineContext, parentSessionId: string | null): void {
    if (!parentSessionId || parentSessionId === ctx.sessionId) return;
    this.acc.addEdge(
      sessionSpawnedSubagent({
        sourceRef: sessionRef(parentSessionId),
        targetRef: sessionRef(ctx.sessionId),
        tValid: ctx.ts,
        factByteOffset: ctx.loc.byteOffset,
      }),
    );
  }

  private dispatch(ctx: LineContext, type: string): void {
    switch (type) {
      case 'pr-link':
        return this.handlePrLink(ctx);
      case 'ai-title':
        return this.handleTypedField(ctx, 'ai_title', 'aiTitle');
      case 'last-prompt':
        return this.handleTypedField(ctx, 'last_prompt', 'lastPrompt');
      case 'frame-link':
        return this.handleFrameLink(ctx);
      case 'mode':
        return this.handlePhase(ctx, 'mode', 'mode');
      case 'permission-mode':
        return this.handlePhase(ctx, 'permission-mode', 'permissionMode');
      case 'attachment':
        return this.handleAttachment(ctx);
      case 'file-history-snapshot':
        return this.handleFileHistorySnapshot(ctx);
      case 'system':
        return this.fact(ctx, `system_${str(ctx.line, 'subtype') ?? 'event'}`);
      case 'user':
        return this.handleUser(ctx);
      case 'assistant':
        return this.handleAssistant(ctx);
      default:
        this.fact(ctx, type);
    }
  }

  private fact(ctx: LineContext, eventType: string, toolUseId: string | null = null): void {
    this.acc.facts.push({
      byteOffset: ctx.loc.byteOffset,
      byteLength: ctx.loc.byteLength,
      eventType,
      ts: ctx.ts,
      sessionId: ctx.sessionId,
      promptId: eventType === 'user_prompt' ? str(ctx.line, 'uuid') : null,
      toolUseId,
    });
  }

  /** Line-granular span: the locator addresses the whole JSONL record. */
  private span(ctx: LineContext, field: SpanField): void {
    this.acc.spans.push({
      field,
      factByteOffset: ctx.loc.byteOffset,
      byteOffset: ctx.loc.byteOffset,
      byteLength: ctx.loc.byteLength,
      text: searchText(asObject(ctx.line.message), field),
    });
  }

  private observeSession(ctx: LineContext): void {
    const session = this.acc.session(ctx.sessionId);
    this.acc.observeSessionTimestamp(ctx.sessionId, ctx.ts || null, str(ctx.line, 'entrypoint'));
    session.cwd = ctx.cwd ?? session.cwd;
    session.cliVersion = str(ctx.line, 'version') ?? session.cliVersion;
    if (!ctx.gitBranch) return;
    // First non-null wins, matching the writer's
    // `git_branch = COALESCE(git_branch, excluded.git_branch)`. Taking the last
    // one here instead made the stored branch depend on where chunk boundaries
    // fell: a one-pass build kept the file's final branch, an incremental build
    // kept the first chunk's — a divergence the equivalence eval caught.
    session.gitBranch ??= ctx.gitBranch;
    this.recordBranch(ctx, ctx.gitBranch);
  }

  private recordBranch(
    ctx: LineContext,
    name: string,
    repo = ctx.repo,
    base: string | null = null,
  ): string {
    const ref = branchRef(repo, name);
    this.acc.addBranch({
      branchRef: ref,
      repo,
      name,
      base,
      createdAt: ctx.ts || null,
      deletedAt: null,
    });
    this.acc.addEdge(
      sessionWorkedBranch({
        sourceRef: sessionRef(ctx.sessionId),
        targetRef: ref,
        tValid: ctx.ts,
        factByteOffset: ctx.loc.byteOffset,
      }),
    );
    return ref;
  }

  private handleTypedField(
    ctx: LineContext,
    eventType: string,
    key: 'aiTitle' | 'lastPrompt',
  ): void {
    const value = str(ctx.line, key);
    if (value === null) return this.fact(ctx, eventType);
    const session = this.acc.session(ctx.sessionId);
    // `ai_title` is last-wins and `seed_prompt` first-wins, each matching its
    // COALESCE direction in the writer's upsert. Getting the direction wrong
    // here makes the stored value depend on where a chunk boundary landed —
    // a one-pass build keeps the file's last observation, an incremental build
    // keeps the first. Both fields had that divergence until the equivalence
    // eval caught it; "seed" is also, correctly, the earliest prompt.
    if (key === 'aiTitle') session.aiTitle = value;
    else session.seedPrompt ??= value.slice(0, 240);
    this.fact(ctx, eventType);
  }

  private handlePrLink(ctx: LineContext): void {
    this.fact(ctx, 'pr_link');
    const repo = str(ctx.line, 'prRepository');
    const number = int(ctx.line, 'prNumber');
    if (!repo || number <= 0) return;
    const ref = prRef(repo, number);
    this.acc.addPr({
      prRef: ref,
      number,
      repo,
      title: str(ctx.line, 'title'),
      state: null,
      url: str(ctx.line, 'prUrl'),
      mergedAt: null,
    });
    const link = { tValid: ctx.ts, factByteOffset: ctx.loc.byteOffset };
    this.acc.addEdge(
      sessionLinkedPr({ sourceRef: sessionRef(ctx.sessionId), targetRef: ref, ...link }),
    );
  }

  private handleFrameLink(ctx: LineContext): void {
    this.fact(ctx, 'frame_link');
    const url = str(ctx.line, 'frameUrl');
    if (!url) return;
    const ref = artifactRef(url);
    this.acc.addArtifact({
      artifactRef: ref,
      kind: 'frame',
      title: str(ctx.line, 'title'),
      url,
      path: str(ctx.line, 'path'),
      createdAt: ctx.ts || null,
    });
    this.acc.addEdge(
      sessionProducedArtifact({
        sourceRef: sessionRef(ctx.sessionId),
        targetRef: ref,
        tValid: ctx.ts,
        factByteOffset: ctx.loc.byteOffset,
      }),
    );
  }

  private handlePhase(ctx: LineContext, trigger: string, key: string): void {
    this.fact(ctx, trigger === 'mode' ? 'mode' : 'permission_mode');
    const toMode = str(ctx.line, key);
    if (!toMode) return;
    this.acc.permissionPhases.push({
      sessionId: ctx.sessionId,
      toMode,
      trigger,
      tValid: ctx.ts,
      factByteOffset: ctx.loc.byteOffset,
    });
  }

  /**
   * `edited_text_file` is a user-authored edit — invisible to the
   * Read/Write/Edit tool path, so it is the only signal that a human, not
   * Claude, changed a file mid-session.
   */
  private handleAttachment(ctx: LineContext): void {
    this.fact(ctx, 'attachment');
    const attachment = asObject(ctx.line.attachment);
    const filename = str(attachment, 'filename');
    if (str(attachment, 'type') !== 'edited_text_file' || !filename) return;
    const { repo, path: relative } = toRepoRelative(filename);
    if (IGNORED_PATH.test(relative)) return;
    const ref = fileRef(repo, relative);
    this.acc.addFile({ fileRef: ref, repo, path: relative });
    this.acc.humanEdits.push({
      sessionId: ctx.sessionId,
      filePath: relative,
      ts: ctx.ts,
      factByteOffset: ctx.loc.byteOffset,
    });
    this.acc.addEdge(
      humanEditedFile({
        sourceRef: sessionRef(ctx.sessionId),
        targetRef: ref,
        tValid: ctx.ts,
        factByteOffset: ctx.loc.byteOffset,
      }),
    );
  }

  /**
   * `trackedFileBackups` is full state, not a delta — the same unchanged entry
   * repeats on every later snapshot line until that file changes again. The
   * writer's unique index on (session, file, backup_file_name) is what turns
   * that repetition into a no-op instead of duplicate rows, matching `facts`.
   * No content is copied here (AW-25): `backupFileName` is a locator into
   * `~/.claude/file-history/<sessionId>/<backupFileName>`, which this indexer
   * never reads.
   */
  private handleFileHistorySnapshot(ctx: LineContext): void {
    this.fact(ctx, 'file_history_snapshot');
    const backups = asObject(asObject(ctx.line.snapshot)?.trackedFileBackups);
    if (!backups) return;
    for (const [absolutePath, value] of Object.entries(backups)) {
      const entry = asObject(value);
      const backupFileName = str(entry, 'backupFileName');
      const backupTime = str(entry, 'backupTime');
      if (!backupFileName || !backupTime) continue;
      const { path: relative } = toRepoRelative(absolutePath);
      if (IGNORED_PATH.test(relative)) continue;
      this.acc.fileCheckpoints.push({
        sessionId: ctx.sessionId,
        filePath: relative,
        backupFileName,
        version: int(entry, 'version'),
        backupTime,
        factByteOffset: ctx.loc.byteOffset,
      });
    }
  }

  private handleUser(ctx: LineContext): void {
    const message = asObject(ctx.line.message);
    const content = message?.content;
    const isPrompt = typeof content === 'string' || blocks(message).some((b) => b.type === 'text');
    if (isPrompt) return this.handleUserPrompt(ctx);

    const errored = blocks(message).some((b) => b.type === 'tool_result' && b.is_error === true);
    this.fact(ctx, errored ? 'tool_result_error' : 'tool_result');
    this.span(ctx, 'tool_result');
    this.linkDispatchedSubagent(ctx, message);
    this.recordPrCreateResult(ctx, message);
  }

  /**
   * The other half of a `gh pr create` sighting (AW-104).
   *
   * `toolUseResult.gitOperation.pr` is structured — `{number, url, action}` —
   * so the PR number is read rather than scraped out of stdout, and `action`
   * distinguishes a creation from the `edited`/`commented`/`merged`/`closed`
   * operations that share the field. The repo comes from `url`, in the same
   * `owner/name` form `pr-link` reports, so both sources mint one `pr_ref`.
   */
  private recordPrCreateResult(ctx: LineContext, message: Json | null): void {
    const pr = asObject(asObject(ctx.line.toolUseResult)?.gitOperation)?.pr;
    const created = asObject(pr);
    if (!created || str(created, 'action') !== 'created') return;
    const number = int(created, 'number');
    const repo = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/.exec(
      str(created, 'url') ?? '',
    )?.[1];
    const toolUseId = str(
      blocks(message).find((b) => b.type === 'tool_result') ?? null,
      'tool_use_id',
    );
    if (!toolUseId || !repo || number <= 0) return;
    this.acc.prCreates.push({
      toolUseId,
      title: null,
      number,
      repo,
      url: str(created, 'url'),
    });
  }

  /**
   * An async `Agent` dispatch answers with `toolUseResult.agentId`, which names
   * the subagent's transcript (`subagents/agent-<id>.jsonl`) and hence the
   * session id that transcript is indexed under. That is a different id space
   * from the `toolu_…` keying the dispatch, and this line is the only place the
   * two are stated together — so it is the only place they can be bridged.
   *
   * Synchronous dispatches carry no `agentId` here; those subagents still reach
   * their parent via the `spawned` edge written from their own transcript, just
   * without knowing which dispatch produced them.
   */
  private linkDispatchedSubagent(ctx: LineContext, message: Json | null): void {
    const agentId = str(asObject(ctx.line.toolUseResult), 'agentId');
    if (!agentId) return;
    const toolUseId = str(
      blocks(message).find((b) => b.type === 'tool_result') ?? null,
      'tool_use_id',
    );
    if (!toolUseId) return;
    this.acc.addEdge(
      subagentTranscribedIn({
        sourceRef: agentRef(toolUseId),
        targetRef: sessionRef(agentId),
        tValid: ctx.ts,
        factByteOffset: ctx.loc.byteOffset,
      }),
    );
    this.acc.addSubagentTranscript(agentRef(toolUseId), agentId);
  }

  private handleUserPrompt(ctx: LineContext): void {
    this.fact(ctx, 'user_prompt');
    this.span(ctx, 'prompt');
    const promptId = str(ctx.line, 'uuid');
    if (!promptId) return;
    this.acc.addTurn({
      promptId,
      sessionId: ctx.sessionId,
      startedAt: ctx.ts,
      endedAt: null,
      toolCallCount: 0,
      factByteOffset: ctx.loc.byteOffset,
    });
  }

  private handleAssistant(ctx: LineContext): void {
    const message = asObject(ctx.line.message);
    const content = blocks(message);
    const toolUses = content.filter((b) => b.type === 'tool_use');
    this.fact(
      ctx,
      toolUses.length > 0 ? 'tool_decision' : 'assistant_response',
      str(toolUses[0] ?? null, 'id'),
    );
    this.acc.session(ctx.sessionId).turnDelta += 1;
    this.recordUsage(ctx, message);
    if (content.some((b) => b.type === 'text')) this.span(ctx, 'assistant_response');
    if (toolUses.length > 0) this.span(ctx, 'tool_input');
    for (const block of toolUses) this.handleToolUse(ctx, block);
  }

  private recordUsage(ctx: LineContext, message: Json | null): void {
    const usage = asObject(message?.usage);
    const model = str(message, 'model');
    if (!usage || !model) return;
    const outputTokens = int(usage, 'output_tokens');
    this.acc.addUsage({
      sessionId: ctx.sessionId,
      model,
      inputTokens: int(usage, 'input_tokens'),
      outputTokens,
      cacheReadTokens: int(usage, 'cache_read_input_tokens'),
      cacheCreationTokens: int(usage, 'cache_creation_input_tokens'),
      thinkingTokens: thinkingTokens(message, outputTokens),
      requestCount: 1,
    });
  }

  private handleToolUse(ctx: LineContext, block: Json): void {
    const name = str(block, 'name');
    const input = asObject(block.input);
    if (!name) return;
    if (FILE_TOOLS.has(name)) return this.handleFileTouch(ctx, input);
    if (name === 'Agent') return this.handleAgent(ctx, block, input);
    if (name === 'Artifact') return this.handleArtifactTool(ctx, block, input);
    if (name === 'Bash') return this.handleBash(ctx, block, input);
  }

  private handleFileTouch(ctx: LineContext, input: Json | null): void {
    const raw = str(input, 'file_path') ?? str(input, 'notebook_path');
    if (!raw) return;
    const { repo, path: relative } = toRepoRelative(raw);
    if (IGNORED_PATH.test(relative)) return;
    const ref = fileRef(repo, relative);
    this.acc.addFile({ fileRef: ref, repo, path: relative });
    this.acc.addEdge(
      sessionTouchedFile({
        sourceRef: sessionRef(ctx.sessionId),
        targetRef: ref,
        tValid: ctx.ts,
        factByteOffset: ctx.loc.byteOffset,
      }),
    );
  }

  private handleAgent(ctx: LineContext, block: Json, input: Json | null): void {
    const toolUseId = str(block, 'id');
    if (!toolUseId) return;
    const ref = agentRef(toolUseId);
    this.acc.addSubagent({
      agentRef: ref,
      sessionId: ctx.sessionId,
      parentAgentRef: null,
      agentType: str(input, 'subagent_type'),
      label: str(input, 'description'),
      startedAt: ctx.ts || null,
      factByteOffset: ctx.loc.byteOffset,
    });
    this.acc.addEdge(
      sessionSpawnedSubagent({
        sourceRef: sessionRef(ctx.sessionId),
        targetRef: ref,
        tValid: ctx.ts,
        factByteOffset: ctx.loc.byteOffset,
      }),
    );
  }

  private handleArtifactTool(ctx: LineContext, block: Json, input: Json | null): void {
    const toolUseId = str(block, 'id');
    if (!toolUseId) return;
    const ref = artifactRef(toolUseId);
    this.acc.addArtifact({
      artifactRef: ref,
      kind: 'artifact',
      title: str(input, 'description'),
      url: null,
      path: str(input, 'file_path'),
      createdAt: ctx.ts || null,
    });
    this.acc.addEdge(
      sessionProducedArtifact({
        sourceRef: sessionRef(ctx.sessionId),
        targetRef: ref,
        tValid: ctx.ts,
        factByteOffset: ctx.loc.byteOffset,
      }),
    );
  }

  private handleBash(ctx: LineContext, block: Json, input: Json | null): void {
    const raw = str(input, 'command');
    if (!raw) return;
    const git = parseGitIntent(raw);
    // A git verb is attributed to the directory it runs in, which a `cd …` or
    // `git -C …` prefix can move away from the session's own cwd.
    if (git) this.recordGitIntent(ctx, git, repoForCwd(commandCwd(raw, ctx.cwd)));
    this.recordPrCreateTitle(block, raw);
    this.recordTask(ctx, realCommand(raw));
  }

  /**
   * Half of a `gh pr create` sighting: the command states the title but not the
   * number, which only exists once GitHub has answered. The tool_use id is the
   * only thing the two lines share, so it keys the observation that
   * `reconcilePrCreations` later joins them on.
   */
  private recordPrCreateTitle(block: Json, raw: string): void {
    const title = parsePrCreateTitle(raw);
    const toolUseId = str(block, 'id');
    if (!title || !toolUseId) return;
    this.acc.prCreates.push({ toolUseId, title, number: null, repo: null, url: null });
  }

  private recordGitIntent(ctx: LineContext, git: GitIntent, repo: string | null): void {
    const session = this.acc.session(ctx.sessionId);
    if (git.setBranch) this.recordBranch(ctx, git.setBranch, repo, git.branchBase);
    if (git.deletedBranch) this.recordBranchDeletion(ctx, git.deletedBranch, repo);
    if (git.commit) session.commitDelta += 1;
    if (git.push) session.pushDelta += 1;
    if (git.mergedPr) {
      this.acc.prMerges.push({ number: git.mergedPr, repoHint: repo, mergedAt: ctx.ts });
    }
  }

  private recordBranchDeletion(ctx: LineContext, name: string, repo: string | null): void {
    this.acc.addBranch({
      branchRef: branchRef(repo, name),
      repo,
      name,
      base: null,
      createdAt: null,
      deletedAt: ctx.ts || null,
    });
  }

  private recordTask(ctx: LineContext, command: string): void {
    const taskId = parseTaskId(command);
    if (!taskId) return;
    const ref = taskRef(taskId);
    this.acc.addTask({ taskRef: ref, initiative: null, title: null, status: null });
    this.acc.addEdge(
      sessionRanTask({
        sourceRef: sessionRef(ctx.sessionId),
        targetRef: ref,
        tValid: ctx.ts,
        factByteOffset: ctx.loc.byteOffset,
      }),
    );
  }
}
