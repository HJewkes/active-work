import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { writeSessionFile } from '../sessions/session-file.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z
  .object({
    slug: z.string().min(1),
    session_id: z.string().min(1),
    started: z.string().min(1),
    ended: z.string().min(1),
    track: z.enum(['canonical', 'sidecar', 'adhoc']).default('canonical'),
    body: z.string().optional(),
    body_file: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const hasBody = value.body !== undefined;
    const hasFile = value.body_file !== undefined;
    if (!hasBody && !hasFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'Exactly one of --body or --body-file is required',
      });
    }
    if (hasBody && hasFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: '--body and --body-file are mutually exclusive',
      });
    }
  });

const ResultSchema = z.object({
  path: z.string(),
  filename: z.string(),
});

export default defineCommand({
  name: 'session.record',
  description: 'Write a session summary file under <slug>/sessions/',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      session_id: {
        long: '--session-id',
        description: 'Claude session identifier',
        required: true,
      },
      started: {
        long: '--started',
        description: 'ISO 8601 session start timestamp',
        required: true,
      },
      ended: {
        long: '--ended',
        description: 'ISO 8601 session end timestamp',
        required: true,
      },
      track: {
        long: '--track',
        description:
          "'canonical' (mainline thread) | 'sidecar' (folded/derived) | 'adhoc' (parallel ad-hoc work) (default: canonical)",
      },
      body: {
        long: '--body',
        description: 'Raw markdown body',
      },
      body_file: {
        long: '--body-file',
        description: 'Path to a file containing the markdown body',
      },
    },
    usage: 'session.record <slug> --session-id <id> --started <iso> --ended <iso> [--track canonical|sidecar|adhoc] (--body <text> | --body-file <path>)',
  },
  async run(args) {
    const body = args.body ?? (await fs.readFile(args.body_file!, 'utf8'));
    return writeSessionFile({
      slug: args.slug,
      session_id: args.session_id,
      started: args.started,
      ended: args.ended,
      track: args.track,
      body,
    });
  },
});
