/**
 * AW-23 relation vocabulary for the `edges` table.
 *
 * Deliberately documented here and NOT enforced as a DB CHECK constraint: a
 * new relation type must stay a plain `INSERT` with no migration. Direction is
 * fixed per relation name and reverse edges are never double-written — the two
 * partial indices (`idx_edges_source`, `idx_edges_target`) serve both traversal
 * directions.
 */
export const RELATIONS = {
  /** session --touched--> file: any Read/Write/Edit/MultiEdit on that path. */
  TOUCHED: 'touched',
  /** session --linked--> pr: a `pr-link` event naming that PR. */
  LINKED: 'linked',
  /** session --worked--> branch: a git/gh command naming that branch. */
  WORKED: 'worked',
  /** session --ran--> task: an `active-work`/`aw` command naming that task id. */
  RAN: 'ran',
  /**
   * session --spawned--> subagent: an `Agent` tool_use.
   *
   * Also session --spawned--> session, emitted from the subagent's own
   * sidechain transcript. The two targets are not redundant: the `agent:` one
   * is the dispatch as the parent recorded it, the `session:` one is the child
   * that actually ran. Only the latter exists for subagents whose dispatch
   * carried no `toolUseResult.agentId` to bridge them (AW-26).
   */
  SPAWNED: 'spawned',
  /**
   * subagent --transcribed_in--> session: the child transcript a dispatch
   * produced, bridged by `toolUseResult.agentId`. This is what turns the
   * `agent:` node from a dangling leaf into a waypoint, giving the full path
   * `session:parent --spawned--> agent:X --transcribed_in--> session:child`.
   */
  TRANSCRIBED_IN: 'transcribed_in',
  /** session --produced--> artifact: an `Artifact` tool_use or `frame-link`. */
  PRODUCED: 'produced',
  /** session --edited_by_human--> file: an `edited_text_file` attachment. */
  EDITED_BY_HUMAN: 'edited_by_human',
} as const;

/**
 * `built_on` (pr --built_on--> branch) was removed in AW-106. Recorded here so
 * it is not reinvented.
 *
 * It was written from the `pr-link` handler, guarded on the line's `gitBranch`.
 * A real `pr-link` line carries exactly six fields — type, sessionId, prNumber,
 * prUrl, prRepository, timestamp — and none of them is `gitBranch`, `cwd` or
 * `title`. The guard could never pass: 0 rows across 12,617 edges. The test
 * that appeared to cover it passed because the fixture's `line()` helper
 * stamped `gitBranch` onto every line type, so it asserted on a shape Claude
 * Code never emits.
 *
 * The obvious repair — join each `pr-link` to the branch the session was on at
 * that timestamp — resolves for 98.8% of sightings and is wrong. `pr-link`
 * fires whenever a PR URL is *mentioned*, not when the PR is created, so the
 * session's branch is unrelated to the PR's head and frequently in a different
 * repository: PR #103 (real head `feat/aw26-subagent-tree`) derived as `main`,
 * and PR #102 (real head `feat/aw-resume`) derived as
 * `titan-design/feat/aw22-file-history`.
 *
 * A correct PR->branch link needs a source that names the branch: the
 * `gh pr create` invocation, which bash-parse already sees. That is a new
 * extractor, not a repair of this one.
 */

export type Relation = (typeof RELATIONS)[keyof typeof RELATIONS];
