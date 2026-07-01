#!/usr/bin/env node
/**
 * `aw` — thin launcher that bootstraps a Claude Code session for an
 * active-work initiative.
 *
 * Usage:
 *   aw [slug]        Launch claude with the bootstrap prompt and the
 *                    initiative's worktree as cwd. Omit the slug to pick
 *                    one interactively.
 *
 * For the management CLI (new, task, focus, session, etc.), use
 * `active-work`. This launcher deliberately rejects sub-command
 * invocations so the two surfaces stay distinct.
 */
import { spawn } from 'node:child_process';
import * as clackPrompts from '@clack/prompts';
import openCommand from './commands/open.js';
import { buildClaudeArgs } from './launcher-args.js';
import { getActiveRoot } from './utils/paths.js';
import { formatError, EXIT } from './errors.js';
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
}

interface PickerResult {
  picker: true;
  initiatives: InitiativeSummary[];
}

type OpenResult = OpenSuccess | PickerResult;

async function runOpen(slug?: string): Promise<OpenResult> {
  const ctx: CommandContext = {
    activeRoot: getActiveRoot(),
    warnings: [],
    format: 'json',
  };
  const parsed = openCommand.args.parse(slug ? { slug } : {});
  return (await openCommand.run(parsed, ctx)) as OpenResult;
}

const STATE_LABEL: Record<InitiativeSummary['state'], string> = {
  focused: 'focused',
  backburner: 'backburner',
  paused: 'paused',
  done: 'done',
};

async function pickInitiative(
  initiatives: InitiativeSummary[],
): Promise<string | null> {
  if (initiatives.length === 0) {
    process.stderr.write(
      color.red(
        'No initiatives found. Create one with `active-work new <slug>`.\n',
      ),
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
  prompt: string,
  cwd: string,
  channels?: string[],
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('claude', buildClaudeArgs(prompt, channels), {
      cwd,
      stdio: 'inherit',
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
      process.stderr.write(
        color.red(`error: failed to launch claude: ${err.message}\n`),
      );
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

function printHelp(): void {
  process.stdout.write(
    [
      'aw — launch a Claude session for an active-work initiative.',
      '',
      'Usage:',
      '  aw [slug]      Bootstrap and launch a Claude session for <slug>.',
      '                 Omit slug to pick interactively.',
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
  if (args.some((a) => a.startsWith('-')) || args.length > 1) {
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
    if (args.length === 0) {
      const picker = (await runOpen()) as PickerResult;
      const choice = await pickInitiative(picker.initiatives);
      if (!choice) {
        process.exit(EXIT.OK);
      }
      opened = (await runOpen(choice)) as OpenSuccess;
    } else {
      opened = (await runOpen(args[0])) as OpenSuccess;
    }
    const code = await spawnClaude(
      opened.prompt,
      opened.cwd_hint,
      opened.channels,
    );
    process.exit(code);
  } catch (err) {
    const { message, code } = formatError(err);
    process.stderr.write(color.red(`error: ${message}\n`));
    process.exit(code);
  }
}

void main(process.argv);
