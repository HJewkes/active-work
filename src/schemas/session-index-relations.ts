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
  /** pr --built_on--> branch: the branch checked out when the PR was linked. */
  BUILT_ON: 'built_on',
  /** session --worked--> branch: a git/gh command naming that branch. */
  WORKED: 'worked',
  /** session --ran--> task: an `active-work`/`aw` command naming that task id. */
  RAN: 'ran',
  /** session --spawned--> subagent: an `Agent` tool_use. */
  SPAWNED: 'spawned',
  /** session --produced--> artifact: an `Artifact` tool_use or `frame-link`. */
  PRODUCED: 'produced',
  /** session --edited_by_human--> file: an `edited_text_file` attachment. */
  EDITED_BY_HUMAN: 'edited_by_human',
} as const;

export type Relation = (typeof RELATIONS)[keyof typeof RELATIONS];
