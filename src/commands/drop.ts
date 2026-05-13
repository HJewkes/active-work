import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { appendTriagedLog } from '../discover/triaged-log.js';

/**
 * `active-work drop <ref>` — silently dismiss a discover hit. The orchestrator
 * reads `.triaged.log` and skips refs already marked dropped.
 */

const ArgsSchema = z.object({
  ref: z.string().min(1),
  reason: z.string().optional(),
});

const ResultSchema = z.object({
  ref: z.string(),
});

export default defineCommand({
  name: 'drop',
  description: 'Mark a discover hit as dropped so future discovers suppress it.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['ref'],
    options: {
      reason: {
        long: '--reason',
        description: 'Optional one-line reason recorded in the triage log',
      },
    },
  },
  async run(args) {
    await appendTriagedLog('drop', args.ref, args.reason ?? '-');
    return { ref: args.ref };
  },
});
