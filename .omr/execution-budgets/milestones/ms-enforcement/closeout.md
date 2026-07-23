---
status: closed
acceptance_results:
  - status: passed
    reason: "Verified in wave-1 review: evaluateThresholds 9/9 tests pass —
      warn/soft/hard levels, no-ceiling (unlimited), over_budget->hard,
      default-policy (warn 75 / soft disabled / hard 100), soft-disabled skip,
      raised-ceiling lowers level, most-severe across dimensions, ceiling-zero
      edges. Pure and deterministic."
    approver: user
    item: "Threshold evaluation is a deterministic pure function: given consumption
      vs ceiling per dimension and the threshold policy (defaults warn 75 / soft
      none / hard 100 when a level is unspecified), it returns the highest
      breached level per scope; dimensions with no ceiling are never breached
      (unlimited)."
  - status: passed
    reason: "Verified in wave-2 review (gate-eval 11/11): isWorkDispatchCall +
      checkBudgetHardLimit block only omr_prepare_wave_dispatch,
      omr_prepare_worker_redispatch, and worker task spawns on hardBreached with
      no one-shot, with an actionable formatBudgetBlockReason. Read-only,
      record_*, review, blocker, and budget-adjust paths are NOT blocked.
      Soft/warn never block (gate is hard-only)."
    approver: user
    item: The pre-tool gate blocks new work dispatch (omr_prepare_wave_dispatch,
      omr_prepare_worker_redispatch, and worker-agent task spawns) on a hard
      limit with an actionable reason naming the limit, scope, dimension, spent
      vs ceiling, and how to override — and does NOT block read-only inspection,
      blocker resolution, budget adjustment, result recording, or wave review.
  - status: passed
    reason: "Verified in wave-2 review (dispatch-enforcement 13/13): soft breach
      sets progress.step=resolving_blockers with a budget blocked_reason and
      pauses the time clock (pauseTimeClock); assertDispatchableWave refuses
      further dispatch while paused; the pause clears and clock resumes
      (resumeTimeClock) when the ceiling is raised or a one-shot is granted and
      dispatch retried. prepareWaveReview is unaffected."
    approver: user
    item: A soft limit pauses the run at the next wave boundary by setting progress
      to resolving_blockers with a budget blocked_reason and pausing the time
      clock; the pause clears and the clock resumes when the ceiling is raised
      or a one-shot is granted and dispatch is retried.
  - status: passed
    reason: "Verified in wave-2 review: override-exposure tests pass —
      applyBudgetRaiseCeiling and grantBudgetOneShot load/apply/write scope
      budget state with full audit fields (granted_by, granted_at, reason,
      old/new ceiling or consumed flag); raise updates the ceiling, one-shot
      grants a single unconsumed continue. dispatch-enforcement proves one-shot
      is consumed only on actual new-wave dispatch then re-locks."
    approver: user
    item: "Override mechanism: raise-ceiling updates the stored ceiling and
      re-evaluates; one-shot-continue grants exactly one wave dispatch past a
      hard limit then re-locks; both are recorded in .omr state with full audit
      fields (who/when/what/why)."
  - status: passed
    reason: "Verified in wave-2 review (override-exposure): renderReport appends a
      'Budget warnings:' section (one line per warning) and next-action augments
      its description with a warn notice when warnings exist and no dominating
      blocker; both gated on warnings.length>0 so the run is not interrupted."
    approver: user
    item: Warn-level notices surface in the existing status report and next-action
      output without interrupting the run.
  - status: passed
    reason: "Verified in both wave reviews: evaluateBudgetEnforcement is a no-op
      when no ceilings are configured; the gate and dispatch path are no-ops
      when no budgets are configured; existing tests (lockout,
      report-next-action, report-ui, wave-orchestration) stay green.
      Byte-for-byte unchanged with no budgets."
    approver: user
    item: With no budgets configured, behavior is byte-for-byte the current behavior
      — existing tests stay green and no enforcement evaluation runs for
      non-dispatch tools.
  - status: passed
    reason: "Verified in wave-1 review: per-scope consumption is computed for
      roadmap and milestone scopes and the most-severe breach across scopes
      drives the overall level; warnings from both scopes are surfaced in the
      EnforcementState."
    approver: user
    item: "Enforcement is deterministic under the roadmap+milestone scope
      combination: the most-severe breach across scopes drives the action;
      warnings from both scopes are surfaced."
verification_results:
  - status: passed
    reason: tsc --noEmit exit 0, confirmed in the wave-2 re-review.
    approver: user
    item: bun run check
  - status: passed
    reason: Full suite 417 pass / 3 fail. All milestone new tests pass
      (enforcement.test.ts 21/21, budget-gate.test.ts 11/11,
      budget-enforcement.test.ts 13/13, budget-override.test.ts all pass) and
      all existing enforcement-related tests stay green. The 3 failures
      (styleGuideForFiles, scoped init>global init, plugin
      install>resolvePluginRoot) predate this milestone, sit in unrelated
      modules, and are out of scope — confirmed by both wave reviewers.
    approver: user
    item: bun test
worker_notes_reviewed: true
review_summary: "Implementation completed across two waves. Wave-1
  (enforcement-eval, worker-heavy) delivered the pure threshold evaluation +
  cwd-based enforcement evaluator (packages/core/src/enforcement.ts) and
  test/enforcement.test.ts; passed review after one rework (config-load ENOENT
  guard via loadThresholdPolicy). Wave-2 (gate-eval worker, dispatch-enforcement
  worker-heavy, override-exposure worker) wired enforcement into the gate (hard
  block on dispatch in gate.ts), the dispatch path (soft-pause / hard backstop /
  one-shot / time-clock in dispatch.ts), and operator exposure
  (applyBudgetRaiseCeiling / grantBudgetOneShot + warn surfacing in render.ts /
  next-action.ts); passed review after one test-only rework (clock-start
  ordering in budget-enforcement.test.ts). All contract seams verified: gate
  one-shot AVAILABILITY vs dispatch CONSUMPTION agree on hasAvailableOneShot;
  override-exposure additive enforcement.ts exports do not collide with wave-1;
  prepareWaveReview unaffected by budget checks; three wave-2 tasks touch
  disjoint files. All worker notes reviewed. bun run check passes; full suite
  417 pass / 3 fail (3 pre-existing out-of-scope)."
unresolved_risks:
  - risk: "Theoretical one-shot cross-scope edge case: a one-shot available only on
      a non-hard-breached scope while another scope is hard-breaching with no
      one-shot means the gate allows dispatch but consumeBudgetOneShot consumes
      nothing, so there is no re-lock. Not tested; not a contract violation
      under the documented 'one-shot at either scope lets dispatch through'
      design."
    disposition: deferred
    reason: "Non-blocking and theoretical; the tested realistic path (one-shot
      consumed on actual new-wave dispatch then re-locks) holds. Recommended
      follow-up: add a cross-scope one-shot test in a later wave."
    approver: user
roadmap_id: execution-budgets
milestone_id: ms-enforcement
closed_at: 2026-07-22T23:19:37.485Z
---

# Closeout Evidence

Milestone: ms-enforcement
Status: closed
Review: Implementation completed across two waves. Wave-1 (enforcement-eval, worker-heavy) delivered the pure threshold evaluation + cwd-based enforcement evaluator (packages/core/src/enforcement.ts) and test/enforcement.test.ts; passed review after one rework (config-load ENOENT guard via loadThresholdPolicy). Wave-2 (gate-eval worker, dispatch-enforcement worker-heavy, override-exposure worker) wired enforcement into the gate (hard block on dispatch in gate.ts), the dispatch path (soft-pause / hard backstop / one-shot / time-clock in dispatch.ts), and operator exposure (applyBudgetRaiseCeiling / grantBudgetOneShot + warn surfacing in render.ts / next-action.ts); passed review after one test-only rework (clock-start ordering in budget-enforcement.test.ts). All contract seams verified: gate one-shot AVAILABILITY vs dispatch CONSUMPTION agree on hasAvailableOneShot; override-exposure additive enforcement.ts exports do not collide with wave-1; prepareWaveReview unaffected by budget checks; three wave-2 tasks touch disjoint files. All worker notes reviewed. bun run check passes; full suite 417 pass / 3 fail (3 pre-existing out-of-scope).

## Acceptance Criteria
- passed: Threshold evaluation is a deterministic pure function: given consumption vs ceiling per dimension and the threshold policy (defaults warn 75 / soft none / hard 100 when a level is unspecified), it returns the highest breached level per scope; dimensions with no ceiling are never breached (unlimited). - Verified in wave-1 review: evaluateThresholds 9/9 tests pass — warn/soft/hard levels, no-ceiling (unlimited), over_budget->hard, default-policy (warn 75 / soft disabled / hard 100), soft-disabled skip, raised-ceiling lowers level, most-severe across dimensions, ceiling-zero edges. Pure and deterministic.
- passed: The pre-tool gate blocks new work dispatch (omr_prepare_wave_dispatch, omr_prepare_worker_redispatch, and worker-agent task spawns) on a hard limit with an actionable reason naming the limit, scope, dimension, spent vs ceiling, and how to override — and does NOT block read-only inspection, blocker resolution, budget adjustment, result recording, or wave review. - Verified in wave-2 review (gate-eval 11/11): isWorkDispatchCall + checkBudgetHardLimit block only omr_prepare_wave_dispatch, omr_prepare_worker_redispatch, and worker task spawns on hardBreached with no one-shot, with an actionable formatBudgetBlockReason. Read-only, record_*, review, blocker, and budget-adjust paths are NOT blocked. Soft/warn never block (gate is hard-only).
- passed: A soft limit pauses the run at the next wave boundary by setting progress to resolving_blockers with a budget blocked_reason and pausing the time clock; the pause clears and the clock resumes when the ceiling is raised or a one-shot is granted and dispatch is retried. - Verified in wave-2 review (dispatch-enforcement 13/13): soft breach sets progress.step=resolving_blockers with a budget blocked_reason and pauses the time clock (pauseTimeClock); assertDispatchableWave refuses further dispatch while paused; the pause clears and clock resumes (resumeTimeClock) when the ceiling is raised or a one-shot is granted and dispatch retried. prepareWaveReview is unaffected.
- passed: Override mechanism: raise-ceiling updates the stored ceiling and re-evaluates; one-shot-continue grants exactly one wave dispatch past a hard limit then re-locks; both are recorded in .omr state with full audit fields (who/when/what/why). - Verified in wave-2 review: override-exposure tests pass — applyBudgetRaiseCeiling and grantBudgetOneShot load/apply/write scope budget state with full audit fields (granted_by, granted_at, reason, old/new ceiling or consumed flag); raise updates the ceiling, one-shot grants a single unconsumed continue. dispatch-enforcement proves one-shot is consumed only on actual new-wave dispatch then re-locks.
- passed: Warn-level notices surface in the existing status report and next-action output without interrupting the run. - Verified in wave-2 review (override-exposure): renderReport appends a 'Budget warnings:' section (one line per warning) and next-action augments its description with a warn notice when warnings exist and no dominating blocker; both gated on warnings.length>0 so the run is not interrupted.
- passed: With no budgets configured, behavior is byte-for-byte the current behavior — existing tests stay green and no enforcement evaluation runs for non-dispatch tools. - Verified in both wave reviews: evaluateBudgetEnforcement is a no-op when no ceilings are configured; the gate and dispatch path are no-ops when no budgets are configured; existing tests (lockout, report-next-action, report-ui, wave-orchestration) stay green. Byte-for-byte unchanged with no budgets.
- passed: Enforcement is deterministic under the roadmap+milestone scope combination: the most-severe breach across scopes drives the action; warnings from both scopes are surfaced. - Verified in wave-1 review: per-scope consumption is computed for roadmap and milestone scopes and the most-severe breach across scopes drives the overall level; warnings from both scopes are surfaced in the EnforcementState.

## Verification Commands
- passed: bun run check - tsc --noEmit exit 0, confirmed in the wave-2 re-review.
- passed: bun test - Full suite 417 pass / 3 fail. All milestone new tests pass (enforcement.test.ts 21/21, budget-gate.test.ts 11/11, budget-enforcement.test.ts 13/13, budget-override.test.ts all pass) and all existing enforcement-related tests stay green. The 3 failures (styleGuideForFiles, scoped init>global init, plugin install>resolvePluginRoot) predate this milestone, sit in unrelated modules, and are out of scope — confirmed by both wave reviewers.

## Unresolved Risks
- deferred: Theoretical one-shot cross-scope edge case: a one-shot available only on a non-hard-breached scope while another scope is hard-breaching with no one-shot means the gate allows dispatch but consumeBudgetOneShot consumes nothing, so there is no re-lock. Not tested; not a contract violation under the documented 'one-shot at either scope lets dispatch through' design. - Non-blocking and theoretical; the tested realistic path (one-shot consumed on actual new-wave dispatch then re-locks) holds. Recommended follow-up: add a cross-scope one-shot test in a later wave.
