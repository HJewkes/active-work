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
const RE_SWITCH = new RegExp(
  '\\bgit\\s+(?:-C\\s+\\S+\\s+)?(?:checkout|switch)\\s+(?![-\\d])' + BRANCH,
);
const RE_WORKTREE = new RegExp('\\bgit\\s+worktree\\s+add\\b[^&|;]*?\\s-b\\s+' + BRANCH);
const RE_PUSH_BRANCH = new RegExp('\\bgit\\s+push\\b[^&|;]*?\\borigin\\s+(?:-u\\s+)?' + BRANCH);
const RE_PR_HEAD = new RegExp('\\bgh\\s+pr\\s+create\\b[^&|;]*?--head\\s+' + BRANCH);
const RE_MERGE = /\bgh\s+pr\s+merge\s+(\d+)/;

/**
 * The start-point of `git checkout -b <new> <start>` (AW-104).
 *
 * `[^\S\n]` — whitespace that is not a newline — rather than `\s` throughout:
 * `git checkout -b feat/x` followed on the NEXT LINE by `git add -A` otherwise
 * captures `git` as the start point. Requiring the token to be followed by
 * horizontal space or end-of-line is what rejects the `2` of a trailing
 * `2>&1`, which is the single most common thing in this position.
 */
const RE_NEW_WITH_START = new RegExp(
  '\\bgit[^\\S\\n]+(?:-C[^\\S\\n]+\\S+[^\\S\\n]+)?' +
    '(?:checkout[^\\S\\n]+-[bB]|switch[^\\S\\n]+-c)[^\\S\\n]+' +
    BRANCH +
    '(?:[^\\S\\n]+([A-Za-z0-9._/-]+)(?=[^\\S\\n]|$))?',
);

/**
 * `gh pr create --base <branch>` — the head branch's base, stated outright.
 *
 * This is the source AW-106 said a correct PR/branch link needs. Unlike the
 * temporal join it replaced, nothing is inferred: one command names both ends,
 * so a `cd` into another repo cannot misattribute it.
 */
const RE_PR_BASE = new RegExp('\\bgh\\s+pr\\s+create\\b[^&|;]*?--base[=\\s]+' + BRANCH);
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
  /** The branch `setBranch` was created from, when the command says so. */
  branchBase: string | null;
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

/** A branch sighting plus, where the same command states it, what it forked from. */
interface BranchCapture {
  name: string | undefined;
  base: string | null;
}

function baseOrNull(candidate: string | undefined): string | null {
  const cleaned = cleanBranch(candidate);
  return isRealBranch(cleaned) ? cleaned : null;
}

/**
 * A base is only ever read from the SAME command that named the branch.
 *
 * `git checkout -b x && gh pr create --head y --base main` names two different
 * branches; taking the base from whichever regex happened to match would
 * attach `main` to `x`. Each capture therefore carries its own base or none —
 * which is also why this returns a pair instead of the caller reaching for
 * `RE_PR_BASE` after the fact.
 */
function captureBranch(raw: string): BranchCapture {
  const created = RE_NEW_WITH_START.exec(raw);
  // A heredoc body is data, not commands: the only start-point this ever found
  // inside one was a fragment of a quoted source file.
  if (created)
    return { name: created[1], base: raw.includes('<<') ? null : baseOrNull(created[2]) };

  const worktree = RE_WORKTREE.exec(raw);
  if (worktree) return { name: worktree[1], base: null };

  const prHead = RE_PR_HEAD.exec(raw);
  if (prHead) return { name: prHead[1], base: baseOrNull(RE_PR_BASE.exec(raw)?.[1]) };

  return { name: (RE_PUSH_BRANCH.exec(raw) ?? RE_SWITCH.exec(raw))?.[1], base: null };
}

export function parseGitIntent(raw: string): GitIntent | null {
  if (!raw.includes('git') && !raw.includes('gh ')) return null;

  const branch = captureBranch(raw);
  const captured = cleanBranch(branch.name);
  const setBranch = isRealBranch(captured) ? captured : null;
  const deleted = cleanBranch(RE_DELETE.exec(raw)?.[1]);
  const mergedPr = RE_MERGE.exec(raw)?.[1];

  return {
    setBranch,
    // A branch is never its own base: `gh pr create --head x --base x` is not a
    // real shape, but a mis-parse producing one would be a self-loop.
    branchBase: setBranch && branch.base !== setBranch ? branch.base : null,
    deletedBranch: deleted.length > 0 ? deleted : null,
    mergedPr: mergedPr ? Number(mergedPr) : null,
    commit: RE_COMMIT.test(raw),
    push: RE_PUSH.test(raw),
  };
}

/**
 * The `--title` of a `gh pr create`, which is the only place a PR title is
 * stated (AW-104).
 *
 * The title is read out of a shell command, so it still carries that command's
 * quoting: inside double quotes a backtick is written `\``, and storing it raw
 * puts a backslash in the title that GitHub never saw. Only the five characters
 * the shell actually treats as escapable in double quotes are unescaped, and
 * single-quoted titles are taken verbatim, because there `\` is a literal.
 */
export function parsePrCreateTitle(raw: string): string | null {
  if (!raw.includes('gh ')) return null;
  // The double-quoted arm consumes `\"` as a unit; a non-greedy `[\s\S]*?` ends
  // the title at the first escaped quote inside it instead.
  const match =
    /\bgh\s+pr\s+create\b[\s\S]*?--title[=\s]+(?:"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+))/.exec(raw);
  if (!match) return null;
  const [, doubleQuoted, singleQuoted, bare] = match;
  if (doubleQuoted !== undefined) return doubleQuoted.replace(/\\(["$`\\\n])/g, '$1');
  return singleQuoted ?? bare ?? null;
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
