import { z } from 'zod';

/**
 * AW-23: the row shapes crossing the extractor -> writer boundary. SQLite
 * already types the columns, so these validate the handoff (and document what
 * the extractor is allowed to leave for the writer to fill in) rather than
 * mirroring every DB column.
 *
 * Locators here are `{ transcriptId, byteOffset, byteLength }` — a pointer into
 * a raw `.jsonl` transcript. Deliberately a DIFFERENT shape from AW-28's
 * positional `Locator` tuple in `src/schemas/template.ts`.
 *
 * Rows that reference a fact carry `factByteOffset` instead of a `fact_id`: the
 * extractor never sees autoincrement ids, so the writer resolves the reference
 * through `facts`' UNIQUE (transcript_id, byte_offset) index.
 */

const nonEmpty = z.string().min(1);
const offset = z.number().int().nonnegative();

export const FactInputSchema = z.object({
  byteOffset: offset,
  byteLength: offset,
  eventType: nonEmpty,
  ts: z.string(),
  sessionId: nonEmpty,
  promptId: nonEmpty.nullable().default(null),
  toolUseId: nonEmpty.nullable().default(null),
});

/**
 * `turnIndex` is assigned by the writer (the extractor resuming mid-file has no
 * idea how many turns preceded its chunk); counters accumulate across chunks.
 */
export const TurnInputSchema = z.object({
  promptId: nonEmpty,
  sessionId: nonEmpty,
  startedAt: z.string(),
  endedAt: z.string().nullable().default(null),
  toolCallCount: offset.default(0),
  factByteOffset: offset.nullable().default(null),
});

export const SessionInputSchema = z.object({
  sessionId: nonEmpty,
  startedAt: z.string().nullable().default(null),
  endedAt: z.string().nullable().default(null),
  startType: z.string().nullable().default(null),
  cwd: z.string().nullable().default(null),
  gitBranch: z.string().nullable().default(null),
  aiTitle: z.string().nullable().default(null),
  seedPrompt: z.string().nullable().default(null),
  cliVersion: z.string().nullable().default(null),
  turnDelta: offset.default(0),
  commitDelta: offset.default(0),
  pushDelta: offset.default(0),
});

/** Token *deltas* for one chunk; the writer accumulates them into the bucket. */
export const SessionModelUsageInputSchema = z.object({
  sessionId: nonEmpty,
  model: nonEmpty,
  inputTokens: offset.default(0),
  outputTokens: offset.default(0),
  cacheReadTokens: offset.default(0),
  cacheCreationTokens: offset.default(0),
  thinkingTokens: offset.default(0),
  requestCount: offset.default(0),
});

/**
 * A phase *candidate*: one per mode/permission-mode line. The writer collapses
 * runs of the same `toMode` and closes the previous open phase, so a chunk
 * boundary landing mid-run cannot fabricate an extra phase.
 */
export const PermissionPhaseInputSchema = z.object({
  sessionId: nonEmpty,
  toMode: nonEmpty,
  trigger: nonEmpty,
  tValid: z.string(),
  factByteOffset: offset.nullable().default(null),
});

export const HumanEditInputSchema = z.object({
  sessionId: nonEmpty,
  filePath: nonEmpty,
  ts: z.string(),
  linesAdded: z.number().int().nullable().default(null),
  linesRemoved: z.number().int().nullable().default(null),
  factByteOffset: offset.nullable().default(null),
});

export const FileCheckpointInputSchema = z.object({
  sessionId: nonEmpty,
  filePath: nonEmpty,
  backupFileName: nonEmpty,
  version: z.number().int(),
  backupTime: z.string(),
  factByteOffset: offset.nullable().default(null),
});

export const PrInputSchema = z.object({
  prRef: nonEmpty,
  number: z.number().int().nullable().default(null),
  repo: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  state: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  mergedAt: z.string().nullable().default(null),
});

/**
 * A `gh pr merge <n>` observation. Kept separate from `PrInput` because the
 * command only yields a bare number — the `owner/name` repo half of a `pr_ref`
 * comes solely from `pr-link` events, so the writer matches on
 * `(number, repo suffix)` instead of on a ref.
 */
export const PrMergeInputSchema = z.object({
  number: z.number().int().positive(),
  repoHint: z.string().nullable().default(null),
  mergedAt: z.string(),
});

export const BranchInputSchema = z.object({
  branchRef: nonEmpty,
  repo: z.string().nullable().default(null),
  name: nonEmpty,
  base: z.string().nullable().default(null),
  createdAt: z.string().nullable().default(null),
  deletedAt: z.string().nullable().default(null),
});

export const FileInputSchema = z.object({
  fileRef: nonEmpty,
  repo: z.string().nullable().default(null),
  path: nonEmpty,
});

export const TaskInputSchema = z.object({
  taskRef: nonEmpty,
  initiative: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
});

export const SubagentInputSchema = z.object({
  agentRef: nonEmpty,
  sessionId: nonEmpty,
  parentAgentRef: nonEmpty.nullable().default(null),
  agentType: z.string().nullable().default(null),
  label: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  factByteOffset: offset.nullable().default(null),
});

/**
 * The dispatch->child-transcript bridge, carried separately from
 * `SubagentInputSchema` because the two are stated on different lines: the
 * `Agent` tool_use creates the subagent row, its tool_result names the
 * transcript. Applied as an upsert so neither ordering nor a chunk boundary
 * between them can lose the link.
 */
export const SubagentTranscriptInputSchema = z.object({
  agentRef: nonEmpty,
  childSessionId: nonEmpty,
});

export const ArtifactInputSchema = z.object({
  artifactRef: nonEmpty,
  kind: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  path: z.string().nullable().default(null),
  createdAt: z.string().nullable().default(null),
});

export const EdgeInputSchema = z.object({
  sourceRef: nonEmpty,
  relation: nonEmpty,
  targetRef: nonEmpty,
  tValid: z.string(),
  factByteOffset: offset.nullable().default(null),
  confidence: z.number().min(0).max(1).default(1),
});

/**
 * `text` is the extractor's prose projection of the line, handed to the writer
 * for tokenizing into `spans_fts` and then dropped. It is deliberately NOT a
 * column on `searchable_spans`: that table stays a pure locator into the raw
 * JSONL, and the FTS table is contentless.
 */
export const SearchableSpanInputSchema = z.object({
  field: z.enum(['prompt', 'assistant_response', 'tool_input', 'tool_result']),
  factByteOffset: offset,
  byteOffset: offset,
  byteLength: offset,
  text: z.string().default(''),
});

export const TranscriptWatermarkSchema = z.object({
  path: nonEmpty,
  lastByteOffset: offset,
  prefixHash: z.string().nullable().default(null),
  lastIndexedAt: z.string().nullable().default(null),
  fileSize: offset.nullable().default(null),
  fileMtime: z.string().nullable().default(null),
  contentHash: z.string().nullable().default(null),
  status: z.enum(['ok', 'missing', 'hash_mismatch', 'quarantined']).default('ok'),
  quarantineReason: z.string().nullable().default(null),
});

export type FactInput = z.infer<typeof FactInputSchema>;
export type TurnInput = z.infer<typeof TurnInputSchema>;
export type SessionInput = z.infer<typeof SessionInputSchema>;
export type SessionModelUsageInput = z.infer<typeof SessionModelUsageInputSchema>;
export type PermissionPhaseInput = z.infer<typeof PermissionPhaseInputSchema>;
export type HumanEditInput = z.infer<typeof HumanEditInputSchema>;
export type FileCheckpointInput = z.infer<typeof FileCheckpointInputSchema>;
export type PrInput = z.infer<typeof PrInputSchema>;
export type PrMergeInput = z.infer<typeof PrMergeInputSchema>;
export type BranchInput = z.infer<typeof BranchInputSchema>;
export type FileInput = z.infer<typeof FileInputSchema>;
export type TaskInput = z.infer<typeof TaskInputSchema>;
export type SubagentInput = z.infer<typeof SubagentInputSchema>;
export type SubagentTranscriptInput = z.infer<typeof SubagentTranscriptInputSchema>;
export type ArtifactInput = z.infer<typeof ArtifactInputSchema>;
export type EdgeInput = z.infer<typeof EdgeInputSchema>;
export type SearchableSpanInput = z.infer<typeof SearchableSpanInputSchema>;
export type TranscriptWatermark = z.infer<typeof TranscriptWatermarkSchema>;

/** One transcript chunk's typed row batch, as produced by `extractTranscript`. */
export const ExtractResultSchema = z.object({
  /** True when a prefix-hash mismatch forced a re-read from byte 0. */
  restartedFromZero: z.boolean(),
  startByteOffset: offset,
  lastByteOffset: offset,
  prefixHash: nonEmpty,
  facts: z.array(FactInputSchema),
  turns: z.array(TurnInputSchema),
  sessions: z.array(SessionInputSchema),
  modelUsage: z.array(SessionModelUsageInputSchema),
  permissionPhases: z.array(PermissionPhaseInputSchema),
  humanEdits: z.array(HumanEditInputSchema),
  fileCheckpoints: z.array(FileCheckpointInputSchema),
  prs: z.array(PrInputSchema),
  prMerges: z.array(PrMergeInputSchema),
  branches: z.array(BranchInputSchema),
  files: z.array(FileInputSchema),
  tasks: z.array(TaskInputSchema),
  subagents: z.array(SubagentInputSchema),
  subagentTranscripts: z.array(SubagentTranscriptInputSchema),
  artifacts: z.array(ArtifactInputSchema),
  edges: z.array(EdgeInputSchema),
  spans: z.array(SearchableSpanInputSchema),
});

export type ExtractResult = z.infer<typeof ExtractResultSchema>;
