import type { ExtractAccumulator } from './accumulator.js';
import type { RawLine } from './json-lines.js';
import { IGNORED_PATH, parseGitIntent, parseTaskId, realCommand } from './bash-parse.js';
import type { GitIntent } from './bash-parse.js';
import {
  agentRef,
  artifactRef,
  branchRef,
  fileRef,
  humanEditedFile,
  prBuiltOnBranch,
  prRef,
  sessionLinkedPr,
  sessionProducedArtifact,
  sessionRanTask,
  sessionRef,
  sessionSpawnedSubagent,
  sessionTouchedFile,
  sessionWorkedBranch,
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
  constructor(private readonly acc: ExtractAccumulator) {}

  handle(line: Json, loc: RawLine): void {
    const sessionId = str(line, 'sessionId');
    if (!sessionId) return;
    const branch = str(line, 'gitBranch');
    const cwd = str(line, 'cwd');
    const ctx: LineContext = {
      line,
      loc,
      sessionId,
      ts: str(line, 'timestamp') ?? '',
      cwd,
      gitBranch: branch === 'HEAD' ? null : branch,
      repo: cwd ? cwd.split('/').pop() || null : null,
    };
    this.observeSession(ctx);
    this.dispatch(ctx, str(line, 'type') ?? 'unknown');
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
      agentId: str(ctx.line, 'agentId'),
      parentAgentId: str(ctx.line, 'parentAgentId'),
      workflowRunId: str(ctx.line, 'workflowRunId'),
    });
  }

  /** Line-granular span: the locator addresses the whole JSONL record. */
  private span(
    ctx: LineContext,
    field: 'prompt' | 'assistant_response' | 'tool_input' | 'tool_result',
  ): void {
    this.acc.spans.push({
      field,
      factByteOffset: ctx.loc.byteOffset,
      byteOffset: ctx.loc.byteOffset,
      byteLength: ctx.loc.byteLength,
    });
  }

  private observeSession(ctx: LineContext): void {
    const session = this.acc.session(ctx.sessionId);
    this.acc.observeSessionTimestamp(ctx.sessionId, ctx.ts || null);
    session.cwd = ctx.cwd ?? session.cwd;
    session.cliVersion = str(ctx.line, 'version') ?? session.cliVersion;
    if (!ctx.gitBranch) return;
    session.gitBranch = ctx.gitBranch;
    this.recordBranch(ctx, ctx.gitBranch);
  }

  private recordBranch(ctx: LineContext, name: string): string {
    const ref = branchRef(ctx.repo, name);
    this.acc.addBranch({
      branchRef: ref,
      repo: ctx.repo,
      name,
      base: null,
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
    if (key === 'aiTitle') session.aiTitle = value;
    else session.seedPrompt = value.slice(0, 240);
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
    if (ctx.gitBranch) {
      this.acc.addEdge(
        prBuiltOnBranch({ sourceRef: ref, targetRef: branchRef(ctx.repo, ctx.gitBranch), ...link }),
      );
    }
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
    const { repo, path: relative } = toRepoRelative(ctx.cwd, filename);
    if (IGNORED_PATH.test(relative)) return;
    const ref = fileRef(repo, relative);
    this.acc.addFile({ fileRef: ref, repo, path: relative });
    this.acc.humanEdits.push({
      sessionId: ctx.sessionId,
      filePath: relative,
      ts: ctx.ts,
      linesAdded: null,
      linesRemoved: null,
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

  private handleUser(ctx: LineContext): void {
    const message = asObject(ctx.line.message);
    const content = message?.content;
    const isPrompt = typeof content === 'string' || blocks(message).some((b) => b.type === 'text');
    if (isPrompt) return this.handleUserPrompt(ctx);

    const errored = blocks(message).some((b) => b.type === 'tool_result' && b.is_error === true);
    this.fact(ctx, errored ? 'tool_result_error' : 'tool_result');
    this.span(ctx, 'tool_result');
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
    this.acc.addUsage({
      sessionId: ctx.sessionId,
      model,
      inputTokens: int(usage, 'input_tokens'),
      outputTokens: int(usage, 'output_tokens'),
      cacheReadTokens: int(usage, 'cache_read_input_tokens'),
      cacheCreationTokens: int(usage, 'cache_creation_input_tokens'),
      thinkingTokens: 0,
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
    if (name === 'Bash') return this.handleBash(ctx, input);
  }

  private handleFileTouch(ctx: LineContext, input: Json | null): void {
    const raw = str(input, 'file_path') ?? str(input, 'notebook_path');
    if (!raw) return;
    const { repo, path: relative } = toRepoRelative(ctx.cwd, raw);
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

  private handleBash(ctx: LineContext, input: Json | null): void {
    const raw = str(input, 'command');
    if (!raw) return;
    const git = parseGitIntent(raw);
    if (git) this.recordGitIntent(ctx, git);
    this.recordTask(ctx, realCommand(raw));
  }

  private recordGitIntent(ctx: LineContext, git: GitIntent): void {
    const session = this.acc.session(ctx.sessionId);
    if (git.setBranch) this.recordBranch(ctx, git.setBranch);
    if (git.deletedBranch) this.recordBranchDeletion(ctx, git.deletedBranch);
    if (git.commit) session.commitDelta += 1;
    if (git.push) session.pushDelta += 1;
    if (git.mergedPr) {
      this.acc.prMerges.push({ number: git.mergedPr, repoHint: ctx.repo, mergedAt: ctx.ts });
    }
  }

  private recordBranchDeletion(ctx: LineContext, name: string): void {
    this.acc.addBranch({
      branchRef: branchRef(ctx.repo, name),
      repo: ctx.repo,
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
