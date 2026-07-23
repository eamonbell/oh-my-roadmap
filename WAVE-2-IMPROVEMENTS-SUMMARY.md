# Wave 2 Improvements — Summary

This document tracks the second implementation wave of recommendations from
`RECOMMENDED-IMPROVEMENTS.md`. Wave 1 covered the "quick wins" cluster; Wave 2 was scoped to the
"state-integrity" cluster it deliberately deferred — the review→blocker pipeline, verification
baselining, and a first-class rework marker — plus the closely related worker self-verification
and next-action staleness fixes that build on the same state.

**Result:** all five targeted recommendations (R1, R3, R4, R8, R12) were implemented, reviewed,
and the full test suite is green at **504 passing tests**, with `bun run check` (`tsc --noEmit`)
clean. `RECOMMENDED-IMPROVEMENTS.md`'s headings and its §5 ranked-summary table now carry
`✅ Implemented (Wave 2)` markers for each shipped item.

---

## Per-recommendation changes

### R1 — Review-findings → blocker pipeline overhaul
`omr_record_wave_review` now accepts `structured_findings: [{severity, text, task_id?}]` with
severities `pass | advisory | blocking_worker_fixable | blocking_needs_user`. Routing lives in
`recordWaveReview` (`packages/core/src/wave-orchestration/review.ts`): `pass`/`advisory` findings
are dropped; `blocking_needs_user` opens a canonical blocker (deduped against an existing one the
same way the legacy string path already did); `blocking_worker_fixable` becomes a
`ReworkQueueItem` appended to `progress.rework_queue` instead of a blocker. A plain string
`findings` array is still accepted and behaves exactly as before (back-compat).

Sub-agent blocking notes get the same routing at the note layer: `omr_append_note`'s
`blockingKind` (`packages/core/src/store/blockers.ts`) — `needs_user` (or unlabeled, for
back-compat) mints a canonical blocker; `worker_fixable` is recorded as an advisory note with no
blocker minted.

Blocker-lifecycle actor attribution (`open_blocker`/`resolve_blocker`/`defer_blocker`) now
defaults to `'orchestrator'` when no explicit actor is supplied, and is never silently attributed
to `'user'`. `resolveBlockerImpl` accepts a blocker in either `open` or `deferred` status, so a
deferred blocker can be resolved once the deferred issue is actually fixed. The write-gate
(`packages/core/src/validation.ts`) exempts a blocker whose id matches the `rework_of` marker on
an active worker run, alongside the pre-existing task/wave rework exemption, so a worker
reworking a finding isn't blocked by the very blocker it's fixing.

Persistence: `format.ts` round-trips `rework_queue`, and `update_implementation_progress`
(`plans.ts`) carries `rework_queue`/`verification_baseline` forward across ordinary progress
transitions instead of dropping them.

### R3 — Scoped worker self-verification
Worker prompts built in `packages/core/src/wave-orchestration/dispatch.ts` always mandate LSP
diagnostics (`xd://lsp`) on every touched file before yield. Running the task's own
`verification_commands` against its **owned files** is additionally permitted only when the wave
has a single worker, or the dispatch is a genuine rework (`reworkOf` set on the redispatch) — a
full test suite, whole-project build, or anything touching unowned files is always banned. Workers
are instructed to record the exact commands they ran (a "Commands run:" section and/or "VERIFIED:"
lines) as receipts in their note.

`prepareWaveReview` (`packages/core/src/wave-orchestration/review.ts`) parses those receipts out
of worker notes (`parseWorkerCommandReceipts`/`extractWorkerCommands`) and surfaces them to the
reviewer as `worker_command_receipts`. The updated `reviewPrompt()` tells the reviewer to verify
those receipts as a starting point rather than re-discovering everything, then run the plan's
milestone-level verification commands once for the whole wave.

### R4 — Verification baseline at implementation start
A new tool, `omr_record_verification_baseline` (`packages/extension/src/tools/register/baseline-tools.ts`),
backed by `recordVerificationBaseline` (`packages/core/src/wave-orchestration/baseline.ts`),
records `progress.verification_baseline` — the pre-existing failing tests/counts an agent
observed by running the plan's verification commands once before any wave starts. It requires the
implementing phase and is idempotent (recording again replaces the prior baseline). `prepareWaveReview`
includes the baseline in its package when present, and the reviewer prompt instructs judging each
wave "no NEW failures, no lost passes versus that baseline" rather than an absolute
full-suite-green bar; pre-existing baseline failures are informational.

### R8 — Phase-aware, never-stale next_action
`report/next-action.ts`'s `resolving_blockers` branch (`packages/core/src/report/next-action.ts:331`)
now recomputes against live state instead of a static `blocked_reason`: a pending `rework_queue`
item recommends waking the worker for that task (status stays actionable, not `blocked`); open
blockers recommend resolving them (read live, not from a stale cached reason); once every blocker
for the wave is resolved or deferred, it recommends the concrete unblock
(`omr_transition update_wave_status`) instead of a stale "resolve blocker" hint that no longer
applies. `omr_init` (`packages/core/src/store/roadmap.ts:130`) now rejects `discovery.recorded:
true` at init with a loud error directing the caller to the `record_discovery` transition, closing
the discovery-phase gap where init could silently mark discovery done.

This recommendation's discovery/init half was addressed by that targeted, loud rejection at
`omr_init`, not a broader phase-aware redesign of the discovery step itself — see Key design
decisions below.

### R12 — First-class rework marker
`WorkerRun` gained a `rework_of` field. `recordWorkerDispatch` and `prepareWorkerRedispatch`
(`packages/core/src/wave-orchestration/dispatch.ts`) both thread an optional `reworkOf` through to
it, independently of `replaces_agent_id` (a run can be a rework without replacing anyone, and vice
versa). The agent-facing tool schemas — `omr_record_worker_dispatch` and
`omr_prepare_worker_redispatch` (`packages/extension/src/tools/register/wave-tools.ts`) — expose
`reworkOf` as a camelCase Zod field, matching the existing `replacesAgentId` naming convention.
`format.ts` round-trips `rework_of`. The shared `REVIEWER_REWORK_RULE` constant in
`packages/extension/src/extension/commands/rule-text.ts` and the mirrored SKILL.md prose instruct
agents to pass `reworkOf` when dispatching a rework worker.

---

## Key design decisions

- **Structured-findings wire format keeps the string fallback.** Rather than requiring every
  caller to migrate to `structured_findings` immediately, `recordWaveReview` checks whether
  `structured_findings` is present and non-empty and only then uses the new routing; an absent or
  empty array falls through to the original string-`findings` behavior verbatim.
- **Actor defaults to `'orchestrator'`, not required-explicit.** `openBlocker`/`resolveBlocker`/
  `deferBlocker` trim and use an explicit actor when given, but fall back to `'orchestrator'`
  rather than throwing when omitted — the goal was eliminating the false `'user'` attribution, not
  forcing every call site to thread an actor argument.
- **Note auto-mint routed by `blockingKind`, unlabeled still mints.** `shouldMintCanonicalBlocker`
  treats an absent `blockingKind` the same as legacy behavior (mint) so existing callers that pass
  `blocking: true` without a kind are unaffected; only an explicit `worker_fixable` kind suppresses
  the blocker.
- **Relax-resolve instead of a new reopen operation.** A deferred blocker becoming resolvable was
  implemented by loosening `resolveBlockerImpl`'s guard (`status !== 'open' && status !==
  'deferred'` now throws, everything else resolves) rather than adding a separate
  reopen-then-resolve operation — deferred blockers were already a disposition a worker fix could
  retroactively satisfy.
- **A dedicated baseline tool, because core can't run tests.** `recordVerificationBaseline` only
  persists `command_results` an agent supplies; core is a pure state engine with no shell access,
  so the tool's contract is explicitly "you ran the commands, hand me the results" rather than
  core running anything itself.
- **R3's conditional-test permission is limited to single-worker-wave OR rework.** A more
  general cross-import/dependency analysis (permitting owned-file tests whenever no sibling task
  imports the same module, say) was intentionally skipped as higher-complexity and harder to audit
  than the two clean, easily-inspectable conditions actually implemented.
- **Reused the existing `resolving_blockers` progress step; no new enum value.** Rather than
  adding a distinct progress step for "pending rework" vs "open blockers," `next-action.ts`
  distinguishes the two by inspecting `progress.rework_queue` first and falling back to live
  blockers — keeping `ImplementationProgressStep` unchanged.
- **`reworkOf` is camelCase for tool-param consistency**, mirroring the existing
  `replacesAgentId` naming already used by the same tools, even though the underlying stored field
  is `rework_of` (matching the rest of `WorkerRun`'s snake_case shape).
- **The `format.ts`/`plans.ts` persistence fix was necessary, not incidental.** Without carrying
  `rework_queue`/`verification_baseline` forward through `update_implementation_progress`, every
  ordinary wave-status transition would silently drop them — this was caught and fixed as part of
  R1/R4's plumbing, not a separate recommendation.

---

## Validation signals now covered by tests

- **R1 — severity routing, dedup, and rework-queue population:**
  `blocking_worker_fixable` findings queue rework and open no blockers; a finding without a
  `task_id` falls back to the wave's single active task; `blocking_needs_user` opens exactly one
  canonical blocker; mixed findings route correctly and drop `pass`/`advisory`; an all-pass/
  advisory failed review still blocks the wave with nothing queued; legacy string `findings` still
  mint blockers as before. (`test/state/review-findings-pipeline.test.ts`)
- **R1 — blocker lifecycle integrity:** a blocking note mints a canonical blocker only for
  `needs_user`/unspecified findings; `resolveBlocker`/`deferBlocker` default the actor to
  `'orchestrator'`, never `'user'`; a deferred blocker can be resolved (deferred → resolved),
  preserving defer history; a blocker whose id is a running rework worker's `rework_of` is exempt
  from the open-blocker gate. (`test/state/blocker-lifecycle-r1.test.ts`)
- **R1/R4 — progress persistence:** `rework_queue`/`verification_baseline` survive ordinary
  progress transitions rather than being dropped by `update_implementation_progress`.
  (`test/state/progress-persistence.test.ts`)
- **R3 — worker verification permission:** a single-task wave permits owned-file
  `verification_commands` and always mandates LSP; a multi-task fresh dispatch withholds
  owned-file tests but still mandates LSP; a genuine rework redispatch (`reworkOf` set) permits
  owned-file tests even in a multi-task wave; a plain transport-failure/abandon redispatch (no
  `reworkOf`) with a running sibling still withholds owned-file tests; all prompts instruct
  recording command receipts; redispatch instructions mention `reworkOf` when passed through.
  (`test/state/rework-dispatch.test.ts`)
- **R3 — reviewer package receipt surfacing:** the reviewer package surfaces a captured
  `verification_baseline` and pending `rework_queue` items for the active wave; command receipts
  are parsed from a "Commands run:" marker in a worker note, and omitted when no note carries one.
  (`test/state/review-findings-pipeline.test.ts`)
- **R4 — baseline recording:** covered in `test/state/verification-baseline.test.ts` and the
  reviewer-package surfacing test above.
- **R8 — next-action staleness:** `resolving_blockers` with all blockers disposed recommends a
  concrete unblock instead of a stale blocked hint; a pending `rework_queue` item drives a
  wake-worker action, not `blocked`; the rework hint reports the count when several items are
  pending; discovery phase always recommends `record_discovery`, never the roadmap-milestone
  check; `omr_init` rejects `discovery.recorded=true` loudly instead of silently accepting it.
  (`test/state/next-action-staleness.test.ts`)
- **R12 — rework marker persistence and threading:** `recordWorkerDispatch` persists `rework_of`
  independently of `replaces_agent_id`; can carry both together; omits `rework_of` when not
  supplied. (`test/state/rework-dispatch.test.ts`)
- **R12 — tool-schema threading:** `omr_record_worker_dispatch` persists `WorkerRun.rework_of` set
  via the Zod tool schema; `omr_prepare_worker_redispatch`'s schema accepts `reworkOf` and marks
  the assignment as rework. (`test/tools/wave-tools.test.ts`)

Full suite: **504 tests passing**, `bun run check` clean.

---

## Deferred / follow-ups

Intentionally **not** in this batch, to keep Wave 2 a coherent state-integrity + self-verification
unit:

- **R11 — Later-wave ownership map in reviewer package.** Independent, review-package-only
  enhancement; not required by R1/R3/R4's routing changes.
- **R16 — Worker context-hygiene rules (batch reads, trust receipts).** A prompt-only efficiency
  item that pairs naturally with the receipt convention R3 just introduced, but was left for a
  dedicated pass rather than folded in here.
- **R17 — `xd://` JSON tolerance + invocation examples + phase preconditions in docs.** Tier-3
  transport/documentation item, orthogonal to this wave's state-machine changes.
- **R19 — Per-role model tier guidance (+ future escalate-on-failure).** Documentation-only
  recommendation about model tiering; the escalate-on-failure half would build naturally on R12's
  new `rework_of` marker (an escalation could redispatch a rework one tier up) but wasn't in scope.
- **R20 — Rework-loop iteration cap + dogfood budgets.** Builds directly on R1's rework queue: a
  loop cap needs the rework queue's per-item history to count iterations. Left for a follow-up now
  that the queue exists.
- **R21–R24 and F1–F4.** The original evaluation's remaining Tier-3 items and net-new feature
  proposals. Several — notably any escalate-on-rework or rework-history feature (akin to F1) —
  build directly on the state Wave 2 introduced (`rework_queue`, `verification_baseline`,
  `rework_of`), which is why Wave 2 was sequenced first.

Together, R1's `rework_queue`, R4's `verification_baseline`, and R12's `rework_of` marker are new,
persisted state surfaces that several of the deferred items above depend on — this wave was
sequenced to unlock them, not just close out the individually-named recommendations.
