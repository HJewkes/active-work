import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { NextStepSchema, SessionIdSchema } from '../schemas/session.js';
import { V3_OPEN_LOOPS_PROPOSAL } from './data/v3-open-loops-proposal.js';

/**
 * The data file the v2→v3 migration consumes.
 *
 * The migration is deliberately mechanical: it does not read handoff prose,
 * does not infer back-dates, and does not decide what a loop is. Those are
 * per-initiative judgement calls made ahead of time and recorded here, so the
 * code that touches the operator's data has no discretion left in it.
 */

// A synthetic `session_id` also becomes part of the filename and the first
// half of every ref the session mints. The schema-level rule only bans
// `#`, whitespace and `/`; kebab-case is narrower on purpose, because a
// hand-authored proposal naturally reaches for spaces and slashes and the
// resulting failure would otherwise land mid-run.
const KEBAB_SESSION_ID = SessionIdSchema.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
  message: 'session_id must be kebab-case ([a-z0-9-], no leading/trailing dash)',
});

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A loop that is dead on arrival — the handoff recorded it, but the window it
 * depended on has since closed. It is still *opened* by the back-dated session
 * (the ledger should show it existed) and then closed by a second, later
 * session carrying this note. Recording it as live would leave a loop whose
 * own text says "do not chase" sitting in the ledger forever.
 */
const AbandonedSchema = z.object({ note: z.string().min(1) });

const ProposalNextStepSchema = NextStepSchema.extend({
  abandoned: AbandonedSchema.optional(),
});

const ProposalInitiativeSchema = z.object({
  slug: z.string().min(1),
  /**
   * Real last-touch of the initiative, hand-supplied. Never `Date.now()` and
   * never file mtime — several initiatives have mtimes months adrift from
   * their true last-touch, and the whole point of back-dating is to preserve
   * the staleness signal.
   */
  ended: z.string().regex(ISO_INSTANT, {
    message: 'ended must be an ISO 8601 instant with timezone',
  }),
  session_id: KEBAB_SESSION_ID,
  body: z.string().min(1),
  next_steps: z.array(ProposalNextStepSchema).default([]),
});

export const ProposalSchema = z
  .object({
    /**
     * When the abandonment decision was made. Hand-supplied rather than read
     * from the clock: the second session's filename derives from it, and the
     * migration keys idempotence on exact paths, so `Date.now()` would mint a
     * fresh path — and a duplicate abandonment session — on every re-run.
     */
    abandoned_at: z
      .string()
      .regex(ISO_INSTANT, {
        message: 'abandoned_at must be an ISO 8601 instant with timezone',
      })
      .optional(),
    initiatives: z.array(ProposalInitiativeSchema),
  })
  .superRefine((value, ctx) => {
    const withAbandoned = value.initiatives.filter((i) =>
      i.next_steps.some((n) => n.abandoned !== undefined),
    );
    if (withAbandoned.length === 0) return;
    if (value.abandoned_at === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['abandoned_at'],
        message: 'abandoned_at is required when any next_step is marked abandoned',
      });
      return;
    }
    // Only a strictly later session may resolve an earlier one's loops.
    const at = new Date(value.abandoned_at).getTime();
    for (const initiative of withAbandoned) {
      if (at <= new Date(initiative.ended).getTime()) {
        ctx.addIssue({
          code: 'custom',
          path: ['abandoned_at'],
          message:
            `abandoned_at (${value.abandoned_at}) must be strictly after ` +
            `${initiative.slug}'s ended (${initiative.ended}), or the abandonment ` +
            'session cannot resolve the loops it opens',
        });
      }
    }
  });

export type ProposalInitiative = z.infer<typeof ProposalSchema>['initiatives'][number];
export type ProposalNextStep = z.infer<typeof ProposalNextStepSchema>;
export type Proposal = z.infer<typeof ProposalSchema>;

/** Env var pointing at a JSON proposal, overriding the bundled default. */
export const PROPOSAL_PATH_ENV = 'AW_V3_PROPOSAL';

function parseProposal(input: unknown, origin: string): Proposal {
  const result = ProposalSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      `Invalid v2→v3 migration proposal (${origin}): ${result.error.message}`,
    );
  }
  const seen = new Set<string>();
  for (const initiative of result.data.initiatives) {
    if (seen.has(initiative.slug)) {
      throw new ValidationError(
        `Invalid v2→v3 migration proposal (${origin}): duplicate slug ${initiative.slug}`,
      );
    }
    seen.add(initiative.slug);
  }
  return result.data;
}

/**
 * Load and validate the proposal. Prefers `$AW_V3_PROPOSAL` (a JSON file) so
 * the operator can stage and dry-run a revised proposal without a rebuild;
 * otherwise uses the copy bundled with this release.
 */
export async function loadProposal(): Promise<{ proposal: Proposal; origin: string }> {
  const override = process.env[PROPOSAL_PATH_ENV];
  if (override !== undefined && override.length > 0) {
    let raw: string;
    try {
      raw = await fs.readFile(override, 'utf8');
    } catch {
      throw new ValidationError(`${PROPOSAL_PATH_ENV} points at an unreadable file: ${override}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new ValidationError(
        `${PROPOSAL_PATH_ENV} is not valid JSON (${override}): ${(err as Error).message}`,
      );
    }
    return { proposal: parseProposal(json, override), origin: override };
  }
  return {
    proposal: parseProposal(V3_OPEN_LOOPS_PROPOSAL, 'bundled'),
    origin: 'bundled',
  };
}
