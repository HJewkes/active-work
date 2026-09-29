/**
 * Per-initiative input to the v2→v3 open-loops migration.
 *
 * Authored by hand, not generated at run time. Typed `unknown` so it can only
 * be used after passing `ProposalSchema`: the migration validates the whole
 * batch before it writes anything, and a data file that typechecks is not
 * thereby trusted.
 *
 * Shape: see `ProposalSchema` in `../v3-proposal.ts`.
 *
 * The entries below are synthetic fixtures. They exercise the schema paths the
 * migration needs (prose loops, a back-dated `ended`, an abandoned loop) and
 * describe no real initiative. A real run supplies its own proposal through
 * `$AW_V3_PROPOSAL`.
 *
 * `ended` is an initiative's true last-touch, and never the clock. Loops are
 * therefore born already aged, so an old `ended` trips the 30-day stale-loop
 * warning on day one. That is the intended outcome, not a defect.
 *
 * A `next_step` carrying `abandoned` is opened by the back-dated session and
 * then closed by a second session stamped `abandoned_at`, so the ledger shows
 * the loop existed and shows who killed it.
 *
 * An initiative absent from this list is SKIPPED: its `handoff.md` is still
 * archived to `sources/handoff-archive.md`, but no synthetic session is
 * written and its next-actions do not enter the ledger.
 *
 * A hand-authored proposal cannot stay current for an initiative that is being
 * actively worked: re-validate immediately before applying.
 *
 * - A loop for finished work cannot be expressed here. The only resolve this
 *   file can emit is `abandoned`, so a loop whose work completed is dropped.
 * - `kind: pr` never auto-resolves, because bootstrap stays offline. Prefer
 *   prose.
 * - Never point a loop at a `done` task whose work is not done. It
 *   auto-resolves on arrival and deletes the item from the ledger silently.
 */
export const V3_OPEN_LOOPS_PROPOSAL: unknown = {
  abandoned_at: '2026-06-01T12:00:00Z',
  initiatives: [
    {
      slug: 'example-app',
      ended: '2026-05-12T09:00:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-05-12\n\nSynthetic example handoff. The first two milestones of a sample app shipped and the build is clean.\n\nNext session was to be planning.',
      next_steps: [
        {
          id: 'n1',
          text: 'Draft the settings screen against the agreed wireframes.',
          kind: 'prose',
        },
        {
          id: 'n2',
          text: 'Add a smoke test for the login flow.',
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'sample-lib',
      ended: '2026-03-01T15:30:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-03-01\n\nSynthetic example handoff. A sample library reached its first tagged release; docs are still thin.',
      next_steps: [
        {
          id: 'n1',
          text: 'Write the usage guide and link it from the README.',
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'demo-site',
      ended: '2026-05-20T10:00:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-05-20\n\nSynthetic example handoff. A demo site is deployed to a staging host. One follow-up depended on a trial that has since expired.',
      next_steps: [
        {
          id: 'n1',
          text: 'Claim the trial hosting credit before it lapses.',
          kind: 'prose',
          abandoned: {
            note: 'The trial window closed before the migration; recorded as abandoned so no future session chases it.',
          },
        },
        {
          id: 'n2',
          text: 'Replace placeholder copy on the landing page.',
          kind: 'prose',
        },
      ],
    },
  ],
};
