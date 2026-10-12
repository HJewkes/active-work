import path from 'node:path';
import {
  costPerOutcome,
  costPerOutcomeSchema,
  renderCostPerOutcomeText,
  type ReportWindow,
} from '@titan-design/session-analytics';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { readDispatchRecords, type DispatchSkipped } from '../session-index/dispatch-records.js';
import { defaultGraphPath, openGraphReadOnly } from '../session-index/graph.js';
import { getInitiativeDir } from '../utils/paths.js';

/**
 * `active-work miner outcomes` — what each merged and done outcome cost, per
 * seat, kind, initiative and value (TP-513). Seat dispatch logs supply the
 * assignments; `@titan-design/session-analytics` joins them to graph spend.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const ArgsSchema = z.object({
  days: z.coerce.number().int().positive().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  logs: z.string().optional(),
});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = costPerOutcomeSchema.extend({
  skipped: z.object({
    badLines: z.number().int().nonnegative(),
    noAgent: z.number().int().nonnegative(),
  }),
});
type Result = z.infer<typeof ResultSchema>;

function defaultLogsDir(): string {
  return path.join(getInitiativeDir('claude-channels'), 'sources', 'autonomy', 'logs');
}

/** The graph compares `ts` as strings, so an offset bound like `-06:00` must become UTC `Z` first. */
function toUtc(value: string, flag: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${flag}: not a valid date or ISO timestamp: ${value}`);
  return new Date(ms).toISOString();
}

function resolveOutcomeWindow(args: Args, now: Date = new Date()): ReportWindow {
  const until = args.until === undefined ? null : toUtc(args.until, '--until');
  if (args.since !== undefined) return { since: toUtc(args.since, '--since'), until };
  if (args.days === undefined) return { since: null, until };
  const end = until ? Date.parse(until) : now.getTime();
  return { since: new Date(end - args.days * DAY_MS).toISOString(), until };
}

function skippedLine({ badLines, noAgent }: DispatchSkipped): string {
  if (badLines === 0 && noAgent === 0) return '';
  return `Skipped: ${badLines} unparseable lines, ${noAgent} rows without an agent.\n`;
}

export default defineCommand<Args, Result>({
  name: 'miner.outcomes',
  description:
    'Report what each merged and done seat dispatch outcome cost, per seat, kind, initiative and value.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      days: {
        long: '--days',
        description: 'Window length in days, ending now (or --until). Overridden by --since.',
      },
      since: {
        long: '--since',
        description: 'ISO timestamp or date, inclusive. Overrides --days.',
      },
      until: { long: '--until', description: 'ISO timestamp or date, exclusive.' },
      logs: {
        long: '--logs',
        description:
          'Seat log root holding <seat>/dispatch.jsonl (default <activeRoot>/claude-channels/sources/autonomy/logs).',
      },
    },
  },
  async run(args, ctx) {
    const window = resolveOutcomeWindow(args);
    const { assignments, skipped } = readDispatchRecords(args.logs ?? defaultLogsDir(), window);
    const db = openGraphReadOnly(defaultGraphPath());
    try {
      const report = { ...costPerOutcome(db, assignments, window), skipped };
      if (ctx.format !== 'json') {
        process.stderr.write(renderCostPerOutcomeText(report) + skippedLine(skipped));
      }
      return report;
    } finally {
      db.close();
    }
  },
});
