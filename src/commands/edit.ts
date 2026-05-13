import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { z } from 'zod';
import { BriefFrontmatterSchema } from '../schemas/brief.js';
import { getInitiativeDir } from '../utils/paths.js';
import { readFrontmatter } from '../utils/gray-matter-io.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  target: z.enum(['brief', 'handoff']),
});

const ResultSchema = z.object({
  slug: z.string(),
  target: z.enum(['brief', 'handoff']),
  file: z.string(),
  validated: z.boolean(),
  aborted: z.boolean().optional(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export interface EditorCommand {
  command: string;
  args: string[];
}

export type EditorResolver = (filePath: string) => Promise<EditorCommand>;

export type EditorSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => Promise<number>;

/**
 * Resolve which editor to launch using the cascading fallback:
 *   1. `$EDITOR` (invoked via `sh -c` so multi-token values like
 *      `nvim --noplugin` split correctly).
 *   2. `code --wait` when the `code` binary resolves on PATH.
 *   3. `vi` as the universal last resort.
 */
export async function resolveEditor(filePath: string): Promise<EditorCommand> {
  const editorEnv = process.env.EDITOR;
  if (editorEnv && editorEnv.length > 0) {
    return { command: 'sh', args: ['-c', '$EDITOR "$0"', filePath] };
  }
  if (await commandExists('code')) {
    return { command: 'code', args: ['--wait', filePath] };
  }
  return { command: 'vi', args: [filePath] };
}

async function commandExists(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', `command -v ${name}`], {
      stdio: 'ignore',
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Default child-process spawner. Inherits stdio so the editor takes
 * over the operator's TTY, and resolves with the exit code on close.
 */
export const defaultSpawner: EditorSpawner = (command, args, options) => {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, options);
    } catch (err) {
      reject(err);
      return;
    }
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
};

export interface RunEditDeps {
  resolveEditor: EditorResolver;
  spawner: EditorSpawner;
}

const defaultDeps: RunEditDeps = {
  resolveEditor,
  spawner: defaultSpawner,
};

function targetFile(slug: string, target: Args['target']): string {
  const dir = getInitiativeDir(slug);
  return path.join(dir, target === 'brief' ? 'brief.md' : 'handoff.md');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function runEdit(
  args: Args,
  deps: RunEditDeps = defaultDeps,
): Promise<Result> {
  const file = targetFile(args.slug, args.target);
  if (!(await fileExists(file))) {
    throw new NotFoundError(
      `${args.target}.md not found for initiative "${args.slug}" (expected ${file})`,
    );
  }

  const editor = await deps.resolveEditor(file);
  const exitCode = await deps.spawner(editor.command, editor.args, {
    stdio: 'inherit',
  });

  if (exitCode !== 0) {
    return {
      slug: args.slug,
      target: args.target,
      file,
      validated: false,
      aborted: true,
    };
  }

  if (args.target === 'brief') {
    try {
      await readFrontmatter(file, BriefFrontmatterSchema);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `Brief frontmatter is invalid after editing. Re-run \`active-work edit ${args.slug} brief\` to fix.\n${message}`,
        { cause: err },
      );
    }
  } else if (!(await fileExists(file))) {
    throw new NotFoundError(
      `handoff.md disappeared during edit (expected ${file})`,
    );
  }

  return {
    slug: args.slug,
    target: args.target,
    file,
    validated: true,
  };
}

const edit = defineCommand<Args, Result>({
  name: 'edit',
  description: "Open the operator's editor on brief.md or handoff.md.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug', 'target'],
    usage: 'active-work edit <slug> <brief|handoff>',
  },
  async run(args) {
    return runEdit(args);
  },
});

export default edit;
