import type {
  ArtifactInput,
  BranchInput,
  EdgeInput,
  ExtractResult,
  FactInput,
  FileCheckpointInput,
  FileInput,
  HumanEditInput,
  PermissionPhaseInput,
  PrInput,
  PrMergeInput,
  SearchableSpanInput,
  SessionInput,
  SessionModelUsageInput,
  SubagentInput,
  TaskInput,
  TurnInput,
} from '../../schemas/session-index.js';

/**
 * In-memory collector for one transcript chunk's typed rows.
 *
 * Asset rows are keyed by their `*_ref` so a chunk emits each asset once;
 * session and per-model usage rows merge in an order-stable way (min/max for
 * timestamps, sums for counters, last-non-null for descriptive fields) so that
 * applying N chunks yields exactly what applying one whole-file pass would.
 */
export class ExtractAccumulator {
  readonly facts: FactInput[] = [];
  readonly permissionPhases: PermissionPhaseInput[] = [];
  readonly humanEdits: HumanEditInput[] = [];
  readonly fileCheckpoints: FileCheckpointInput[] = [];
  readonly spans: SearchableSpanInput[] = [];
  readonly prMerges: PrMergeInput[] = [];

  private readonly sessions = new Map<string, SessionInput>();
  private readonly usage = new Map<string, SessionModelUsageInput>();
  private readonly turns = new Map<string, TurnInput>();
  private readonly prs = new Map<string, PrInput>();
  private readonly branches = new Map<string, BranchInput>();
  private readonly files = new Map<string, FileInput>();
  private readonly tasks = new Map<string, TaskInput>();
  private readonly subagents = new Map<string, SubagentInput>();
  private readonly subagentTranscripts = new Map<string, string>();
  private readonly artifacts = new Map<string, ArtifactInput>();
  private readonly edges = new Map<string, EdgeInput>();

  session(sessionId: string): SessionInput {
    let existing = this.sessions.get(sessionId);
    if (!existing) {
      existing = {
        sessionId,
        startedAt: null,
        endedAt: null,
        startType: null,
        cwd: null,
        gitBranch: null,
        aiTitle: null,
        seedPrompt: null,
        cliVersion: null,
        turnDelta: 0,
        commitDelta: 0,
        pushDelta: 0,
      };
      this.sessions.set(sessionId, existing);
    }
    return existing;
  }

  observeSessionTimestamp(sessionId: string, ts: string | null): void {
    if (!ts) return;
    const s = this.session(sessionId);
    if (!s.startedAt || ts < s.startedAt) s.startedAt = ts;
    if (!s.endedAt || ts > s.endedAt) s.endedAt = ts;
  }

  addUsage(delta: SessionModelUsageInput): void {
    const key = `${delta.sessionId}\0${delta.model}`;
    const existing = this.usage.get(key);
    if (!existing) {
      this.usage.set(key, { ...delta });
      return;
    }
    existing.inputTokens += delta.inputTokens;
    existing.outputTokens += delta.outputTokens;
    existing.cacheReadTokens += delta.cacheReadTokens;
    existing.cacheCreationTokens += delta.cacheCreationTokens;
    existing.thinkingTokens += delta.thinkingTokens;
    existing.requestCount += delta.requestCount;
  }

  addTurn(turn: TurnInput): void {
    if (!this.turns.has(turn.promptId)) this.turns.set(turn.promptId, turn);
  }

  addPr(pr: PrInput): void {
    this.prs.set(pr.prRef, mergeFirstNonNull(this.prs.get(pr.prRef), pr));
  }

  /**
   * Timestamps merge as MIN/MAX rather than first-wins, matching the writer's
   * branch upsert — a branch is observed from many chunks and many transcripts,
   * so "the first observation in this batch" is not a stable value.
   */
  addBranch(branch: BranchInput): void {
    const existing = this.branches.get(branch.branchRef);
    const merged = mergeFirstNonNull(existing, branch);
    merged.createdAt = earliest(existing?.createdAt, branch.createdAt);
    merged.deletedAt = latest(existing?.deletedAt, branch.deletedAt);
    this.branches.set(branch.branchRef, merged);
  }

  addFile(file: FileInput): void {
    if (!this.files.has(file.fileRef)) this.files.set(file.fileRef, file);
  }

  addTask(task: TaskInput): void {
    if (!this.tasks.has(task.taskRef)) this.tasks.set(task.taskRef, task);
  }

  addSubagent(subagent: SubagentInput): void {
    if (!this.subagents.has(subagent.agentRef)) this.subagents.set(subagent.agentRef, subagent);
  }

  addSubagentTranscript(agentRef: string, childSessionId: string): void {
    if (!this.subagentTranscripts.has(agentRef))
      this.subagentTranscripts.set(agentRef, childSessionId);
  }

  addArtifact(artifact: ArtifactInput): void {
    if (!this.artifacts.has(artifact.artifactRef))
      this.artifacts.set(artifact.artifactRef, artifact);
  }

  /** Current-state edges are unique on (source, relation, target); keep the first. */
  addEdge(edge: EdgeInput): void {
    const key = `${edge.sourceRef}\0${edge.relation}\0${edge.targetRef}`;
    if (!this.edges.has(key)) this.edges.set(key, edge);
  }

  toResult(
    head: Pick<
      ExtractResult,
      'restartedFromZero' | 'startByteOffset' | 'lastByteOffset' | 'prefixHash'
    >,
  ): ExtractResult {
    return {
      ...head,
      facts: this.facts,
      turns: [...this.turns.values()],
      sessions: [...this.sessions.values()],
      modelUsage: [...this.usage.values()],
      permissionPhases: this.permissionPhases,
      humanEdits: this.humanEdits,
      fileCheckpoints: this.fileCheckpoints,
      prs: [...this.prs.values()],
      prMerges: this.prMerges,
      branches: [...this.branches.values()],
      files: [...this.files.values()],
      tasks: [...this.tasks.values()],
      subagents: [...this.subagents.values()],
      subagentTranscripts: [...this.subagentTranscripts].map(([agentRef, childSessionId]) => ({
        agentRef,
        childSessionId,
      })),
      artifacts: [...this.artifacts.values()],
      edges: [...this.edges.values()],
      spans: this.spans,
    };
  }
}

/**
 * First non-null observation wins, matching the writer's
 * `COALESCE(existing, excluded)` upserts — so merge order never changes the
 * stored row, whatever chunk boundary the asset straddles.
 */
function earliest(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a < b ? a : b;
}

function latest(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

function mergeFirstNonNull<T extends object>(existing: T | undefined, incoming: T): T {
  if (!existing) return incoming;
  const kept = Object.entries(existing).filter(([, v]) => v !== null);
  return { ...incoming, ...Object.fromEntries(kept) } as T;
}
