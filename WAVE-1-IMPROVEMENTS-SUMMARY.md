# Wave 1 Improvements — Summary

This document tracks the first implementation wave of recommendations from
`RECOMMENDED-IMPROVEMENTS.md` (the execution-budgets roadmap evaluation). Wave 1 was scoped to
the "quick wins" cluster: low-to-medium complexity fixes that did not require redesigning core
state machines (blocker lifecycle, review→blocker pipeline, verification baselining). Those
larger items were deliberately deferred to a dedicated "state-integrity" wave — see
[Deferred / follow-ups](#deferred--follow-ups).

**Result:** all 10 targeted recommendations (R2, R5, R6, R7, R9, R10, R13, R14, R15, R18) were
implemented, reviewed with a PASS verdict, and the full test suite is green at **467 passing
tests**. Both `RECOMMENDED-IMPROVEMENTS.md` headings and its §5 ranked-summary table now carry
`✅ Implemented (Wave 1)` markers for each shipped item.

---

## Per-recommendation changes

### R2 — Reviewer wake-don't-respawn
Reviewers now get the same lease/reuse machinery workers already had. A durable `reviewer_runs`
list was added to implementation-progress state (preserved across
`update_implementation_progress` transitions, given a backward-compatible default on load in
`format.ts`, and included in the events/audit snapshot). A new `omr_record_reviewer_dispatch`
tool records who reviewed a wave, and `omr_prepare_wave_review` now returns `re_review`,
`prior_reviewer_agent_id`, and `prior_findings` so re-review goes through the tool instead of
being hand-composed. Prompt and skill prose were rewritten so the orchestrator prefers waking the
same reviewer, with an explicit fresh-eyes escape hatch when rework materially expands scope.

### R5 — Milestone-count parsimony
The roadmap-planner skill gained a parsimony rule symmetric to the existing anti-narrow rule
(merge undersized milestones with a neighbor), plus a requirement to include an
expected-waves/tasks estimate per milestone in the roadmap outline. The
`roadmap-milestone-checker` template gained a matching **advisory** (non-hard-fail) check for
over-fragmentation and undersized milestones, mirroring its existing "too narrow" question.

### R6 — Wave auto-advance after passed review
`recordWaveReview(passed)` (`packages/core/src/wave-orchestration/review.ts`) now auto-advances
`progress.active_wave_id` in-place to the next pending wave, or to `closeout_ready` if none
remain — eliminating the guaranteed "Active wave wave-N is already complete" two-step call tax.
The guard against advancing into a non-pending next wave was preserved.

### R7 — Redispatch accepts abandoned runs
`prepareWorkerRedispatch` (`packages/core/src/wave-orchestration/dispatch.ts`) now accepts runs
in either `abandoned` or `transport_failed` state, so the documented
`record_worker_abandoned` → `prepare_worker_redispatch` sequence actually works end-to-end. The
refuse-while-running guard and the disambiguate-multiple-runs guard were both preserved; the
tool's description text was updated to match.

### R9 — Self-overlap false positive in plan validation
`plan-validation.ts` no longer flags a false `wave.ownership.overlap` when a single task lists
the same path in both `owned_files` and `owned_modules`. The fix guards on `previous !== task.id`
and dedupes per-task before comparison; genuine cross-task ownership overlap is still correctly
flagged.

### R10 — Scout-finding recording
The milestone-planner skills and the `rm-new`/`ms-plan` prompts now require recording durable
repo-structure discoveries (test layout, module map, cross-cutting conventions) via
`omr_record_scout_finding` at the end of discovery/planning, regardless of whether scouting was
done inline by the planner or delegated to a scout sub-agent.

### R13 — `append_note` status enum
The `omr_append_note` tool's `status` parameter was renamed to `blocker_status`, scoping it
explicitly to the blocker lifecycle (`open|resolved|deferred`) and clarifying in its description
that it is not a task-status field. Core behavior is unchanged; this is a naming/documentation
fix at the tool-registration boundary.

### R14 — Planner write-gate rejection text
The gate rejection message shown when a planning-phase agent attempts a file write now says
accurately that planning agents don't write files at all, and directs the agent to
`omr_read_state scope=roadmap_checker_package` — rather than implying the write would become
legal once the pending check clears. A matching note was added to the roadmap-planner skill.

### R15 — Uniform rich receipts
All bare-string mutating tools now return a rich receipt (`{...details, next_actions}` plus a
"Next action:" line) via a shared `receiptResult` helper, matching the shape transition receipts
already had. The helper preserves an existing precise `next_actions` hint (e.g. R6's auto-advance
message) instead of clobbering it with a generic one. `omr_prepare_closeout` also gained a
conditional next-action hint when `start_closeout` must precede `record_closeout`.

### R18 — Single-source shared prose
The worker/reviewer-rework rules and the scout-recording rule — previously duplicated verbatim
across `prompts.ts` and the SKILL.md files, with drift risk — were extracted to shared TS
constants in `packages/extension/src/extension/commands/rule-text.ts`, imported by `prompts.ts`.
A new drift test (`test/skill-rule-drift.test.ts`) asserts the SKILL.md copies stay in sync with
the canonical TS source.

---

## Key design decisions

- **R6 — in-place auto-advance, not receipt-only.** Rather than just handing the orchestrator the
  advance-transition payload in the failure receipt (the doc's alternative option), `review.ts`
  performs the advance itself when a passed review clears the wave. This removes the two-step tax
  entirely instead of merely making the second call one-shot recoverable.
- **R2 — dedicated `reviewer_runs`, not a role tag on `worker_runs`.** A separate list keeps
  reviewer lease semantics (and their distinct lifecycle: dispatch → re-review → resolved)
  independent of worker-run bookkeeping, and avoids overloading `worker_runs` filters/queries with
  a role discriminator everywhere they're read.
- **R13 — rename, not alias or doc-only fix.** `blocker_status` was chosen over keeping `status`
  with normalization logic or leaving the ambiguity documented-only, because the enum's blocker-
  only semantics were the actual source of the worker's rejection; a clear name removes the
  footgun rather than papering over it.
- **R15 — sweep-all with hint-preservation, not case-by-case patches.** Every bare-string mutating
  tool was converted through one shared helper (`receiptResult`) rather than hand-patching each
  call site, but the helper explicitly checks for and preserves any already-precise
  `next_actions` (notably R6's auto-advance hint) so the uniform-receipt sweep can't regress a
  more specific existing hint into a generic one.
- **R18 — TS constants + drift test, not a one-time manual sync.** Single-sourcing the prose in
  TS constants (rather than just editing both copies to match once) plus a permanent drift test
  ensures future edits to either prompts.ts or SKILL.md can't silently re-diverge.
- **R5 — advisory, not hard-fail.** The fragmentation/undersized-milestone check in
  `roadmap-milestone-checker` is deliberately non-blocking: milestone sizing is a judgment call
  with legitimate exceptions (the roadmap's own ms-operator-surface was defensibly standalone
  despite being smaller), so the check surfaces guidance rather than gating approval.

---

## Validation signals now covered by tests

Regression tests were added throughout, each keyed to a specific evaluation-doc validation
signal:

- **R6:** no "already complete" error on the standard passed-review → next-wave-dispatch path;
  correct transition to `closeout_ready` when no next wave exists; the not-pending guard still
  refuses to auto-advance into a non-pending wave. (`test/state/wave-orchestration.test.ts`)
- **R7:** `prepareWorkerRedispatch` succeeds for an `abandoned` run; the disambiguate-multiple-
  runs guard still fires correctly when more than one candidate run exists.
  (`test/state/wave-orchestration.test.ts`)
- **R9:** both the same-task same-path case (no longer a false positive) and genuine cross-task
  overlap (still correctly flagged) are covered. (`test/state/plan-validation.test.ts`)
- **R2:** `reviewer_runs` persistence across progress transitions, and `re_review` /
  `prior_reviewer_agent_id` / `prior_findings` returned correctly from `prepare_wave_review` on a
  second pass. (`test/state/reviewer-runs.test.ts`, plus the tool-level
  `omr_record_reviewer_dispatch` persistence test in `test/tools/action-tools.test.ts`)
- **R13:** `blocker_status` accepted and validated as the blocker-lifecycle field.
  (`test/tools/action-tools.test.ts`)
- **R15:** rich receipt shape (`next_actions` + "Next action:" text) on previously bare-string
  tool returns; `record_wave_review`'s auto-advance hint is preserved rather than overwritten by
  the generic receipt wrapper; `prepare_closeout`'s conditional start-before-record hint only
  fires when applicable. (`test/tools/action-tools.test.ts`)
- **R18:** drift test asserts SKILL.md prose for the worker/reviewer-rework and scout-recording
  rules matches the canonical `rule-text.ts` constants byte-for-byte.
  (`test/skill-rule-drift.test.ts`)

Full suite: **467 tests passing**, `bun run check` clean.

---

## Deferred / follow-ups

Intentionally **not** in this batch — these require a state-machine redesign, not a cheap fix,
and were called out in the evaluation as deserving their own focused milestone with regression
tests keyed to the transcript signals:

- **R1 — review-findings → blocker pipeline overhaul.** Severity model (`pass | advisory |
  blocking_worker_fixable | blocking_needs_user`), no more auto-minting blockers from every
  blocking note, gate exemption for in-flight rework, resolvable deferred blockers, honest actor
  attribution. This is the single largest defect cluster in the evaluation and touches
  `store/blockers.ts`, `wave-orchestration/review.ts`, and `validation.ts` together.
- **R4 — verification baseline at `start_implementation`.** Requires persisting a baseline
  snapshot and changing reviewer verdict semantics to "no new failures vs baseline" — a real
  behavior change to the review contract, not a copy/receipt fix.
- **R8 — phase-aware, never-stale `omr_next_action`.** Fixing the `omr_init` discovery gap and
  the stale post-deferral wave-unblock hint both touch `report/next-action.ts`'s core recommendation
  logic across multiple phases; this needs careful sequencing with R1 since one of the two
  observed stalls was a blocker-disposition next_action, not a pure lookup bug.

Together **R1 + R4 + R8** form the intended "state-integrity" wave and are the natural next
batch.

Everything below R8 in the original ranking (R3, R11, R12, R16, R17, R19, R20, R21–R24, F1–F4)
was also left untouched in this batch — most either depend on R1/R3's worker-verification
redesign, are Tier-3 efficiency/portability items, or are net-new feature proposals (F1–F4) out
of scope for a bug-fix wave.

**Minor follow-up noted during the work:** `recordWaveReview`'s new auto-advance (R6) and
closeout do not currently clear `active_wave_id` once closeout begins — this was judged benign
(closeout reads `runtime.yml`'s wave list independently and doesn't rely on `active_wave_id`
being cleared) but is worth an explicit clear in a future pass for auditability.

This batch did not touch R1, R3, R4, or R8 — no claims above should be read as covering those
recommendations.
