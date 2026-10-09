import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import taskEdit from './task-edit.js';
import { TaskOrLineSchema, type TaskOrLine } from './_task-quiet.js';

// Strict on purpose: a field name or flag that is not declared here must fail
// parsing, so a profile granted `task note` can never reach another field.
const ArgsSchema = z
  .object({
    slug: z.string().min(1),
    id: z.string().min(1),
    text: z.string(),
  })
  .strict();

type Args = z.infer<typeof ArgsSchema>;

export default defineCommand<Args, TaskOrLine>({
  name: 'task.note',
  description: 'Append one note line to a task; changes no other field',
  args: ArgsSchema,
  result: TaskOrLineSchema,
  cli: { positional: ['slug', 'id', 'text'] },
  run(args, ctx) {
    return taskEdit.run({ slug: args.slug, id: args.id, append: args.text }, ctx);
  },
});
