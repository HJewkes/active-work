import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { defaultSessionIndexPath, openSessionIndexReadOnly } from '../miner/session-index/db.js';
import { runLiveness } from '../miner/session-index/liveness.js';
import { color } from '../utils/color.js';

/**
 * `active-work miner liveness` — which declared structures does nothing write?
 *
 * The complement to `miner status`, which answers "how much is in the index".
 * This answers "how much of what the schema promises is real". Every AW-26
 * finding was a structure the design declared and no writer reached; the point
 * of a command is that the next one gets found on purpose.
 *
 * Advisory by construction: an empty column is a question, not a failure. Some
 * are legitimately awaiting a feature. The report says which, and a human
 * decides whether that is unfinished work or a thing to delete.
 */

const ArgsSchema = z.object({});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  emptyColumns: z.array(
    z.object({ table: z.string(), column: z.string(), rows: z.number(), nonNull: z.number() }),
  ),
  unusedRelations: z.array(z.string()),
  undeclaredRelations: z.array(z.string()),
  danglingNamespaces: z.array(
    z.object({ namespace: z.string(), edges: z.number(), dangling: z.number() }),
  ),
  unmappedNamespaces: z.array(z.string()),
  staleTranscripts: z.number(),
  transcripts: z.number(),
});
type Result = z.infer<typeof ResultSchema>;

function report(result: Result): string {
  const lines: string[] = [color.bold('active-work miner liveness')];
  const bullet = (text: string): void => void lines.push(`  ${text}`);

  lines.push('');
  lines.push(color.bold('  Columns nothing ever writes'));
  if (result.emptyColumns.length === 0) bullet(color.green('none — every column has a writer'));
  for (const column of result.emptyColumns) {
    bullet(`${color.yellow('EMPTY')} ${column.table}.${column.column}  (0 of ${column.rows} rows)`);
  }

  lines.push('');
  lines.push(color.bold('  Edge relations'));
  if (result.unusedRelations.length === 0 && result.undeclaredRelations.length === 0) {
    bullet(color.green('declared vocabulary matches what is written'));
  }
  for (const relation of result.unusedRelations) {
    bullet(`${color.yellow('UNUSED')} ${relation} — declared in RELATIONS, never written`);
  }
  for (const relation of result.undeclaredRelations) {
    bullet(`${color.red('UNDECLARED')} ${relation} — written, missing from RELATIONS`);
  }

  lines.push('');
  lines.push(color.bold('  Edge endpoints that resolve to nothing'));
  if (result.danglingNamespaces.length === 0) bullet(color.green('every endpoint resolves'));
  for (const namespace of result.danglingNamespaces) {
    bullet(
      `${color.yellow('DANGLING')} ${namespace.namespace}: ${namespace.dangling} of ${namespace.edges} endpoints`,
    );
  }
  for (const namespace of result.unmappedNamespaces) {
    bullet(`${color.yellow('UNMAPPED')} ${namespace}: — no entity table declared for this ref`);
  }

  if (result.staleTranscripts > 0) {
    lines.push('');
    lines.push(color.bold('  Transcripts'));
    bullet(
      `${color.yellow('STALE')} ${result.staleTranscripts} of ${result.transcripts} marked ok, but the file is gone`,
    );
  }
  return lines.join('\n') + '\n';
}

export default defineCommand<Args, Result>({
  name: 'miner.liveness',
  description:
    'Report which declared index structures nothing ever populates: empty columns, unused edge relations, dangling refs, stale transcripts.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: { usage: 'active-work miner liveness' },
  async run(_args, ctx) {
    const db = openSessionIndexReadOnly(defaultSessionIndexPath());
    try {
      const liveness = runLiveness(db);
      const result: Result = {
        emptyColumns: liveness.emptyColumns,
        unusedRelations: liveness.relations
          .filter((relation) => relation.declared && relation.count === 0)
          .map((relation) => relation.relation),
        undeclaredRelations: liveness.relations
          .filter((relation) => !relation.declared)
          .map((relation) => relation.relation),
        danglingNamespaces: liveness.refNamespaces
          .filter((namespace) => (namespace.dangling ?? 0) > 0)
          .map((namespace) => ({
            namespace: namespace.namespace,
            edges: namespace.edges,
            dangling: namespace.dangling ?? 0,
          })),
        unmappedNamespaces: liveness.refNamespaces
          .filter((namespace) => namespace.dangling === null)
          .map((namespace) => namespace.namespace),
        staleTranscripts: liveness.staleTranscripts,
        transcripts: liveness.transcripts,
      };
      if (ctx.format !== 'json') process.stderr.write(report(result));
      return result;
    } finally {
      db.close();
    }
  },
});
