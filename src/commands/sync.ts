import os from 'node:os';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { ActiveWorkError, UsageError } from '../errors.js';
import { getGitRunner, type CommandResult } from '../utils/git-gh.js';
import { color } from '../utils/color.js';

/**
 * `active-work sync` — multi-machine git sync for the active root (AW-5).
 *
 * Runs `git pull --rebase && git push` from inside the active root so a
 * git-backed workspace stays in step across machines. Uncommitted local edits
 * are auto-committed first (this is the normal state — you just touched a
 * task), and rebase conflicts are surfaced clearly and left in place for the
 * user to resolve rather than silently aborted.
 */

const ArgsSchema = z.object({
  message: z.string().min(1).optional(),
  require_clean: z.boolean().optional(),
});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  branch: z.string(),
  committed: z.boolean(),
  committed_files: z.number().int(),
  rebased: z.boolean(),
  pushed: z.boolean(),
  summary: z.string(),
});
type Result = z.infer<typeof ResultSchema>;

export { setGitRunner, resetRunners } from '../utils/git-gh.js';

/** Run git in the active root; timeouts/spawn failures become clear errors. */
async function git(root: string, args: string[]): Promise<CommandResult> {
  return getGitRunner()('git', ['-C', root, ...args]);
}

async function assertGitRepo(root: string): Promise<void> {
  let res: CommandResult;
  try {
    res = await git(root, ['rev-parse', '--is-inside-work-tree']);
  } catch (err) {
    throw new ActiveWorkError(
      `could not run git in ${root}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.code !== 0 || res.stdout.trim() !== 'true') {
    throw new UsageError(
      `active root is not a git repository: ${root}\n` +
        'Initialize it and add a remote, then retry:\n' +
        `  git -C "${root}" init && git -C "${root}" remote add origin <url>`,
    );
  }
}

async function currentBranch(root: string): Promise<string> {
  const res = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = res.stdout.trim();
  if (res.code !== 0 || !branch || branch === 'HEAD') {
    throw new UsageError(
      'could not determine the current branch (detached HEAD?). ' +
        'Check out a branch before syncing.',
    );
  }
  return branch;
}

async function assertUpstream(root: string, branch: string): Promise<void> {
  const res = await git(root, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  if (res.code !== 0) {
    throw new UsageError(
      `branch "${branch}" has no upstream configured.\n` +
        `Set one, then retry:\n` +
        `  git -C "${root}" push -u origin ${branch}`,
    );
  }
}

/** True when the working tree (tracked or untracked) has changes to commit. */
async function isDirty(root: string): Promise<boolean> {
  const res = await git(root, ['status', '--porcelain']);
  return res.stdout.trim().length > 0;
}

function defaultMessage(): string {
  return `aw sync: ${new Date().toISOString()} (${os.hostname()})`;
}

/** Stage and commit everything. Returns the number of files committed. */
async function commitAll(root: string, message: string): Promise<number> {
  const add = await git(root, ['add', '-A']);
  if (add.code !== 0) {
    throw new ActiveWorkError(`git add failed: ${add.stderr.trim() || 'unknown error'}`);
  }
  // Nothing actually staged (e.g. only ignored files touched) — skip commit.
  const staged = await git(root, ['diff', '--cached', '--name-only']);
  const files = staged.stdout.trim().split('\n').filter(Boolean);
  if (files.length === 0) return 0;

  const commit = await git(root, ['commit', '-m', message]);
  if (commit.code !== 0) {
    throw new ActiveWorkError(`git commit failed: ${commit.stderr.trim() || 'unknown error'}`);
  }
  return files.length;
}

/** Names of files with unresolved merge conflicts. */
async function conflictedFiles(root: string): Promise<string[]> {
  const res = await git(root, ['diff', '--name-only', '--diff-filter=U']);
  return res.stdout.trim().split('\n').filter(Boolean);
}

async function headSha(root: string): Promise<string> {
  return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
}

async function pullRebase(root: string): Promise<{ rebased: boolean }> {
  // Compare HEAD before/after rather than scraping git's (version-dependent)
  // "up to date" wording: HEAD moves iff upstream actually had new commits.
  const before = await headSha(root);
  const res = await git(root, ['pull', '--rebase']);
  if (res.code === 0) {
    return { rebased: (await headSha(root)) !== before };
  }

  const conflicts = await conflictedFiles(root);
  if (conflicts.length > 0) {
    throw new ActiveWorkError(
      'sync stopped on a rebase conflict — your local changes are committed and safe.\n' +
        `Conflicted files:\n${conflicts.map((f) => `  - ${f}`).join('\n')}\n` +
        'Resolve them, then either continue or undo:\n' +
        `  git -C "${root}" add <files> && git -C "${root}" rebase --continue && aw sync\n` +
        `  git -C "${root}" rebase --abort   # to undo the pull`,
    );
  }
  throw new ActiveWorkError(
    `git pull --rebase failed: ${res.stderr.trim() || res.stdout.trim() || 'unknown error'}`,
  );
}

async function push(root: string): Promise<void> {
  const res = await git(root, ['push']);
  if (res.code !== 0) {
    throw new ActiveWorkError(
      `git push failed: ${res.stderr.trim() || res.stdout.trim() || 'unknown error'}`,
    );
  }
}

export default defineCommand<Args, Result>({
  name: 'sync',
  description:
    'Sync the active root over git: auto-commit local edits, pull --rebase, then push.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      message: {
        long: '--message',
        short: '-m',
        description: 'Commit message for the auto-commit (default: timestamp + host)',
      },
      require_clean: {
        long: '--require-clean',
        description: 'Fail instead of auto-committing when the tree is dirty',
      },
    },
  },
  async run(args, ctx) {
    const root = ctx.activeRoot;
    await assertGitRepo(root);
    const branch = await currentBranch(root);
    await assertUpstream(root, branch);

    let committed = false;
    let committedFiles = 0;
    if (await isDirty(root)) {
      if (args.require_clean) {
        throw new UsageError(
          'active root has uncommitted changes and --require-clean was given.\n' +
            'Commit or stash them, or drop --require-clean to auto-commit.',
        );
      }
      committedFiles = await commitAll(root, args.message ?? defaultMessage());
      committed = committedFiles > 0;
    }

    const { rebased } = await pullRebase(root);
    await push(root);

    const summary =
      `${committed ? `committed ${committedFiles} file(s), ` : ''}` +
      `${rebased ? 'rebased onto upstream, ' : 'already up to date, '}` +
      'pushed';
    const result: Result = {
      branch,
      committed,
      committed_files: committedFiles,
      rebased,
      pushed: true,
      summary,
    };

    if (ctx.format !== 'json') {
      process.stderr.write(color.green(`✓ sync (${branch}): ${summary}`) + '\n');
    }
    return result;
  },
});
