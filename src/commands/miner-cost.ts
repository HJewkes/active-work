import {
  costReport,
  costReportSchema,
  renderCostReportText,
} from '@titan-design/session-analytics';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { defaultGraphPath, openGraphReadOnly } from '../session-index/graph.js';

/**
 * `active-work miner cost` — spend over the session-signal index, sliced by
 * class, role, initiative, context band, wake cause, and cold-rebuild cost.
 *
 * The report itself lives in `@titan-design/session-analytics`; this command
 * only wires the window/top args and the read-only graph open onto it.
 */

const ArgsSchema = z.object({
  days: z.coerce.number().int().positive().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  top: z.coerce.number().int().positive().optional(),
});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = costReportSchema;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'miner.cost',
  description:
    'Report session-signal spend by class, role, initiative, context band, wake cause, and cold-rebuild cost.',
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
      top: { long: '--top', description: 'Sessions listed in topSessions (default 10).' },
    },
  },
  async run(args, ctx) {
    const db = openGraphReadOnly(defaultGraphPath());
    try {
      const report = costReport(db, {
        days: args.days,
        since: args.since,
        until: args.until,
        top: args.top,
      });
      if (ctx.format !== 'json') process.stderr.write(renderCostReportText(report));
      return report;
    } finally {
      db.close();
    }
  },
});
