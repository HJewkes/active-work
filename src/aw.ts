#!/usr/bin/env node
/**
 * `aw` — thin launcher that bootstraps a Claude Code session for an
 * active-work initiative.
 *
 * Usage:
 *   aw [slug]        Launch claude with the bootstrap prompt and the
 *                    initiative's own directory under the active root as cwd.
 *                    Omit the slug to pick one interactively.
 *
 * For the management CLI (new, task, focus, session, etc.), use
 * `active-work`. This launcher deliberately rejects sub-command
 * invocations so the two surfaces stay distinct.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as clackPrompts from '@clack/prompts';
import newCommand from './commands/new.js';
import openCommand from './commands/open.js';
import resumeCommand from './commands/resume.js';
import { resolveLaunchCwd } from './commands/_open-helpers.js';
import { buildClaudeArgs, parseLauncherFlags } from './launcher-args.js';
import { buildLauncherEnv, withLauncherLease } from './launcher-lease.js';
import { applyProfileEnv } from './launcher-profile.js';
import { defaultTitleFromSlug, isInvalidSlugMiss, shouldOfferInit } from './launcher-init.js';
import { getActiveRoot } from './utils/paths.js';
import { formatError, EXIT, NotFoundError } from './errors.js';
import { color } from './utils/color.js';
import type { CommandContext } from './registry/index.js';

interface InitiativeSummary {
  slug: string;
  title: string;
  state: 'focused' | 'backburner' | 'paused' | 'done';
  rank?: number;
}

interface OpenSuccess {
  slug: string;
  prompt: string;
  cwd_hint: string;
  channels?: string[];
  profile?: string;
  resolved_from?: 'slug' | 'cwd';
  facet?: { name: string };
}

interface PickerResult {
  picker: true;
  initiatives: InitiativeSummary[];
}

type OpenResult = OpenSuccess | PickerResult;

function launcherContext(): CommandContext {
  return { activeRoot: getActiveRoot(), warnings: [], format: 'json', cwd: process.cwd() };
}

async function runOpen(
  opts: { slug?: string; pick?: boolean; adhoc?: boolean; init?: boolean } = {},
): Promise<OpenResult> {
  const ctx = launcherContext();
  const parsed = openCommand.args.parse({
    ...(opts.slug ? { slug: opts.slug } : {}),
    ...(opts.pick ? { pick: true } : {}),
    ...(opts.adhoc ? { adhoc: true } : {}),
    ...(opts.init ? { init: true } : {}),
    // This launcher records a `launcher` lease of its own around the spawned
    // session, so `open` must not also file a `oneshot` one — two leases for
    // one session make it its own sibling on the next bootstrap.
    lease_mode: 'defer' as const,
  });
  return (await openCommand.run(parsed, ctx)) as OpenResult;
}

/**
 * Open `slug`; when nothing matches and someone is at the terminal, offer to
 * scaffold it and open an init session instead (TP-356).
 */
async function openSlugOrInit(slug: string, adhoc: boolean): Promise<OpenSuccess> {
  try {
    return (await runOpen({ slug, adhoc })) as OpenSuccess;
  } catch (err) {
    const isTTY = Boolean(process.stdin.isTTY);
    if (shouldOfferInit({ error: err, slug, isTTY })) return initInitiative(slug, err);
    if (isTTY && isInvalidSlugMiss({ error: err, slug })) {
      throw new NotFoundError(
        `${(err as Error).message}\nTo create it, use a lowercase kebab-case slug (e.g. my-new-thing).`,
      );
    }
    throw err;
  }
}

async function initInitiative(slug: string, notFound: unknown): Promise<OpenSuccess> {
  process.stderr.write(color.dim(`${(notFound as Error).message}\n`));
  const create = await clackPrompts.confirm({
    message: `No initiative '${slug}'. Create it and start a session to set it up?`,
    initialValue: true,
  });
  if (clackPrompts.isCancel(create) || !create) throw notFound;
  const title = await clackPrompts.text({
    message: 'Title',
    initialValue: defaultTitleFromSlug(slug),
    validate: (value) => (value?.trim() ? undefined : 'A title is required.'),
  });
  if (clackPrompts.isCancel(title)) process.exit(EXIT.OK);
  const parsed = newCommand.args.parse({ slug, title: title.trim() });
  const created = await newCommand.run(parsed, launcherContext());
  process.stderr.write(color.dim(`Created ${slug} at ${created.dir}\n`));
  return (await runOpen({ slug, init: true })) as OpenSuccess;
}

const STATE_LABEL: Record<InitiativeSummary['state'], string> = {
  focused: 'focused',
  backburner: 'backburner',
  paused: 'paused',
  done: 'done',
};

async function pickInitiative(initiatives: InitiativeSummary[]): Promise<string | null> {
  if (initiatives.length === 0) {
    process.stderr.write(
      color.red('No initiatives found. Create one with `active-work new <slug>`.\n'),
    );
    return null;
  }
  const choice = await clackPrompts.select({
    message: 'Pick an initiative to open',
    options: initiatives.map((i) => {
      const rank = i.rank !== undefined ? ` · rank ${i.rank}` : '';
      return {
        value: i.slug,
        label: `${i.title} (${i.slug})`,
        hint: `${STATE_LABEL[i.state]}${rank}`,
      };
    }),
  });
  if (clackPrompts.isCancel(choice)) return null;
  return String(choice);
}

function spawnClaude(
  opened: OpenSuccess,
  cwd: string,
  remoteControl: boolean,
  leaseId?: string,
): Promise<number> {
  const { env: profileEnv, warning } = applyProfileEnv(process.env, opened.profile, (dir) =>
    existsSync(dir),
  );
  if (warning) process.stderr.write(color.yellow(`warning: ${warning}\n`));
  const claudeArgs = buildClaudeArgs(opened.prompt, opened.channels, { remoteControl });
  return new Promise((resolve) => {
    const child = spawn('claude', claudeArgs, {
      cwd,
      stdio: 'inherit',
      // Explicit env (the default is an implicit `process.env`) so the session
      // can recognize its own lease and not warn about itself.
      env: buildLauncherEnv(profileEnv, leaseId, opened.facet?.name),
    });
    child.on('error', (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        process.stderr.write(
          color.red(
            'error: `claude` not found on PATH. Install Claude Code, ' +
              'or run `active-work open <slug>` to print the prompt.\n',
          ),
        );
        resolve(127);
        return;
      }
      process.stderr.write(color.red(`error: failed to launch claude: ${err.message}\n`));
      resolve(EXIT.GENERIC);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(128 + (signal === 'SIGINT' ? 2 : 1));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

function spawnClaudeResume(sessionId: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--resume', sessionId], {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        process.stderr.write(color.red('error: `claude` not found on PATH.\n'));
        resolve(127);
        return;
      }
      process.stderr.write(color.red(`error: failed to launch claude: ${err.message}\n`));
      resolve(EXIT.GENERIC);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(128 + (signal === 'SIGINT' ? 2 : 1));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

/**
 * `aw resume <session_id>` — find the directory a session id belongs to
 * (active-work's own session log, then a direct match under
 * `~/.claude/projects`) and launch `claude --resume` there, so the caller
 * doesn't need to already know or remember where the session ran.
 */
async function runResume(argv: string[]): Promise<void> {
  const rest = argv.slice(3);
  if (rest.length !== 1 || rest[0]!.startsWith('-')) {
    process.stderr.write(color.red('usage: aw resume <session_id>\n'));
    process.exit(EXIT.USAGE);
  }
  const sessionId = rest[0]!;
  const ctx: CommandContext = {
    activeRoot: getActiveRoot(),
    warnings: [],
    format: 'json',
    cwd: process.cwd(),
  };
  try {
    const parsed = resumeCommand.args.parse({ session_id: sessionId });
    const resolved = (await resumeCommand.run(parsed, ctx)) as { cwd: string; source: string };
    process.stderr.write(
      color.dim(`Resuming ${sessionId} in ${resolved.cwd} (found via ${resolved.source}).\n`),
    );
    const code = await spawnClaudeResume(sessionId, resolved.cwd);
    process.exit(code);
  } catch (err) {
    const { message, code } = formatError(err);
    process.stderr.write(color.red(`error: ${message}\n`));
    process.exit(code);
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'aw — launch a Claude session for an active-work initiative.',
      '',
      'Usage:',
      '  aw [slug]      Bootstrap and launch a Claude session for <slug>.',
      '                 <slug> may be a facet alias (`active-work facet list`):',
      '                 it opens the owning initiative scoped to the facet.',
      '                 Omit slug to resolve the initiative from the current',
      '                 directory, falling back to an interactive picker.',
      '                 An unknown slug offers to create the initiative and',
      '                 start a session that sets it up with you.',
      '  aw --pick      Skip cwd resolution and always show the picker.',
      '  aw <slug> --adhoc',
      '                 Frame the session as ad-hoc work on the workstream',
      '                 (awaiting your task), not a handoff continuation.',
      '                 `--ad-hoc` is accepted as an alias.',
      '  aw <slug> --no-rc',
      '                 Launch without Remote Control (on by default).',
      '                 `--no-remote-control` is accepted as an alias.',
      '  aw resume <session_id>',
      "                 Find the directory a session id ran in (active-work's",
      '                 session log, then ~/.claude/projects) and resume it there.',
      '  aw --help      Show this message.',
      '  aw --version   Print version.',
      '',
      'For the full management CLI (new, task, focus, session, …) use `active-work`.',
      '',
    ].join('\n'),
  );
}

export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(EXIT.OK);
  }
  if (args.includes('--version') || args.includes('-V')) {
    process.stdout.write('0.1.0\n');
    process.exit(EXIT.OK);
  }
  if (args[0] === 'resume') {
    await runResume(argv);
    return;
  }
  // `--pick` forces the interactive picker instead of resolving from cwd;
  // `--adhoc` (alias `--ad-hoc`) reframes the prompt as ad-hoc work;
  // `--no-rc` launches without Remote Control.
  const { pick, adhoc, remoteControl, positional, usageError } = parseLauncherFlags(args);
  if (usageError) {
    process.stderr.write(
      color.red(
        'error: `aw` only launches a Claude session for an initiative. ' +
          'Use `active-work` for other commands.\n',
      ),
    );
    process.exit(EXIT.USAGE);
  }

  try {
    let opened: OpenSuccess;
    if (positional.length === 0) {
      // No slug: `open` first tries to resolve the initiative from the
      // current directory (unless `--pick`). It returns the picker list only
      // when the cwd doesn't uniquely match a worktree.
      const result = await runOpen({ pick, adhoc });
      if ('picker' in result) {
        const choice = await pickInitiative(result.initiatives);
        if (!choice) {
          process.exit(EXIT.OK);
        }
        opened = (await runOpen({ slug: choice, adhoc })) as OpenSuccess;
      } else {
        opened = result;
        process.stderr.write(color.dim(`Opening ${opened.slug} — matched current directory.\n`));
      }
    } else {
      opened = await openSlugOrInit(positional[0]!, adhoc);
      if (opened.facet) {
        process.stderr.write(color.dim(`Opening ${opened.slug} (facet ${opened.facet.name})\n`));
      }
    }
    // Not `opened.cwd_hint`: that is the dispatch answer (a registered
    // worktree, for agents that must commit). An operator's session belongs in
    // the initiative's own directory — see resolveLaunchCwd (AW-115).
    const activeRoot = getActiveRoot();
    const launchCwd = resolveLaunchCwd(activeRoot, opened.slug);
    const code = await withLauncherLease(
      {
        activeRoot,
        slug: opened.slug,
        cwd: launchCwd,
      },
      (leaseId) => spawnClaude(opened, launchCwd, remoteControl, leaseId),
    );
    process.exit(code);
  } catch (err) {
    const { message, code } = formatError(err);
    process.stderr.write(color.red(`error: ${message}\n`));
    process.exit(code);
  }
}

void main(process.argv);
