import { z } from 'zod';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const isValidIsoDate = (value: string): boolean => {
  if (!ISO_DATE_REGEX.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  // Reject dates like 2026-02-30 that JS happily rolls forward.
  return parsed.toISOString().slice(0, 10) === value;
};

const isoDate = z
  .string()
  .refine(isValidIsoDate, { message: 'Must be a valid zero-padded YYYY-MM-DD date' });

const positiveInt = z.number().int().positive();

// Exported so `task add` can validate a hand-edited `task_seq` against the same
// rule the brief is written with, and reject it with a message that names the
// field — whole-brief validation only ever produces an anonymous zod dump.
export const TaskSeqSchema = positiveInt;

// `worktrees` lived here until schema v4 (AW-67). It now shares one list with
// the swept worktrees in `artifacts.yml`; see `src/schemas/artifacts.ts`.

// An MCP push-channel target enabled at `aw`/`open` launch via
// `claude --dangerously-load-development-channels <target>`. Accepts an
// explicit `server:<name>` / `plugin:<name>@<marketplace>` target, or a bare
// server name that is normalized to `server:<name>` by the launcher. Exported
// so the global config schema (`utils/global-config.ts`) validates its own
// `channels` list against the same rule instead of a hand-rolled copy.
export const channelTarget = z
  .string()
  .min(1)
  .regex(/^(?:(?:server|plugin):.+|[A-Za-z0-9_-]+)$/, {
    message:
      'channel must be a target like "server:voltras", "plugin:name@marketplace", or a bare server name',
  });

export const BriefFrontmatterSchema = z
  .object({
    schema_version: positiveInt,
    title: z.string().min(1),
    updated: isoDate,
    state: z.enum(['focused', 'backburner', 'paused', 'done']),
    rank: positiveInt.optional(),
    paused_since: isoDate.optional(),
    restart_trigger: z.string().min(1).optional(),
    ship_target: z.string().optional(),
    owner: z.string().optional(),
    task_prefix: z
      .string()
      .min(1)
      .regex(/^[A-Z][A-Z0-9]*$/, {
        message: 'task_prefix must be uppercase letters/digits starting with a letter',
      }),
    channels: z.array(channelTarget).optional(),
    // High-water mark for task ids: the largest numeric suffix ever issued
    // for this initiative's task_prefix. Optional so pre-existing brief.md
    // files (written before this field existed) keep validating; task.add
    // falls back to scanning on-disk task files when it's absent. Only
    // task.delete writes this field (AW-94) — and only when removing the
    // current highest id — so task.add itself never rewrites brief.md.
    task_seq: TaskSeqSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.state === 'focused' && value.rank === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['rank'],
        message: 'rank is required when state is "focused"',
      });
    }
    if (value.state === 'paused') {
      if (value.paused_since === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['paused_since'],
          message: 'paused_since is required when state is "paused"',
        });
      }
      if (value.restart_trigger === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['restart_trigger'],
          message: 'restart_trigger is required when state is "paused"',
        });
      }
    }
  });

export type BriefFrontmatter = z.infer<typeof BriefFrontmatterSchema>;
