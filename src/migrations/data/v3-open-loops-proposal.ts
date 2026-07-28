/**
 * Per-initiative input to the v2→v3 open-loops migration.
 *
 * Authored by hand (one pass per initiative, reviewing its `handoff.md`), not
 * generated at run time. Typed `unknown` so it can only be used after passing
 * `ProposalSchema` — the migration validates the whole batch before it writes
 * anything, and a data file that typechecks is not thereby trusted.
 *
 * Shape: see `ProposalSchema` in `../v3-proposal.ts`.
 *
 * `ended` is each initiative's real last-touch, read off its handoff — never
 * the clock and never file mtime, several of which are months adrift. The
 * loops below are therefore born already aged, and the eight initiatives last
 * touched in May trip the 30-day stale-loop warning on day one. That is the
 * intended outcome, not a defect.
 *
 * A `next_step` carrying `abandoned` is opened by the back-dated session and
 * then closed by a second session stamped `abandoned_at`, so the ledger shows
 * the loop existed and shows who killed it.
 *
 * An initiative absent from this list is SKIPPED: its `handoff.md` is still
 * archived to `sources/handoff-archive.md`, but no synthetic session is
 * written and its next-actions do not enter the ledger. The migration reports
 * every such skip loudly rather than guessing at content.
 */
export const V3_OPEN_LOOPS_PROPOSAL: unknown = {
  abandoned_at: '2026-07-28T18:00:00Z',
  initiatives: [
    {
      slug: 'active-work',
      ended: '2026-07-15T00:00:00Z',
      session_id: 'handoff-migration',
      body: "# Handoff state as of 2026-07-15\n\nSession-mining tooling now lives in active-work, its proper home, and the miner roadmap is moving. active-work is published to npm as `@titan-design/active-work@0.1.0`; `main` is clean.\n\nTwo PRs are open, neither merged: **active-work#56** (`feat/session-miner-tooling` — the byte-identical miner port into `tools/`, plus AW-24 cost rollups and AW-27 the eval harness, both done) and **titan-design#110** (the design-repo copy, reduced to dashboard specimens). The eval immediately caught a real miner bug — junk branch names `/` and `HEAD:main` — filed as AW-34.\n\nThe v0.1 publish shipped under the org scope, not the planned `@hjewkes` scope, and releasing is now tag-triggered OIDC trusted publishing (#54) with changesets removed (#55). The first tagged run has never been exercised end to end.\n\nOne pre-existing flake: `__tests__/server/file-watch.test.ts` (timing/debounce, matches AW-12), passes on re-run.\n\n_This state is 13 days behind the initiative's newest real session (2026-07-28)._",
      next_steps: [
        {
          id: 'n1',
          text: 'AW-28 Drain error-atlas sourcing (est 8) is the next miner build and the first piece to land in src/ as real TypeScript — native Drain port, do not shell to Python. Recipe in sources/deepdive-session-mining-build-specs.md §C1.',
          kind: 'task',
          ref: 'AW-28',
        },
        {
          id: 'n2',
          text: 'AW-34 is the quick one (est 2) — fix the junk branch names the eval caught, then regression-check with `pnpm eval:miner`.',
          kind: 'task',
          ref: 'AW-34',
        },
        {
          id: 'n3',
          text: "AW-23 production session-signal index (est 8) is now unblocked by AW-27's eval gate and unlocks the Phase-3 backlog AW-29 through AW-33.",
          kind: 'task',
          ref: 'AW-23',
        },
        {
          id: 'n4',
          text: 'Merge active-work#56 (feat/session-miner-tooling) — still open; the branch is on origin and tools/ is not on main.',
          kind: 'pr',
          ref: '56',
        },
        {
          id: 'n5',
          text: 'Merge titan-design#110 alongside #56 — the design-repo copy with miner tools removed; the lab/active-work-dashboard branch is pushed as a full-history archive.',
          kind: 'prose',
        },
        {
          id: 'n6',
          text: 'Eyeball the first tagged release run: it is the first real end-to-end exercise of the OIDC trusted-publisher config, and nothing has pushed a vX.Y.Z tag yet.',
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'ai-investing-workflow',
      ended: '2026-05-26T23:59:00Z',
      session_id: 'handoff-migration',
      body: "# Handoff state as of 2026-05-26\n\nResearch phase complete. Three async agents (institutional ceiling, retail toolkit, empirical edge) reported and were synthesized into a unified position. The prior hypothesis — \"retail can't compete with institutional AI\" — was confirmed half-right and refined: the right benchmark is the median active fund (which most institutions also lose to) and one's own un-AI'd behaviour, not Citadel.\n\nNext phase is execution: pick sources to subscribe to, decide tooling spend, build 2–3 concrete LLM workflows (10-K diff, earnings-call execution-credibility, pre-mortem) and establish behavioural guardrails before any of it touches real capital decisions.\n\nCore allocation stays passive/indexed regardless. This work is about being a more literate observer of macro, and possibly supporting a small active sleeve in small/mid-cap names where AI-assisted research can plausibly close information gaps.\n\nNothing has moved since. Eight AIW-* tasks are filed and all are open.",
      next_steps: [
        {
          id: 'n1',
          text: 'Decide: pay for FT now, or trial the free Overshoot + Slok weekly deck first. This gates AIW-1 and is the only thing standing between research and execution.',
          kind: 'prose',
        },
        {
          id: 'n2',
          text: 'Answer whether an active sleeve exists today or the small-active-sleeve idea is still entirely hypothetical — everything downstream is sized by this.',
          kind: 'prose',
        },
        {
          id: 'n3',
          text: 'Confirm whether direct indexing is already in place in the tax-advantaged accounts before evaluating Wealthfront/Betterment (the measured after-tax uplift is ~1.8%).',
          kind: 'task',
          ref: 'AIW-6',
        },
      ],
    },
    {
      slug: 'audiobook',
      ended: '2026-07-26T00:00:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-07-26\n\nThe autopull pipeline (main track) runs fully unattended and is healthy. Book 7 is complete, 12/12 chapters exported. No open engineering blockers on either track.\n\nA separate `feat/tts-quality` branch (local, unpushed, HEAD `6680bee`, 153 tests passing) carries TTS-quality work: chunker boundary-hallucination fix, currency/decimal/punctuation normalization, stats-table roster rephrasing, self-heal of hallucinated takes wired into the worker (~68% babble reduction), and a new MP3→m4b packaging tool. The Book 7 Ch 16 appendix was re-rendered clean and replaced in the R2 feed on 2026-07-23 (stable GUID — delete+refresh in Overcast to re-pull).\n\nThe m4b tool delivered Soccer Supremo Book 1 as two m4bs in `~/Downloads/Soccer Supremo 1/`, awaiting an Apple Books playback check.\n\nPRs #4, #5 and #6 are merged to main with green CI: the pipeline event store + FastMCP server, the book-discovery gap plus lock cleanup, and the cheap precheck gate at a 15-minute cadence.',
      next_steps: [
        {
          id: 'n1',
          text: 'Close the partial-generation recovery gap: a chapter downloaded + normalized + chunked but interrupted mid-TTS (has normalized.txt, no audio.wav) is not re-picked by the precheck or find_new_chapters — both key off raw-without-normalized.',
          kind: 'task',
          ref: 'A-2',
        },
        {
          id: 'n2',
          text: '/api/scraper/preview returns 422 — fiction_id is declared a Path param but is absent from the route path. Latent; unused by autopull.',
          kind: 'prose',
        },
        {
          id: 'n3',
          text: "Decide the fate of parked code: PR #1's cloud infra (Docker/k8s/Terraform/S3/SQS/Postgres) contradicts the single-user filesystem-only design and sits under parked/ — keep as reference or delete. The dialogue/speaker module is parked too; revive only if wanted.",
          kind: 'prose',
        },
        {
          id: 'n4',
          text: "Check Soccer Supremo Book 1's two m4bs actually play in Apple Books — the AAC-vs-MP3-remux split exists precisely because Apple Books plays MP3-in-m4b silent, and this was never confirmed.",
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'brain',
      ended: '2026-05-12T00:00:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-05-12\n\nHEAD is on `spike/2026-05-platform`, pointing at the same SHA as `main` (`6da9d96`, 2026-05-02). Two active tracks.\n\n**Platform redesign spike** — Spike 1 critical-subset checkboxes pass. Restate + Claude Agent SDK + a custom YAML compiler validated end to end across 10 packages, ~3,500 LOC, 42 unit tests, 3 e2e smokes (cancellation reaches the Claude Code child in 201ms; the planning workflow walks 4 nodes in 22ms). `07-spike-1-decision-memo.md` recommends adopting Path 1.\n\n**Main-line autonomy/PM work** — the last 30 commits on main are VNM-56 worktree/merge-lifecycle (#215–#221) and VNM-48 dispatch/file-ownership. Phase 1 stabilization is done; Phase 2 (parallel dispatch on real workstreams) is unblocked.\n\nThe working tree is dirty in a non-trivial way: ~80+ untracked files under `docs/plans/` and `docs/pm-module/diagnostic/v*`, plus a top-level `platform-redesign-2026-05.zip` (358K) and a mirror directory duplicating content already in the repo.\n\n⚠️ Contested since: titan-platform\'s 2026-07-13 round-2 research concluded the spike is a **design, not a built or adopted platform**, and that the "decision memo" framing was wrong.',
      next_steps: [
        {
          id: 'n1',
          text: 'Read docs/architecture/2026-05-platform-redesign/07-handoff-spike-1-continuation.md and 07-spike-1-decision-memo.md first — they are the freshest authoritative state — then spike-1-notes.md for per-checkbox status.',
          kind: 'prose',
        },
        {
          id: 'n2',
          text: "THE gating decision: adopt Path 1 and scope a migration of src/modules/workflow/ (and consumers) onto the spike's Step contract + Restate; or defer and keep investing in the homegrown runtime; or abandon the spike. Deferred items are enumerated in the decision memo § 'What's deferred to migration'. Weigh this against titan-platform's later finding that the spike was never actually adopted.",
          kind: 'prose',
        },
        {
          id: 'n3',
          text: 'If continuing the spike: (3) HITL awakeable wiring is the highest-value remaining critical-subset coverage; (4) real leaves and (5) parallel-spawn fan-out make the artifact stronger. The side-by-side and decision memo are already written.',
          kind: 'prose',
        },
        {
          id: 'n4',
          text: 'If executing the migration: scope which existing modules (pm, agents, sessions, workflow, codebase) become leaves on the Step contract vs stay outside it. Side-by-side §5 enumerates the surfaces.',
          kind: 'prose',
        },
        {
          id: 'n5',
          text: 'Housekeeping on the dirty tree: classify docs/plans/* (commit canonical, gitignore ephemeral — pattern set by #210 691fcf1), then decide whether platform-redesign-2026-05.zip and its mirror dir are a discardable backup or content to commit.',
          kind: 'prose',
        },
        {
          id: 'n6',
          text: 'Root-cause the embedding dimension mismatch (Expected 384 dimensions but received 768) that intermittently breaks PM-via-MCP — likely DB-init vs embedder-config drift. Not blocking via CLI but it degrades autonomy.',
          kind: 'prose',
        },
        {
          id: 'n7',
          text: 'Reconcile PM state: three tasks from the 2026-04-27 parallel test still show in-progress/stuck despite merged PRs. Verify #218 (VNM-56.71) actually cleared the backlog, or file a follow-up.',
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'claude-channels',
      ended: '2026-07-28T16:29:00Z',
      session_id: 'handoff-migration',
      body: "# Handoff state as of 2026-07-28\n\n**Agent teams work.** CC-17 closed: a spawned agent is a durable, addressable peer that outlives its spawner, launchable headless or in a terminal under normal permissions — and spawned agents have now done real work (one found a lifecycle race, three found a security gap, two live defects, a false test).\n\n`feat/plugin-packaging` pushed at `a12c1fc`, clean tree, 323 tests green, tsc and prettier clean. The broker runs properly detached in its own process group, so it survives the session that started it. **CC-24 closed** — the headless hang is gone, and the fix was not A8's stream.jsonl: the streams are discarded, because Claude Code already writes a full structured transcript per session and we assign the session id ourselves. §9 and A8 in agent-teams.md are marked superseded.\n\nThe next session was planned as a parallel team wave on the agent-teams backlog itself — gatekeeper (CC-28→CC-25), herald (CC-26), proofer (live-spawn harness→CC-27→CC-29) in separate worktrees, merge order gatekeeper→herald→proofer. **CC-28 has since closed**, so confinement is now real and the remaining wave items stand on their own.\n\nThe title is legacy: the subject is general agent orchestration, and the logic will eventually fold into relay. Keep the orchestration logic separable from the local broker / event log / registry.",
      next_steps: [
        {
          id: 'n1',
          text: 'Build the opt-in live-spawn integration harness that really spawns `claude`, gated behind an env var so it never runs on CI or by default. CC-27 and CC-29 both need it. The gating is load-bearing — an ungated test naming iterm-pane opened real windows on the laptop once (fixed in aa08d86).',
          kind: 'prose',
        },
        {
          id: 'n2',
          text: 'CC-25 — the spawn-rate budget §11.3 promises and that does not exist. Named as a §11 defence that turned out to be prose.',
          kind: 'task',
          ref: 'CC-25',
        },
        {
          id: 'n3',
          text: 'CC-26 — agent_ready + spawnedBy. Design is fully worked out in the task and the subscription machinery shipped in bd31bad, so this is one protocol selector plus a default.',
          kind: 'task',
          ref: 'CC-26',
        },
        {
          id: 'n4',
          text: "CC-27 — iTerm placement is verified only by hand. The manual probe is watching three spawned panes stack in a column in your anchor's tab while a different tab has focus; if they don't, that is a live regression worth more than the ticket.",
          kind: 'task',
          ref: 'CC-27',
        },
        {
          id: 'n5',
          text: 'CC-29 — now decidable. Its premise (a headless denial shows up in the transcript) was never verified because the probe hit CC-28 and the agent was never denied at all. CC-28 has closed, so re-run the probe.',
          kind: 'task',
          ref: 'CC-29',
        },
        {
          id: 'n6',
          text: "CC-20 (teleport) and CC-23 (headless↔terminal switching) remain deliverables on the agent-teams substrate rather than standalone builds; CC-23 is partly gated on CC-29, since 'notice an agent is stuck and surface it into a terminal' presupposes noticing.",
          kind: 'task',
          ref: 'CC-20',
        },
        {
          id: 'n7',
          text: 'Service Steps 3 (CLI restructure) and 4 (HTTP reads) can run in parallel with the agent work — that parallelism is what freezing Step 2a bought. Steps 1, 2 and 2a are done (e7321c4, 02eaa4e, 16a3759).',
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'codewatch',
      ended: '2026-07-06T23:49:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-07-06 (session 30 wrap)\n\nShipped the C-88 gate(a) query-time capability surface the session-29 gates authorized — PR #121, self-merged once CI went green under standing authorization.\n\n`packages/graph/src/embeddings.ts` + migration v5 add an `embedding` table content-addressed by (model, text_hash), deliberately not snapshot-scoped: vectors are found by rebuilding text→hash at read time, so incremental reuse is free (843/843 reused, zero ollama calls), vectors never duplicate across snapshots, and the indexer is untouched. New `graph embed`, `graph index --embed`, and `graph similar <intent>` returning top-K candidates-not-verdicts. Read API 1.1.0→1.2.0 plus MCP `find_similar`. 1276 tests green, typecheck clean, fitness gate 0-new.\n\nAn owner-directed injection eval ran the same session (sources/c88-injection-eval.md). Verdict: the duplication-prevention delta is SMALL on the documented surface — A0 already reuses 9/12. The real measured value is −28% cost ($8.82→$6.31) and 19.5→16.1 avg turns as the search phase collapses, plus A1 consolidating tRPC\'s real getQueryKeyInternal twin-duplication onto one shared impl.\n\nThe file below this block was ~1,750 lines of reverse-chronological session diary back to 2026-07-04; every "NEXT" in it was acted on by the following session.',
      next_steps: [
        {
          id: 'n1',
          text: "C-88 gate(b), cost-gated: coarse hierarchical Leiden on the resolved file graph → LLM community summaries at capability altitude → a 'how does this repo do X' convention surface, reusable for the C-90 bundle. Gate on a cost budget — summarize the coarse level only, or lazily.",
          kind: 'task',
          ref: 'C-88',
        },
        {
          id: 'n2',
          text: 'C-92 codewatch plugin (injection delivery), now evidence-framed by the injection eval: a SessionStart/plan-time hook injecting find_similar + context. Frame the value as cost/latency/reliability and consolidation, NOT duplication prevention.',
          kind: 'task',
          ref: 'C-92',
        },
        {
          id: 'n3',
          text: 'C-90 compact context-bundle (p7) — ranked file-line citations, and it can now include similar-capability candidates.',
          kind: 'task',
          ref: 'C-90',
        },
        {
          id: 'n4',
          text: 'These three were an explicit pick-ONE, not a queue. Conditional: the duplication-prevention claim needs the undocumented surface (where sig-only retrieval is also weaker) — only build that stratified eval if C-92 ships.',
          kind: 'prose',
        },
        {
          id: 'n5',
          text: 'OPERATOR-ONLY, orphaned: the npm publish is still not done. C-6 shipped a publish-READY distribution (all 7 packages, verified end-to-end via local verdaccio) but the actual publish needs the @codewatch npm org/scope created plus auth, then `pnpm release` or the Release action with dry_run=false and an NPM_TOKEN secret. C-6 is closed, so this lives in no task.',
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'computer-organization',
      ended: '2026-05-12T00:00:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-05-12\n\nInitiative scaffolded from the `aw discover` triage pass. 22 per-directory triage tasks filed (CO-1..CO-22), all open, severity low, priority matching the CO number. Nothing decided yet — every legacy directory is still sitting in ~/Documents/projects/ untouched.\n\nState is `backburner`: this drains opportunistically, not on a deadline. All work happens on the filesystem; no repo, no CI, no tests.\n\nThe one thing that exists here and nowhere else is the first-pass triage judgment — which specific directories are obvious deletes, which are obvious archives, and which need investigation before anything is touched. The CO-*.yml tasks are all still generically titled "archive, integrate, or delete" with no disposition recorded, so the calls below are the only record of that work.',
      next_steps: [
        {
          id: 'n1',
          text: 'Pick ONE canonical archive destination (e.g. ~/Documents/projects/.archive/ vs an external cold-storage path) and record it before moving anything, or the triage fragments across destinations.',
          kind: 'prose',
        },
        {
          id: 'n2',
          text: 'Fast-DELETE candidates from the first pass, pending spot-check: `test` (CO-16), `bookmarks-demo` (CO-2), `webfetch` (CO-21).',
          kind: 'prose',
        },
        {
          id: 'n3',
          text: 'Fast-ARCHIVE candidates from the first pass: `experimentation_docs` (CO-5), `rp-university-transcripts` (CO-14), `kaizen-analysis` (CO-10).',
          kind: 'prose',
        },
        {
          id: 'n4',
          text: 'Investigate the three name-collision dirs — `titan-design` (CO-18), `voltras` (CO-19), `workflow-improvement` (CO-22) — by reading README and git log to establish their relationship to the live counterparts, then decide confirm-then-merge vs treat-as-stale-and-delete.',
          kind: 'prose',
        },
        {
          id: 'n5',
          text: 'Decide the home-infra consolidation question: promote `home` (CO-7), `home_server` (CO-8) and `homeassistant_samba` (CO-9) into one initiative and close all three with pointers, or triage each in isolation.',
          kind: 'prose',
        },
        {
          id: 'n6',
          text: 'Decide whether the container dirs `nd projects` (CO-12), `personal_projects` (CO-13) and `split_projects` (CO-15) need their own sub-triage or can be classified wholesale.',
          kind: 'prose',
        },
        {
          id: 'n7',
          text: 'Then work the remaining CO tasks individually, recording the chosen disposition in each YAML before any destructive operation, and re-run `aw discover` after each batch to confirm dirs have dropped off the untracked list.',
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'denver-rezzy',
      ended: '2026-05-12T00:00:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-05-12\n\nPhase 1 skeleton complete and exercised end to end on **synthetic data**. The MCP server boots, all three tools (search_restaurants, get_restaurant, auth_status) work over stdio, and orchestrator + caching + ranking + tool plumbing are real. The vitest MCP-handshake smoke test passes.\n\nResy and OpenTable probes still return stub data behind REZZY_USE_STUB_RESY / REZZY_USE_STUB_OPENTABLE. The Tock probe deliberately errors as "Phase 3, not implemented".\n\nMost recent source-tree activity ran Apr 30 → May 2: src/commands/seed.ts, scripts/discover-resy.mjs and scripts/verify-opentable-rids.mjs modified May 2; src/probes/resy/ folder mtime May 2 05:31; src/core/search.ts updated May 2 06:21. It reads as mid-Task-4 (platform-listings backfill) with early Resy probe scaffolding underway.\n\n**There is no .git/ directory.** Nothing is committed anywhere; the work lives only on disk, so Task 4\'s actual completion state can only be established by querying the database. This handoff was the sole record of the remaining Phase 1 plan — tasks/ was empty.',
      next_steps: [
        {
          id: 'n1',
          text: 'Before writing any code, inventory what already exists — no git means the DB is the only evidence. Run `npm run dev auth-status`, `SELECT count(*) FROM platform_listings` (target >= 40), and diff src/probes/resy/index.ts against the stub to see how much of Task 2 is already there.',
          kind: 'prose',
        },
        {
          id: 'n2',
          text: 'Decide on git initialization, recommended before any further change, and what the initial commit should encompass. Without it there is no rollback, no diff and no branch isolation for the Resy / OpenTable implementations.',
          kind: 'prose',
        },
        {
          id: 'n3',
          text: 'Auth is not captured: `rezzy auth-status` will be empty for resy and opentable until `rezzy auth-capture <platform>` is run, and that is required before Tasks 2/3 can produce real data.',
          kind: 'prose',
        },
        {
          id: 'n4',
          text: 'Phase 1 remainder, in order: real Resy probe (ref lgrees/resy-cli) → real OpenTable probe (mobile-api.opentable.com/api/v3/restaurant/availability, ref jonluca/OpenTable-Reservation-Maker) → backfill platform_listings for the 29 seed restaurants using the existing discover/verify scripts, flagging likely Tock-only venues (Beckon, Bruto, Margot, Kizaki) → flip both stub toggles to false and run the end-to-end real-data smoke test in Claude Desktop. Proposed as DR-1..DR-7.',
          kind: 'prose',
        },
        {
          id: 'n5',
          text: "Run `npm run typecheck` before declaring any task done, per the repo's CLAUDE.md.",
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'health',
      ended: '2026-07-27T22:59:00Z',
      session_id: 'handoff-migration',
      body: "# Handoff state as of 2026-07-27\n\nScope decided and the first two builds shipped. `/Users/hjewkes/Documents/health` is live: TypeScript, 35 tests passing, typecheck and production build clean, three commits on branch `feat/macro-calculator` — unmerged, nothing pushed, there is no remote.\n\n**Macro planner** (src/core/) — a pure calculation chain ported from the weight-loss spreadsheet: composition → Katch-McArdle BMR → TDEE → deficit → macro split → projection, composed by buildPlan(). A golden test reproduces the spreadsheet's figures exactly. The projection bug is fixed: the sheet extrapolated a fixed daily loss, but the target is a percentage of current bodyweight, so the curve is exponential — the estimate moves from 110 days (Nov 14) to 117 days (Nov 21), and both are shown in the minimal web UI in src/ui/.\n\n**Instacart ingest** (src/ingest/instacart/) — parses order receipts out of Gmail into structured orders, plus a merge step repairing email-truncated item lists from the web receipt. 33 orders parsed; the last 20 Costco orders at full coverage (287 items, 2025-05 → 2026-07, $5,243).\n\nNext session was to be meal planning.",
      next_steps: [
        {
          id: 'n1',
          text: 'Meal planning: build plans against the macro targets from buildPlan() using the real Costco basket in data/instacart-orders.json rather than invented recipes, and emit a shopping list. No task exists for this — H-4 only covers turning a list into an Instacart cart.',
          kind: 'prose',
        },
        {
          id: 'n2',
          text: 'Consider cost-per-gram-of-protein, now that both price and purchase data exist in the same place.',
          kind: 'prose',
        },
        {
          id: 'n3',
          text: 'Merge feat/macro-calculator once the user has reviewed it — three commits, nothing pushed, no remote exists.',
          kind: 'prose',
        },
        {
          id: 'n4',
          text: "Unresolved and cosmetic: the spreadsheet's BMI cell (33.57) disagrees with its own Ideal BMI Weight cell (223.1 lb, which pins height at 83.5 in and implies BMI 32.52). No calorie or macro target uses height, so nothing is blocked, but the true height is still unconfirmed.",
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'herald',
      ended: '2026-05-29T05:59:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-05-28 (superseded — recorded for the record)\n\nDesign phase complete, build started. S1 done (H-1): src restructured into core/drivers/transports, 186 tests green, committed on `feat/harness-pivot` @ 896d3bb. Working tree clean, nothing pushed. The plan at the time was S2 (H-2) quarantine the backlog, then S3 (H-3) the Plugin/BrainDriver/Transport contract, then S4/M0 the Slack echo round-trip on the phone.\n\n**Almost all of this is now stale.** H-2 and H-3 both closed in the 2026-05-29 and 2026-06-02 sessions. Nothing has happened in this initiative since 2026-06-02, roughly eight weeks.\n\nThe one item that survived — and the reason this record exists — is a blocker containing a time-sensitive deadline that has silently expired. It is recorded below as ABANDONED rather than migrated as live work, so a future session does not chase it.\n\nDecisions remain locked in the brief: library-first TS harness; service-owns-loop with a swappable BrainDriver; ChannelDriver as the v0 default with SdkDriver for isolated/triage workloads; Slack v0 behind a transport adapter; diet coach as the first vertical.',
      next_steps: [
        {
          id: 'n1',
          text: 'The "~June 8 Agent SDK credit (June 15 billing change)" window lapsed. The credit is gone; any cost assumption predating the June 15 billing change needs rechecking before the SdkDriver metered path is priced.',
          kind: 'prose',
          abandoned: {
            note: 'The Agent SDK credit claim window (~June 8, ahead of the June 15 billing change) lapsed roughly seven weeks before the migration; the credit is gone. Recorded as abandoned rather than migrated live so no future session chases it. The surviving follow-up — rechecking cost assumptions that predate the June 15 billing change before pricing the SdkDriver metered path — belongs to the brief, not the ledger.',
          },
        },
      ],
    },
    {
      slug: 'home-assistant',
      ended: '2026-05-13T00:00:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-05-13\n\n`main` last commit `7758913` ("fix: remove dead src.core.config_utils import breaking all MCP tools"). Working tree dirty: three ha_config/ files modified (automations_dir/automations.yaml, configuration.yaml, scenes_lighting.yaml) plus untracked .brain/, .claude/settings.local.json, ha_config/custom_templates/, ha_config/dashboards/home_overview.yaml and tools/screenshot.py.\n\nThe initiative is on the back burner — no active coding push — but the brain PM `HOME` instance has 31 pending tasks across 8 workstreams (21 done), so there is plenty queued when attention returns. The most recent work landed the MCP server, SSH config-sync tooling, legacy src/ cleanup, and a Jinja2/stale-entity sweep.\n\n⚠️ That dirty-tree file list is now roughly 2.5 months old and this is a live home-automation system, so treat it as a hint, not a fact. The handoff\'s own guard applies: run `make config-status` and `make config-diff` before deciding anything — live /config/ is authoritative.\n\nNote: HOME-* ids below live in the external brain PM instance, not in this initiative\'s tasks/, which is empty.',
      next_steps: [
        {
          id: 'n1',
          text: 'Reconcile the uncommitted ha_config/ edits: run `make config-status`, decide the pull-or-push direction, then commit the local-side delta. Never push or pull blindly — live /config/ is authoritative.',
          kind: 'prose',
        },
        {
          id: 'n2',
          text: 'Decide the fate of src/ (brain PM HOME-07.17): only config.py and exceptions.py remain. This gates the tools/ test work so the tests target the right layer, and HOME-07.14 / HOME-07.15 are duplicates — close one.',
          kind: 'prose',
        },
        {
          id: 'n3',
          text: 'Triage the HOME-08 design backlog — pick one or two of climate (08.05), presence/away (08.06), goodnight/morning (08.07) as the next active design thread.',
          kind: 'prose',
        },
        {
          id: 'n4',
          text: 'Two small unblockers worth knocking out together: HOME-03.05 add-on updates and HOME-04.01 DHCP reservation for the PowerView hub.',
          kind: 'prose',
        },
        {
          id: 'n5',
          text: 'HOME-03.01 Roborock re-auth is blocked on a UI action — it must be done from Settings → Devices & Services and cannot be scripted.',
          kind: 'prose',
        },
        {
          id: 'n6',
          text: 'Opportunistic: HOME-09.03, archive the three stale debug dashboards next time dashboards are open.',
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'logan',
      ended: '2026-07-17T17:59:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-07-17\n\nA full session took the backyard treehouse / play structure from open question to a ready-to-submit HOA packet. It settled as an open-sided children\'s play structure (not an enclosed playhouse) in the south side yard, which keeps it a Greenwood Village 5 ft-setback, permit-exempt "playground equipment" (Lot 28 = R-1.0 PUD, per Ordinance 03/2021). Analysis lives in docs/treehouse-*; the assembled packet is in property-records/hoa/"ACC Submission - Play Structure/". Only the neighbour signature is left before it goes to the new ACC members. The owner is not pulling a city building permit, and is building to code regardless. The project folder moved to ~/projects/logan, out of the TCC-blocked ~/Documents.\n\nFrom a tooling standpoint this initiative is on the back burner: the folder is maintained by hand, not by any pipeline. Active construction is real — the kitchen contract is signed at $93,346.85, trenching began 2026-04-22, junipers were scheduled the same day. The docs/ knowledge base was last edited 2026-04-18 and is behind reality.\n\nSeveral vendor decisions are sitting undecided in bids/ with no record of a call either way.',
      next_steps: [
        {
          id: 'n1',
          text: "Submit the treehouse ACC packet: print property-records/hoa/'ACC Submission - Play Structure/', get Deb/Nolan Pratt (5185 S Logan) to sign line 1, then send to ACC members Caitlin Tesoriero and Kathy Martinez. Everything else in the packet is ready.",
          kind: 'task',
          ref: 'L-1',
        },
        {
          id: 'n2',
          text: "Chase Wiley/DBS for the electrician's heater breakout (DBS #8635.2) — ceiling-mount vs recessed is a ~$18K swing and the make/model is still unspecified. If it is still missing, request a second bid.",
          kind: 'prose',
        },
        {
          id: 'n3',
          text: 'Plumbing quotes QU0543 / QU0545 for the steam shower are still unsigned — sign or decline.',
          kind: 'prose',
        },
        {
          id: 'n4',
          text: 'Finish selections still open: concrete countertop colour (samples were due 2026-04-22) against Sapphire cabinets and the existing brick; the $5,556 countertop allowance — confirm L-shape coverage, cutouts and overage handling; and brick sourcing for the backsplash, where an exact match is not guaranteed and samples need viewing.',
          kind: 'prose',
        },
        {
          id: 'n5',
          text: 'Decide the remaining un-contracted vendors — painting, flooring, Hall Marble stone, all sitting in bids/ with no decision recorded — or explicitly defer them in docs/open-questions.md.',
          kind: 'prose',
        },
        {
          id: 'n6',
          text: 'Refresh docs/open-questions.md against reality post-2026-04-22 (trenching, tree-placement walkthrough, sample reviews). It was last edited 2026-04-18.',
          kind: 'prose',
        },
        {
          id: 'n7',
          text: 'File the 4-29 DBS L3 drawing and the CO #3 bid (synthetic turf, additional trees, steps, timber walls) into docs/bid-analysis.md — check the 2026-07-20 DBS scope/payments sessions first, they may have covered part of this.',
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'relay',
      ended: '2026-07-28T16:19:00Z',
      session_id: 'handoff-migration',
      body: "# Handoff state as of 2026-07-28\n\nrelay is live, populated, and now has a real attribute model. Production holds 111 imported items plus two test captures (ids 113, 114). Both MCP surfaces are deployed. R-33 is decided and R-38 shipped it: type-specific attributes live in a registry-validated `meta` column enforced by database triggers that both writer doors inherit. `main` is clean — 360 tests across 16 files, tsc clean, four CI gates. Production is Worker version `119a7987`, D1 migrations through 0007.\n\nThe model in four lines: a narrow typed core with type-specific facets in one meta JSON column; `type_schemas` is a TABLE, so registering a kind or attribute is an INSERT; BEFORE INSERT/UPDATE triggers enforce registered keys and allowed values, so both doors and a hand-run `wrangler d1 execute` all obey; hot attributes promote to generated columns, derived so they cannot drift.\n\nThe session that produced this handoff left R-23 Part B half-answered — OAuth completed but the six admin verbs never attached. **That has since been resolved: R-20, R-23, R-27 and R-36 all closed later the same day**, so the handoff's headline NEXT ACTION and its first two operator-only items are no longer live and are excluded below.",
      next_steps: [
        {
          id: 'n1',
          text: '`disabledMcpServers: ["claude.ai Relay"]` is currently SET for this project in ~/.claude.json, left over from probe 4. Claude Code sessions have no relay tools until it is removed.',
          kind: 'prose',
        },
        {
          id: 'n2',
          text: 'R-32 is the highest-leverage thing available: the 1-bit sign sketch takes recall@10 from 55.8% to 96.6% with no schema change, is orthogonal to everything else, and is the candidate generator R-40 needs. Do it first.',
          kind: 'task',
          ref: 'R-32',
        },
        {
          id: 'n3',
          text: "R-40 second — reference content as the second real kind. `note` exists but is a task in disguise (0005 gave it the identical six attributes), so R-33's central ~0-shared-attributes claim is still untested. 'Look up' is a capability relay does not have at all: list_items filters, it does not search.",
          kind: 'task',
          ref: 'R-40',
        },
        {
          id: 'n4',
          text: "R-39 third — registry-driven MCP tools, the fast-follow that R-40 exercises. This is also what makes R-33's no-deploy property real rather than half-real.",
          kind: 'task',
          ref: 'R-39',
        },
        {
          id: 'n5',
          text: 'R-35 (entities) is deliberately sequenced AFTER R-40 by the operator — do not pull it forward.',
          kind: 'task',
          ref: 'R-35',
        },
        {
          id: 'n6',
          text: 'R-37 is about an hour and closes the only unassessable storage flip trigger; take it any time. It is the deciding evidence for the one genuine unfixable-on-D1 defect, and index drift has never been observed or ruled out.',
          kind: 'task',
          ref: 'R-37',
        },
        {
          id: 'n7',
          text: 'R-34 (R2 blob tier) was paired with R-36 and gated behind R-20; both of those have now closed, so R-34 is unblocked.',
          kind: 'task',
          ref: 'R-34',
        },
        {
          id: 'n8',
          text: "R-28 is operator-only and cannot be delegated: capture 'Fix list_items paging' from the phone and listen to whether the readback says 'list underscore items', 'list items' or 'listitems'. The three mean different things — record which.",
          kind: 'task',
          ref: 'R-28',
        },
        {
          id: 'n9',
          text: 'R-24 is operator-only: run `make check-compat-remote`. It refuses a non-TTY by design.',
          kind: 'task',
          ref: 'R-24',
        },
        {
          id: 'n10',
          text: 'Voice `list_items` and `complete_item` have still never run from a phone — only capture has. No task covers this verification gap.',
          kind: 'prose',
        },
        {
          id: 'n11',
          text: 'Housekeeping: delete production test captures ids 113 and 114 when convenient.',
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'taxes',
      ended: '2026-05-12T00:00:00Z',
      session_id: 'handoff-migration',
      body: "# Handoff state as of 2026-05-12\n\nThe 2025 return is on extension. The bulk of documents were uploaded to SafeSend in early April 2026 ahead of Carolynn's Apr 10 cutoff; extension paperwork came back from her on Apr 15 (in 2025/extension-from-carolynn/) and the federal, CO and AZ extension payments have been made.\n\nAwaiting CPA work-up. Nothing was required from the owner at the time unless a still-needed document surfaced.\n\nThe extended filing deadline is Oct 2026, so the actions below are still live — but this record is about 2.5 months old and Carolynn may have moved the draft along since. Confirm status with her before re-doing any of it.\n\nThe open-items list (Walmart 1099-DIV, missed 2025 quarterlies, Colorado 1099-G, the underpayment-penalty estimate, the CP503 notice and the E-Trade cost-basis flag) is already restated near-verbatim in the brief's Open questions / risks section and is not duplicated here.",
      next_steps: [
        {
          id: 'n1',
          text: 'Log into Computershare and pull the Walmart 1099-DIV, or screenshot account-no-activity if the shares were already divested, then tell Carolynn to estimate.',
          kind: 'prose',
        },
        {
          id: 'n2',
          text: 'Pull IRS / CO / OR payment-history screenshots showing 2025 calendar-year activity into 2025/estimated-payments/, and confirm Carolynn has them. No 2025 quarterlies were made (federal $14K/qtr, CO $460/qtr); what the portals do show is the small nanny-payroll federal payments plus the April extension payments already saved.',
          kind: 'prose',
        },
        {
          id: 'n3',
          text: 'Resolve the IRS CP503 notice (2024 balance, $19,499) sitting in 2025/estimated-payments/ — call the IRS or check the transcript — and file the confirmation.',
          kind: 'prose',
        },
        {
          id: 'n4',
          text: 'When Carolynn returns the draft return, review it against 2025/CHECKLIST.md totals before signing, and verify the final return uses the E-Trade Stock Plan Supplement basis rather than the 1099-B noncovered figures.',
          kind: 'prose',
        },
        {
          id: 'n5',
          text: 'After filing, mirror the final return PDF into 2025/ and update INDEX.md with the filing date and delivery method.',
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'titan-platform',
      ended: '2026-07-13T23:16:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-07-13\n\nAudit complete, round-2 research complete, architecture not yet started. No code written, nothing extracted — this initiative is audit + design only so far.\n\nRound 1 audited all sibling agentic projects via parallel agents, producing six cited docs in sources/ plus the extraction map in sources/00-index.md. The conclusion: the platform is mostly an EXTRACTION problem. Nearly every tier already exists somewhere — registry/daemon from active-work; embed, agent, retrieval, sessions, memory and pm from brain; store and code-graph from codewatch; dashboard-kit from titan-design, already shared. `cluster` and `locator` are the only genuinely-new tier-0 pieces, and codewatch is the monorepo template to copy.\n\nRound 2 closed the pre-architecture gaps and all six results are persisted as sources/research-*.md. Its most consequential correction: the brain spike is a DESIGN, not a built or adopted platform — only agent-submission was built, it is untracked, Restate was never integrated, and there was no adoption decision. The earlier "decision memo" claim was wrong and is now corrected everywhere.\n\nTP-1..TP-15 have since been filed, so the handoff\'s "create TP-* tasks" action is already done. The session-miner build (active-work AW-23/27/28) proceeds in parallel and is the first likely consumer of the extracted store / session-read / registry packages.',
      next_steps: [
        {
          id: 'n1',
          text: 'The architecture phase is awaiting owner go-ahead. With the full picture in hand, draft the concrete @titan-design/* package DAG plus extraction sequencing before starting any TP-* build.',
          kind: 'prose',
        },
        {
          id: 'n2',
          text: 'Decide monorepo vs multirepo, and settle the npm-scope inconsistency (@codewatch/* vs @titan-design/*). Both are open and recorded nowhere else.',
          kind: 'prose',
        },
        {
          id: 'n3',
          text: "Settle the workflow-runtime approach: a light scheduler for the miner (herald patterns) now, defer the durable engine to tier-2/product, and when choosing prefer MIT/Apache (DBOS, Hatchet, Trigger) over Restate's BUSL. The SDK is a leaf, not a substrate.",
          kind: 'prose',
        },
        {
          id: 'n4',
          text: 'Optional before starting architecture: pull the final agent-sdk report.',
          kind: 'prose',
        },
        {
          id: 'n5',
          text: 'TP-10 carries two unresolved decisions worth naming: @titan-design/react-ui is real and published but has a single stale consumer (codewatch@0.2.7) and brain never adopted it — it needs a generic-vs-Voltras split AND an RN-Web platform decision.',
          kind: 'task',
          ref: 'TP-10',
        },
      ],
    },
    {
      slug: 'voltras-workspace',
      ended: '2026-07-28T17:29:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-07-28 (late)\n\nNothing is blocked any more. The publish blocker that headed this file for weeks is closed: @titan-design/react-ui@0.12.0 is live on npm (provenance-attested, tag-triggered CI) and voltras-mcp main is on it (7094aa1, PR #213). VW-99 passed all four rows on the wall in run 2, which was the gate.\n\nThe diverging dual stage is built and merged (VMCP-04.05, voltras-mcp #214, main 3382496): the dual view renders real per-slot telemetry as one diverging hero rather than a fixture preview. Decisions worth not re-litigating — tempo and the exertion alert are shared, not per-limb, and sets/reps/load stays on the page-level ExerciseHeader. With neither slot bound the page falls back to the single view.\n\nThe SPA works end to end on real hardware, single-arm. The dual-arm view is still behind the ?variant=live-dual query param.\n\nThe 07-27 postmortem in this file is the reason it was rewritten: handoff.md was 12 days stale and the brief\'s in-flight efforts 22 days stale, the bootstrap priority ordering pointed at VW-68 (now demoted to p30), and the file literally titled "start here" was never opened. That cost a full session.',
      next_steps: [
        {
          id: 'n1',
          text: 'NEXT ACTION: wire the real LiveFatiguePanel into the SPA. No hardware needed. It is the last live piece of VW-76 and the final third of VMCP-05.02 (publish done, SPA bump done, fatigue sidebar outstanding). The queue after it is VMCP-04.06 DualGhostSpark, then 04.07 promoting live-dual out of the query param.',
          kind: 'task',
          ref: 'VW-76',
        },
        {
          id: 'n2',
          text: "Read coordination/NEXT-SESSION-2026-07-28.md FIRST — it is the newest session-close doc and carries the concrete first action, delivery queue, open decisions and traps. Standing guard from the 07-27 postmortem: read the newest coordination/NEXT-SESSION-*.md before trusting the bootstrap's priority ordering, because priority is stale by default and two things the operator cared about had no VW-level task at all.",
          kind: 'prose',
        },
        {
          id: 'n3',
          text: 'Open decision: mapStoreToDualModel no longer has an app caller. It was kept with a note as the only full per-slot DashboardModel projection — delete it and its tests if the LiveFatiguePanel wiring does not need it.',
          kind: 'prose',
        },
        {
          id: 'n4',
          text: "VW-95 demo video is no longer blocked — the titan publish was the gate and the SPA is now on 0.12.0, so a camera sees the current UI. What remains is content, not plumbing: no script and no shot list exist. Before filming with cues on, decide VMCP-05.01 (critical, safety): the mic is deaf during TTS/cues, including the 'stop' phrase.",
          kind: 'task',
          ref: 'VW-95',
        },
        {
          id: 'n5',
          text: 'VW-92 experience_tier is still the cross-cutting blocker. The SCHEMA half is done — training_profile with a declared_tier column shipped in the v9 wave (sqlite-store.ts:369-371) — but the derivation logic and any reader or writer are missing: empty DDL, zero call sites. The design exists in coordination/tier-signal-design.md with no code written. B05/B06/B07/B14/B25/B31 all branch on tier.',
          kind: 'task',
          ref: 'VW-92',
        },
        {
          id: 'n6',
          text: 'VW-96 storage Wave 3 is not started, deliberately: training_profile and exercise_baselines are empty DDL with zero call sites. The WA audit rates baselines the single highest-leverage addition (14 downstream items), and it is a prerequisite for the RP tier work.',
          kind: 'task',
          ref: 'VW-96',
        },
        {
          id: 'n7',
          text: 'RP build order: VW-90 (B15 drift guard, the foundation) → B56/B57 baselines → VW-91 (B04 two-session underperformance/MRV detector, rated highest value: high impact, small effort, buildable now, zero new instrumentation) → B16 → B09/B14. Also real and stalled: VMCP-02.25, plan_suggest_progression is VBT-blind and recommends +5 lb after near-failure sets.',
          kind: 'task',
          ref: 'VW-90',
        },
        {
          id: 'n8',
          text: "Unowned and will fall through the cracks: VMCP-05.19 position→metres conversion — hard serialization, nobody bumps WA to 2.0.0 before this is written or position_units starts lying. Also unowned: the WA 2.0.0 consumer migration, drift-tolerance fit (needs no hardware), and 'what is a setup?' (setup_id / exercise_setups exist on main and are empty).",
          kind: 'prose',
        },
        {
          id: 'n9',
          text: "The bench sitting is the common unblocker. Run all three checklists — they do NOT supersede each other, and two were written the same evening without referencing each other, so 'newest wins' silently drops a gate. Order: Q1 chains direction (frees the stuck WA 2.0.0 publish) → isometric calibration VMCP-02.82 (5 min) → voice/deaf-window → v9 capture run → rep-count and peak-power → guided-load wedge LAST, it may need a power cycle. The titan visual gate is done (VW-85, VW-99) — do not re-run it.",
          kind: 'prose',
        },
        {
          id: 'n10',
          text: '⚠️ The live DB is at v8 and code on main is v9; the next MCP restart migrates it. Back up first — it is a one-way door and a v8 build cannot reopen a v9 file.',
          kind: 'prose',
        },
      ],
    },
    {
      slug: 'youtube',
      ended: '2026-07-27T00:00:00Z',
      session_id: 'handoff-migration',
      body: '# Handoff state as of 2026-07-27\n\nThe extractor is stable and did its job — 84 RP University lectures (~267K words) plus 22 others under sources/out/. Tool-level tasks Y-1/Y-2/Y-3 are unchanged and low priority. The active work is now downstream of the transcripts, not in the tool.\n\nThe last working session (2026-07-26, ~3h, 20 agents, 6 waves) started as "mine the RP transcripts into brain" and became a full foundation audit that redesigned the Voltras data layer. Design complete, zero code written — deliberately, because each audit kept finding the wanted features sat on a foundation that could not support them correctly. That ratio should now flip to building.\n\nDone and durable: the knowledge base is LIVE (386 notes in the voltras-workspace brain instance, all 84 lectures, 2,298 graph edges, 7 retrieval probes passing, entry point rp-cross-cutting-synthesis); a 60-item scored backlog; and ten design/audit docs.\n\nThe MVS has since shipped — voltras-mcp main is at SCHEMA_VERSION = 9 and the putSet INSERT OR REPLACE landmine is defused, so the v5-collision and unrecoverable-data warnings that used to sit here are both resolved. Six backlog items were filed as VW-89..VW-94 in voltras-workspace; the remaining ~50 stay in the backlog doc rather than becoming tickets nobody can start.',
      next_steps: [
        {
          id: 'n1',
          text: "NEXT is hardware, not code: not one capture field has been seen populating from real hardware — everything was verified against mock adapters and DB copies. Run coordination/BENCH-CHECKLIST-v7-capture-and-open-questions.md alongside validation-runbooks/BENCH-2026-07-26-consolidated.md; NEITHER supersedes the other, and 'newest wins' silently drops the titan release gate and the voice deaf-window safety measurement. Back up the DB first — v9 is a one-way door.",
          kind: 'prose',
        },
        {
          id: 'n2',
          text: 'Four decisions are blocked on measurements only the wall can give, one of which (Q1 chains direction) is holding a workout-analytics 2.0.0 npm publish.',
          kind: 'prose',
        },
        {
          id: 'n3',
          text: 'Plan Y-10, Y-11 and Y-12 as ONE schema-and-capture wave — they keep landing on the same tables from different directions.',
          kind: 'prose',
        },
        {
          id: 'n4',
          text: 'Operator decision: the weight_lbs = 0 backfill. Recommendation is NULLIF, with the reasoning in the build handoff; six more decisions sit in migration plan §7.',
          kind: 'prose',
        },
        {
          id: 'n5',
          text: 'Operator decisions still open after the 07-26 pass: the diet-phase tag, the B42 legal review, and ratifying performance-gated deloads. (Settled and not open: advisory-only for stop-set/deload, multi-user now, experiment waits for capture, validate the higher sample rate.)',
          kind: 'prose',
        },
        {
          id: 'n6',
          text: 'The program-level phase plan — sizing phases 1–4 the way phase 0 was sized — was offered but never started. It is what makes the milestone-timing question answerable.',
          kind: 'prose',
        },
      ],
    },
  ],
};
