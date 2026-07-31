/**
 * Deterministic intent extraction from raw (often compound) Bash commands —
 * ported behavior-preservingly from the AW-22 prototype
 * (`tools/mine-session-signals.mjs`).
 */

import os from 'node:os';
import path from 'node:path';

/** Build artifacts and vendored trees are never interesting file touches. */
export const IGNORED_PATH =
  /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|\.turbo|storybook-static)(\/|$)/;

export const TASK_ID = /\b([A-Z]{1,5}-\d+)\b/;

/** A branch-name capture (unquoted token). */
const BRANCH = '[\'"]?([^\\s\'"&|;]+)';
const RE_NEW = new RegExp(
  '\\bgit\\s+(?:-C\\s+\\S+\\s+)?(?:checkout\\s+-[bB]|switch\\s+-c)\\s+' + BRANCH,
);
const RE_SWITCH = new RegExp(
  '\\bgit\\s+(?:-C\\s+\\S+\\s+)?(?:checkout|switch)\\s+(?![-\\d])' + BRANCH,
);
const RE_WORKTREE = new RegExp('\\bgit\\s+worktree\\s+add\\b[^&|;]*?\\s-b\\s+' + BRANCH);
const RE_PUSH_BRANCH = new RegExp('\\bgit\\s+push\\b[^&|;]*?\\borigin\\s+(?:-u\\s+)?' + BRANCH);
const RE_PR_HEAD = new RegExp('\\bgh\\s+pr\\s+create\\b[^&|;]*?--head\\s+' + BRANCH);
const RE_MERGE = /\bgh\s+pr\s+merge\s+(\d+)/;
const RE_DELETE = new RegExp('\\bgit\\s+branch\\s+-[dD]\\s+' + BRANCH);
const RE_COMMIT = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;
const RE_PUSH = /\bgit\s+(?:-C\s+\S+\s+)?push\b/;

/** Strip leading `cd X && …` so we reach the real command verb. */
export function realCommand(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 4; i++) {
    const m = s.match(/^cd\s+[^&;]+(?:&&|;)\s*/);
    if (!m) break;
    s = s.slice(m[0].length).trim();
  }
  return s;
}

/**
 * The directory a compound command's git verb actually runs in.
 *
 * `cd ~/projects/x && git checkout -b feat/y` is the dominant shape in this
 * corpus, and the session's own `cwd` is frequently somewhere else entirely —
 * a state directory, a scratch dir. Attributing the branch to the session's
 * `cwd` therefore named the wrong repo, or none (AW-91). `git -C <dir>` wins
 * over a leading `cd` because it is the more specific of the two.
 */
export function commandCwd(raw: string, sessionCwd: string | null): string | null {
  const dashC = raw.match(/\bgit\s+-C\s+(\S+)/)?.[1];
  const cd = raw.trim().match(/^cd\s+([^&;|]+?)\s*(?:&&|;|$)/)?.[1];
  const target = (dashC ?? cd)?.trim().replace(/^['"]|['"]$/g, '');
  if (!target) return sessionCwd;
  const expanded = target.startsWith('~/') ? path.join(os.homedir(), target.slice(2)) : target;
  if (path.isAbsolute(expanded)) return expanded;
  return sessionCwd ? path.resolve(sessionCwd, expanded) : null;
}

export interface GitIntent {
  setBranch: string | null;
  deletedBranch: string | null;
  mergedPr: number | null;
  commit: boolean;
  push: boolean;
}

function cleanBranch(name: string | undefined): string {
  return (name ?? '').replace(/^origin\//, '').replace(/['"]/g, '');
}

/** A capture that is really a ref/flag rather than a branch name. */
function isRealBranch(name: string): boolean {
  return (
    name.length > 0 &&
    name !== 'HEAD' &&
    name !== '/' &&
    !name.startsWith('-') &&
    !name.includes(':')
  );
}

export function parseGitIntent(raw: string): GitIntent | null {
  if (!raw.includes('git') && !raw.includes('gh ')) return null;

  const captured = cleanBranch(
    (RE_NEW.exec(raw) ??
      RE_WORKTREE.exec(raw) ??
      RE_PR_HEAD.exec(raw) ??
      RE_PUSH_BRANCH.exec(raw) ??
      RE_SWITCH.exec(raw))?.[1],
  );
  const deleted = cleanBranch(RE_DELETE.exec(raw)?.[1]);
  const mergedPr = RE_MERGE.exec(raw)?.[1];

  return {
    setBranch: isRealBranch(captured) ? captured : null,
    deletedBranch: deleted.length > 0 ? deleted : null,
    mergedPr: mergedPr ? Number(mergedPr) : null,
    commit: RE_COMMIT.test(raw),
    push: RE_PUSH.test(raw),
  };
}

/**
 * The task id an `active-work`/`aw` invocation acts on, if any. Unlike the
 * prototype this is NOT scoped to one initiative's slug: the production index
 * spans every initiative and repo-scoping is a query-time concern.
 */
export function parseTaskId(command: string): string | null {
  const words = command.split(/\s+/);
  if (words[0] !== 'active-work' && words[0] !== 'aw') return null;
  return TASK_ID.exec(command)?.[1] ?? null;
}
