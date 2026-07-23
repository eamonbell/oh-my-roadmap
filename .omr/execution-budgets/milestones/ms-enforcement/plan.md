---
roadmap_id: execution-budgets
milestone_id: ms-enforcement
title: "Enforcement: threshold policy, gate integration, and overrides"
status: milestone_approved
approvals:
  - by: user
    at: 2026-07-22T22:12:48.320Z
    summary: "ms-enforcement plan approved: 4 tasks / 2 waves. Wave 1 delivers the
      enforcement evaluation core (enforcement.ts); wave 2 wires the gate
      hard-block, dispatch soft-pause + time-clock, and override application +
      warn surfacing in parallel. Wave-flow check passed; state valid."
open_questions: []
verification_commands:
  - bun run check
  - bun test
acceptance_criteria:
  - "Threshold evaluation is a deterministic pure function: given consumption vs
    ceiling per dimension and the threshold policy (defaults warn 75 / soft none
    / hard 100 when a level is unspecified), it returns the highest breached
    level per scope; dimensions with no ceiling are never breached (unlimited)."
  - The pre-tool gate blocks new work dispatch (omr_prepare_wave_dispatch,
    omr_prepare_worker_redispatch, and worker-agent task spawns) on a hard limit
    with an actionable reason naming the limit, scope, dimension, spent vs
    ceiling, and how to override — and does NOT block read-only inspection,
    blocker resolution, budget adjustment, result recording, or wave review.
  - A soft limit pauses the run at the next wave boundary by setting progress to
    resolving_blockers with a budget blocked_reason and pausing the time clock;
    the pause clears and the clock resumes when the ceiling is raised or a
    one-shot is granted and dispatch is retried.
  - "Override mechanism: raise-ceiling updates the stored ceiling and
    re-evaluates; one-shot-continue grants exactly one wave dispatch past a hard
    limit then re-locks; both are recorded in .omr state with full audit fields
    (who/when/what/why)."
  - Warn-level notices surface in the existing status report and next-action
    output without interrupting the run.
  - With no budgets configured, behavior is byte-for-byte the current behavior —
    existing tests stay green and no enforcement evaluation runs for
    non-dispatch tools.
  - "Enforcement is deterministic under the roadmap+milestone scope combination:
    the most-severe breach across scopes drives the action; warnings from both
    scopes are surfaced."
cleanup_policy: approval-gated
user_interview:
  - "Soft-pause state model: user chose to reuse the existing resolving_blockers
    step with a budget blocked_reason (no new ImplementationProgressStep), so
    the existing pause/dispatch-refusal/next-action machinery applies. Chosen
    over adding a dedicated budget_paused step to avoid touching the step enum
    and ~4 dependent sites."
  - "Warn surfacing boundary: user chose to hook evaluateBudgetEnforcement
    warnings into the existing renderReport (status) and nextAction paths as
    additive notice lines, with no new commands this milestone (command UI/CLI
    is ms-operator-surface)."
  - "Test coverage: user selected new tests for threshold evaluation, gate
    enforcement decision (including read-only path preservation), override
    application, and soft-pause + time-clock. Read-only path preservation is
    covered within the gate enforcement decision tests."
  - "Roadmap + milestone scope combination (decided): both scopes are evaluated;
    the most-severe breach across scopes drives warn/soft/hard; warnings from
    both are surfaced. A dimension with no ceiling is unlimited."
  - "Gate block scope (decided): hard limit blocks only
    omr_prepare_wave_dispatch, omr_prepare_worker_redispatch, and worker-agent
    task spawns; everything else stays allowed to preserve the
    read-only/recovery/budget-adjustment path."
  - "Time clock (decided): enforcement owns start-at-first-dispatch,
    pause-on-soft-pause, resume-on-continue per scope (roadmap + milestone);
    time budgets count only from when enforcement is active."
  - "Override boundary (decided): this milestone provides the core apply
    functions (raise-ceiling, grant one-shot) that operator-surface commands
    will call; overrides are applied via these functions, not config file
    edits."
  - "One-shot consumption (decided): a one-shot is consumed only when actually
    dispatching a new wave, not when prepareWaveDispatch returns already-running
    workers."
relevant_existing_code:
  - "packages/core/src/budget.ts — delivered model: BudgetDimension,
    BudgetCeiling, BudgetScopeState, ConsumptionResult,
    computeConsumption(totals, elapsedMs, ceiling), applyRaiseCeiling,
    grantOneShotContinue, hasAvailableOneShot, consumeOneShot,
    normalizeBudgetScopeState. Enforcement consumes these; does not duplicate
    them."
  - "packages/core/src/elapsed-time.ts — delivered pure clock: TimeTracking,
    startTimeClock, pauseTimeClock, resumeTimeClock, getElapsedMs,
    emptyTimeTracking. Enforcement wires start/pause/resume into the dispatch
    lifecycle."
  - packages/core/src/project-init.ts:57-83,283-333 — BudgetThresholdPolicy
    {warn?,soft?,hard?} (integer 0-100; undefined = disabled), BudgetConfig,
    RoadmapProjectConfig.budgets. Defaults warn 75 / soft none / hard 100
    applied at consumption time when a level is unspecified (not stored in
    config).
  - "packages/core/src/usage.ts:7-32,196 — UsageTotals, RoadmapUsageSummary
    (total: UsageTotals, milestones: Record<string, MilestoneUsageSummary>),
    loadUsageSummary(cwd, roadmapId). Enforcement reads per-scope totals for
    consumption."
  - "packages/core/src/gate.ts:81-111 — shouldBlockToolCall: lockout gate then
    write-gate. Budget hard-limit check is added here, scoped to dispatch tools
    only. resolveDispatch (21-56) and isOmrToolCall (58-75) recover omr device
    names and detect omr-agent task spawns to reuse."
  - packages/core/src/wave-orchestration/dispatch.ts:228-285,287-366 —
    prepareWaveDispatch and prepareWorkerRedispatch both call
    assertImplementationReady before dispatching. Budget dispatch assertion
    (soft-pause / hard backstop / one-shot consume / clock) hooks in here, NOT
    in review.
  - packages/core/src/wave-orchestration/context.ts:56-62,118-125 —
    assertImplementationReady, assertDispatchableWave (throws on
    resolving_blockers). The soft-pause reuses resolving_blockers so
    assertDispatchableWave refuses dispatch while paused.
  - packages/core/src/validation.ts:405-479 — validateImplementationGate; not
    modified (budget enforcement is a separate, narrower assertion than the
    phase/approval/blocker gate).
  - packages/core/src/types.ts:206-253 — IMPLEMENTATION_PROGRESS_STEPS
    (resolving_blockers reused for soft-pause),
    ImplementationProgress.blocked_reason carries the budget pause reason.
  - packages/core/src/store/persistence.ts:151-248,490 —
    load/writeRoadmapBudgetState, load/writeMilestoneBudgetState (exported via
    store/index.ts). Enforcement reads/writes per-scope budget state for
    consumption, overrides, and the time clock.
  - packages/core/src/report/render.ts:7-55 — renderReport assembles status
    (validateImplementationGate, nextAction, usageLines). Warn notice lines hook
    in here.
  - packages/core/src/report/next-action.ts:282-329 — progressNextActionPlan
    handles resolving_blockers (surfaces the soft-pause). Warn notice augments
    the description.
  - packages/extension/src/extension/tools/register/wave-tools.ts:41-82 —
    omr_prepare_wave_dispatch, omr_record_worker_dispatch,
    omr_prepare_worker_redispatch device names (the dispatch tools the gate
    classifies).
  - test/lockout.test.ts — existing shouldBlockToolCall tests (lockout). Budget
    gate tests go in a dedicated test/budget-gate.test.ts to keep concerns
    separate.
  - test/budget.test.ts:1-48 — test conventions (bun:test, mkdtemp temp dirs,
    @oh-my-roadmap/core imports). New enforcement tests follow this pattern.
relevant_documentation: []
decisions:
  - "Soft-pause reuses resolving_blockers + a budget blocked_reason; no new step
    enum value. Rationale: reuses existing pause, dispatch-refusal
    (assertDispatchableWave), and next-action surfacing with zero blast radius;
    the blocked_reason disambiguates budget pauses from task blockers."
  - Threshold evaluation lives in a new packages/core/src/enforcement.ts (pure
    evaluateThresholds + cwd-based evaluateBudgetEnforcement), keeping budget.ts
    as the pure model. enforcement.ts is the single evaluation source consumed
    by the gate, dispatch path, and report.
  - Gate hard-limit check runs ONLY for dispatch tools
    (omr_prepare_wave_dispatch, omr_prepare_worker_redispatch, worker-agent task
    spawns); non-dispatch tools never invoke budget evaluation, preserving the
    read-only/recovery path and keeping the common path cheap.
  - Soft/warn never block in the gate; the gate is hard-only. Soft-pause and
    warn-surfacing happen in the dispatch path and report/next-action
    respectively.
  - One-shot consumption happens at new-wave dispatch (when prepareWaveDispatch
    actually dispatches, not when it returns already-running workers), so a
    one-shot is never wasted.
  - "Override application is lazy-clear: raising a ceiling or granting a
    one-shot does not auto-flip the progress step; the next dispatch attempt
    re-evaluates and clears the pause + resumes the clock if the breach is
    resolved."
  - Roadmap and milestone budgets are both evaluated; the most-severe breach
    across scopes drives the action. A scope with no ceilings contributes no
    enforcement (backward-compatible no-op).
dependency_analysis:
  - "enforcement-eval is the foundation: it defines the evaluation contract
    (evaluateBudgetEnforcement, evaluateThresholds, EnforcementState,
    BudgetWarning, formatBudgetBlockReason) consumed by gate-eval,
    dispatch-enforcement, and override-exposure. It depends only on the
    already-delivered budget/usage/config modules, so it has no
    milestone-internal dependency and runs alone in wave-1."
  - gate-eval, dispatch-enforcement, and override-exposure all depend on
    enforcement-eval (they import from enforcement.ts), so they run in wave-2
    after wave-1 completes.
  - "The three wave-2 tasks are mutually independent: gate-eval owns gate.ts;
    dispatch-enforcement owns dispatch.ts + context.ts; override-exposure owns
    enforcement.ts (additive override functions), render.ts, and next-action.ts.
    No shared files, so they run concurrently with no ownership collision."
  - dispatch-enforcement consumes consumeOneShot + store writers directly (from
    the delivered budget.ts and store), not from override-exposure, so it does
    not depend on override-exposure despite both touching budget writes.
tasks:
  - id: enforcement-eval
    title: "Budget enforcement evaluation: thresholds, consumption, and enforcement
      state"
    objective: "Create the single evaluation source that the gate, dispatch path,
      and report consume: a pure threshold-evaluation function and a cwd-based
      evaluator that loads config (threshold policy + defaults), roadmap and
      milestone budget state, and usage, then returns the per-scope enforcement
      state (warnings, soft/hard breaches, one-shot availability, actionable
      reasons)."
    implementation_notes:
      - New file packages/core/src/enforcement.ts.
      - "Pure function evaluateThresholds(consumption: ConsumptionResult[],
        policy: BudgetThresholdPolicy) returns the breached level per dimension
        ('none'|'warn'|'soft'|'hard') and an overall level. Apply defaults at
        consumption time when a policy level is undefined: warn=75,
        soft=disabled, hard=100 (per project-init.ts comment). A dimension whose
        ceiling is undefined is never breached (unlimited). percentage from
        ConsumptionResult drives the comparison; over_budget implies hard."
      - "Orchestrator evaluateBudgetEnforcement(cwd): load active state
        (loadState), project config (loadConfig/parseConfig for
        budgets.thresholds), roadmap budget state (loadRoadmapBudgetState),
        active milestone budget state (loadMilestoneBudgetState), and usage
        (loadUsageSummary). For each scope that has ceilings, compute
        consumption via computeConsumption(scopeTotals,
        getElapsedMs(state.time_tracking, now), state.ceilings) and evaluate
        thresholds. Roadmap scope uses summary.total; milestone scope uses
        summary.milestones[milestoneId].total."
      - "Return an EnforcementState: per-scope consumption + breached levels,
        warnings: BudgetWarning[] (scope, dimension, spent, ceiling,
        percentage), softBreached, hardBreached, hasAvailableOneShot per scope,
        and an overall level (most-severe across scopes). With no ceilings in
        either scope, return a no-op state (no warnings, no breaches) — this is
        the backward-compatible path."
      - "Export a formatBudgetBlockReason(level, scope, dimension, spent,
        ceiling, percentage) helper producing the actionable message consumed by
        the gate and dispatch path (which limit, scope, dimension, spent vs
        ceiling, how to override: raise ceiling or grant one-shot continue)."
      - "Must be deterministic: same loaded state produces the same decision. No
        mutation, no I/O writes. Handle missing active state / no active
        milestone gracefully (no-op)."
    done_criteria:
      - evaluateThresholds returns correct breached levels for warn/soft/hard,
        no-ceiling (unlimited), override-applied, and default-policy-fallback
        cases
      - evaluateBudgetEnforcement returns no warnings and no breaches when no
        ceilings are configured (no-op)
      - evaluateBudgetEnforcement reports correct per-scope consumption and the
        most-severe breach across roadmap and milestone scopes
      - Exports evaluateBudgetEnforcement, evaluateThresholds, EnforcementState,
        EnforcementLevel, BudgetWarning, formatBudgetBlockReason for downstream
        tasks
      - bun run check passes (tsc no errors); test/enforcement.test.ts passes
    verification_commands:
      - bun test test/enforcement.test.ts
      - bun run check
    worker: worker-heavy
    depends_on: []
    owned_files:
      - packages/core/src/enforcement.ts
      - test/enforcement.test.ts
    owned_modules: []
    shared_interfaces:
      - "Exports from enforcement.ts: evaluateBudgetEnforcement(cwd) ->
        EnforcementState, evaluateThresholds(consumption, policy),
        EnforcementLevel, EnforcementState, BudgetWarning,
        formatBudgetBlockReason(level, scope, dimension, spent, ceiling,
        percentage) — consumed by gate-eval, dispatch-enforcement,
        override-exposure"
  - id: gate-eval
    title: "Gate integration: block work dispatch on hard budget limit"
    objective: Extend shouldBlockToolCall to block new work dispatch when a hard
      budget limit is breached and no one-shot is available, with an actionable
      reason, while preserving every read-only, recovery, budget-adjustment,
      recording, and review path.
    implementation_notes:
      - "In packages/core/src/gate.ts shouldBlockToolCall, add a budget
        hard-limit check that runs ONLY for work-dispatch tool calls:
        omr_prepare_wave_dispatch, omr_prepare_worker_redispatch, and `task`
        spawns whose agent is a worker (worker-light, worker, worker-heavy).
        Reuse the existing resolveDispatch + agent-detection helpers to identify
        these. Do NOT run evaluateBudgetEnforcement for any other tool (keep the
        common path cheap and backward-compatible)."
      - "For a dispatch tool, call evaluateBudgetEnforcement(cwd). If
        hardBreached and no available one-shot (either scope), return {block:
        true, reason: formatBudgetBlockReason(...)} naming the limit, scope,
        dimension, spent vs ceiling, and how to override. If a one-shot is
        available, allow (the dispatch path consumes it on actual new-wave
        dispatch)."
      - Soft and warn levels never block in the gate — the gate is hard-only.
        The lockout gate and the implementation write-gate remain unchanged and
        continue to run first.
      - "Must NOT block: read-only tools (omr_read_*, omr_list_*,
        omr_search_context, omr_read_context, omr_read_events, omr_validate,
        omr_render_*, omr_next_action, omr_style_guide, omr_prepare_closeout,
        omr_render_dependency_graph), record_* tools, wave review tools
        (omr_prepare_wave_review, omr_record_wave_review), blocker tools
        (omr_open_blocker, omr_resolve_blocker, omr_list_blockers), and any
        budget-adjustment surface. The narrow dispatch-only blocklist guarantees
        this."
      - With no budgets configured, evaluateBudgetEnforcement is a no-op, so
        gate behavior is byte-for-byte unchanged.
    done_criteria:
      - Hard limit blocks omr_prepare_wave_dispatch,
        omr_prepare_worker_redispatch, and worker-agent task spawns with an
        actionable reason
      - Hard limit does NOT block read-only, record_*, review, blocker, or
        budget-adjustment tools; an available one-shot allows the dispatch call
        through
      - With no budgets configured, existing gate behavior is unchanged
        (test/lockout.test.ts and related gate tests stay green)
      - bun run check passes; test/budget-gate.test.ts passes
    verification_commands:
      - bun test test/budget-gate.test.ts
      - bun run check
    worker: worker
    depends_on:
      - enforcement-eval
    owned_files:
      - packages/core/src/gate.ts
      - test/budget-gate.test.ts
    owned_modules: []
    shared_interfaces: []
  - id: dispatch-enforcement
    title: "Wave-boundary enforcement: soft-pause, hard backstop, and time-clock
      wiring"
    objective: "Hook budget enforcement into the dispatch path (prepareWaveDispatch
      and prepareWorkerRedispatch only — NOT prepareWaveReview): soft limit
      pauses at the wave boundary, hard limit throws a backstop, a one-shot is
      consumed on actual new-wave dispatch, and the per-scope time clock is
      started, paused, and resumed across the run lifecycle."
    implementation_notes:
      - In packages/core/src/wave-orchestration/dispatch.ts (prepareWaveDispatch
        and prepareWorkerRedispatch), add a budget dispatch check after
        assertImplementationReady and before/around assertDispatchableWave. Call
        evaluateBudgetEnforcement(cwd).
      - "Soft breach (and not already paused / not resolvable): set
        progress.step to resolving_blockers with blocked_reason =
        formatBudgetBlockReason('soft', ...) via the existing
        setProgress/transition path, pause the roadmap and milestone time clocks
        (pauseTimeClock) and persist via
        writeRoadmapBudgetState/writeMilestoneBudgetState, then throw a clear
        actionable error so the orchestrator surfaces the pause. The existing
        next-action machinery surfaces 'Resolve blocker: budget soft limit…'.
        assertDispatchableWave then refuses further dispatch while paused."
      - "Hard breach with no one-shot: throw an actionable error (backstop to
        the gate)."
      - "One-shot: if hardBreached but a one-shot is available, allow the
        dispatch and consume the one-shot (consumeOneShot + write budget state)
        ONLY when actually dispatching a new wave (the branch that returns
        assignments), not when returning already-running workers."
      - "Resume/clear: on a dispatch attempt where step is resolving_blockers
        with a budget reason but the soft breach is no longer present (ceiling
        raised) or a one-shot is now available, clear the step back to the prior
        dispatching state and resume the time clocks (resumeTimeClock) before
        proceeding."
      - "Time-clock wiring: start the roadmap and milestone clocks
        (startTimeClock) at the first new-wave dispatch in each scope if not
        already running; persist via
        writeRoadmapBudgetState/writeMilestoneBudgetState. Use getElapsedMs
        (read by enforcement-eval) for consumption. Use nowIso() from
        store/shared for timestamps."
      - Do NOT add the budget check to prepareWaveReview — review is not new
        work dispatch and must proceed under a hard limit.
    done_criteria:
      - Soft limit pauses prepareWaveDispatch and prepareWorkerRedispatch at the
        wave boundary (step=resolving_blockers, budget blocked_reason) and
        pauses the time clock; further dispatch is refused while paused; the
        pause clears and clock resumes when the ceiling is raised or a one-shot
        is granted and dispatch is retried
      - Hard limit throws an actionable backstop; an available one-shot allows
        exactly one new-wave dispatch then re-locks (one-shot not consumed when
        returning already-running workers)
      - Time clock starts at first dispatch per scope, pauses on soft-pause,
        resumes on clear, and survives session resume with no double-counting
      - prepareWaveReview is unaffected by budget checks
      - With no budgets configured, dispatch behavior is unchanged
        (test/wave-orchestration.test.ts and related dispatch tests stay green)
      - bun run check passes; test/budget-enforcement.test.ts passes
    verification_commands:
      - bun test test/budget-enforcement.test.ts
      - bun run check
    worker: worker-heavy
    depends_on:
      - enforcement-eval
    owned_files:
      - packages/core/src/wave-orchestration/dispatch.ts
      - packages/core/src/wave-orchestration/context.ts
      - test/budget-enforcement.test.ts
    owned_modules: []
    shared_interfaces:
      - Consumes evaluateBudgetEnforcement, formatBudgetBlockReason,
        EnforcementState from enforcement.ts (task enforcement-eval)
  - id: override-exposure
    title: Override application and warn surfacing
    objective: Provide the core override-application functions (raise-ceiling, grant
      one-shot) that operator-surface commands will call, and surface budget
      WARN notices through the existing renderReport and nextAction paths
      without interrupting the run.
    implementation_notes:
      - "In packages/core/src/enforcement.ts (additive — enforcement-eval is
        complete in wave-1), add applyBudgetRaiseCeiling(cwd, scope, dimension,
        newCeiling, grantedBy, reason) and grantBudgetOneShot(cwd, scope,
        grantedBy, reason). scope is 'roadmap' | 'milestone'. Each loads the
        matching budget state (loadRoadmapBudgetState/writeRoadmapBudgetState or
        loadMilestoneBudgetState/writeMilestoneBudgetState), applies the
        delivered pure function (applyRaiseCeiling / grantOneShotContinue from
        budget.ts) with nowIso(), writes it back, and returns the updated state.
        Re-evaluation is lazy: the next dispatch attempt clears the pause if the
        breach is resolved — do not auto-flip the progress step here."
      - "Warn surfacing: in packages/core/src/report/render.ts renderReport,
        call evaluateBudgetEnforcement(cwd) and append additive warn notice
        lines (one per warning: scope, dimension, spent vs ceiling, percentage)
        when warnings exist. In packages/core/src/report/next-action.ts, augment
        the next-action description with a budget warn notice when warnings are
        present and no higher-priority blocker dominates. Keep both changes
        additive; do not restructure existing report/next-action logic."
      - These are core functions and data hooks only; the CLI commands
        (/omr:budget-*) are ms-operator-surface and are out of scope.
    done_criteria:
      - applyBudgetRaiseCeiling and grantBudgetOneShot load/apply/write the
        scope budget state with full audit fields (granted_by, granted_at,
        reason, old/new ceiling or consumed flag); raise updates the ceiling,
        one-shot grants a single unconsumed continue
      - renderReport includes additive warn lines when a warn threshold is
        crossed; nextAction surfaces a warn notice when warnings are present
      - With no budgets or no warnings, report and next-action output is
        unchanged (test/report-next-action.test.ts, test/report-ui.test.ts stay
        green)
      - bun run check passes; test/budget-override.test.ts passes
    verification_commands:
      - bun test test/budget-override.test.ts
      - bun run check
    worker: worker
    depends_on:
      - enforcement-eval
    owned_files:
      - packages/core/src/enforcement.ts
      - packages/core/src/report/render.ts
      - packages/core/src/report/next-action.ts
      - test/budget-override.test.ts
    owned_modules: []
    shared_interfaces:
      - Consumes evaluateBudgetEnforcement from enforcement.ts (task
        enforcement-eval); exports applyBudgetRaiseCeiling(cwd, scope,
        dimension, newCeiling, grantedBy, reason) and grantBudgetOneShot(cwd,
        scope, grantedBy, reason) for ms-operator-surface commands
waves:
  - id: wave-1
    goal: Deliver the single budget enforcement evaluation source (pure thresholds +
      cwd-based enforcement state) that all enforcement surfaces consume.
    exit_criteria:
      - enforcement.ts exports evaluateThresholds, evaluateBudgetEnforcement,
        EnforcementState, BudgetWarning, formatBudgetBlockReason
      - Threshold evaluation is deterministic and correct for warn/soft/hard,
        no-ceiling, override, and default-policy cases
      - evaluateBudgetEnforcement is a no-op when no ceilings are configured
      - bun run check passes and test/enforcement.test.ts passes
    review_checkpoint: "Run: bun test test/enforcement.test.ts && bun run check"
    tasks:
      - enforcement-eval
  - id: wave-2
    goal: Wire enforcement into the gate (hard block on dispatch), the dispatch path
      (soft-pause, hard backstop, one-shot, time clock), and operator exposure
      (override application + warn surfacing) — all in parallel.
    exit_criteria:
      - Hard limit blocks dispatch tools and worker spawns in the gate;
        read-only/recovery/budget-adjust paths preserved
      - Soft limit pauses at the wave boundary (resolving_blockers + budget
        reason), pauses/resumes the time clock, and clears on raise/one-shot
      - Override application (raise, one-shot) writes audited state; warn
        notices surface in report and next-action
      - With no budgets configured, all existing tests stay green and behavior
        is unchanged
      - bun run check passes and all new + existing tests pass
    review_checkpoint: "Run: bun test && bun run check"
    tasks:
      - gate-eval
      - dispatch-enforcement
      - override-exposure
---

# Enforcement: threshold policy, gate integration, and overrides
## Summary
Milestone: ms-enforcement
Title: Enforcement: threshold policy, gate integration, and overrides
Status: milestone_approved
## User Interview
- Soft-pause state model: user chose to reuse the existing resolving_blockers step with a budget blocked_reason (no new ImplementationProgressStep), so the existing pause/dispatch-refusal/next-action machinery applies. Chosen over adding a dedicated budget_paused step to avoid touching the step enum and ~4 dependent sites.
- Warn surfacing boundary: user chose to hook evaluateBudgetEnforcement warnings into the existing renderReport (status) and nextAction paths as additive notice lines, with no new commands this milestone (command UI/CLI is ms-operator-surface).
- Test coverage: user selected new tests for threshold evaluation, gate enforcement decision (including read-only path preservation), override application, and soft-pause + time-clock. Read-only path preservation is covered within the gate enforcement decision tests.
- Roadmap + milestone scope combination (decided): both scopes are evaluated; the most-severe breach across scopes drives warn/soft/hard; warnings from both are surfaced. A dimension with no ceiling is unlimited.
- Gate block scope (decided): hard limit blocks only omr_prepare_wave_dispatch, omr_prepare_worker_redispatch, and worker-agent task spawns; everything else stays allowed to preserve the read-only/recovery/budget-adjustment path.
- Time clock (decided): enforcement owns start-at-first-dispatch, pause-on-soft-pause, resume-on-continue per scope (roadmap + milestone); time budgets count only from when enforcement is active.
- Override boundary (decided): this milestone provides the core apply functions (raise-ceiling, grant one-shot) that operator-surface commands will call; overrides are applied via these functions, not config file edits.
- One-shot consumption (decided): a one-shot is consumed only when actually dispatching a new wave, not when prepareWaveDispatch returns already-running workers.
## Context
### Relevant Existing Code
- packages/core/src/budget.ts — delivered model: BudgetDimension, BudgetCeiling, BudgetScopeState, ConsumptionResult, computeConsumption(totals, elapsedMs, ceiling), applyRaiseCeiling, grantOneShotContinue, hasAvailableOneShot, consumeOneShot, normalizeBudgetScopeState. Enforcement consumes these; does not duplicate them.
- packages/core/src/elapsed-time.ts — delivered pure clock: TimeTracking, startTimeClock, pauseTimeClock, resumeTimeClock, getElapsedMs, emptyTimeTracking. Enforcement wires start/pause/resume into the dispatch lifecycle.
- packages/core/src/project-init.ts:57-83,283-333 — BudgetThresholdPolicy {warn?,soft?,hard?} (integer 0-100; undefined = disabled), BudgetConfig, RoadmapProjectConfig.budgets. Defaults warn 75 / soft none / hard 100 applied at consumption time when a level is unspecified (not stored in config).
- packages/core/src/usage.ts:7-32,196 — UsageTotals, RoadmapUsageSummary (total: UsageTotals, milestones: Record<string, MilestoneUsageSummary>), loadUsageSummary(cwd, roadmapId). Enforcement reads per-scope totals for consumption.
- packages/core/src/gate.ts:81-111 — shouldBlockToolCall: lockout gate then write-gate. Budget hard-limit check is added here, scoped to dispatch tools only. resolveDispatch (21-56) and isOmrToolCall (58-75) recover omr device names and detect omr-agent task spawns to reuse.
- packages/core/src/wave-orchestration/dispatch.ts:228-285,287-366 — prepareWaveDispatch and prepareWorkerRedispatch both call assertImplementationReady before dispatching. Budget dispatch assertion (soft-pause / hard backstop / one-shot consume / clock) hooks in here, NOT in review.
- packages/core/src/wave-orchestration/context.ts:56-62,118-125 — assertImplementationReady, assertDispatchableWave (throws on resolving_blockers). The soft-pause reuses resolving_blockers so assertDispatchableWave refuses dispatch while paused.
- packages/core/src/validation.ts:405-479 — validateImplementationGate; not modified (budget enforcement is a separate, narrower assertion than the phase/approval/blocker gate).
- packages/core/src/types.ts:206-253 — IMPLEMENTATION_PROGRESS_STEPS (resolving_blockers reused for soft-pause), ImplementationProgress.blocked_reason carries the budget pause reason.
- packages/core/src/store/persistence.ts:151-248,490 — load/writeRoadmapBudgetState, load/writeMilestoneBudgetState (exported via store/index.ts). Enforcement reads/writes per-scope budget state for consumption, overrides, and the time clock.
- packages/core/src/report/render.ts:7-55 — renderReport assembles status (validateImplementationGate, nextAction, usageLines). Warn notice lines hook in here.
- packages/core/src/report/next-action.ts:282-329 — progressNextActionPlan handles resolving_blockers (surfaces the soft-pause). Warn notice augments the description.
- packages/extension/src/extension/tools/register/wave-tools.ts:41-82 — omr_prepare_wave_dispatch, omr_record_worker_dispatch, omr_prepare_worker_redispatch device names (the dispatch tools the gate classifies).
- test/lockout.test.ts — existing shouldBlockToolCall tests (lockout). Budget gate tests go in a dedicated test/budget-gate.test.ts to keep concerns separate.
- test/budget.test.ts:1-48 — test conventions (bun:test, mkdtemp temp dirs, @oh-my-roadmap/core imports). New enforcement tests follow this pattern.
### Relevant Documentation
- (none)
### Decisions
- Soft-pause reuses resolving_blockers + a budget blocked_reason; no new step enum value. Rationale: reuses existing pause, dispatch-refusal (assertDispatchableWave), and next-action surfacing with zero blast radius; the blocked_reason disambiguates budget pauses from task blockers.
- Threshold evaluation lives in a new packages/core/src/enforcement.ts (pure evaluateThresholds + cwd-based evaluateBudgetEnforcement), keeping budget.ts as the pure model. enforcement.ts is the single evaluation source consumed by the gate, dispatch path, and report.
- Gate hard-limit check runs ONLY for dispatch tools (omr_prepare_wave_dispatch, omr_prepare_worker_redispatch, worker-agent task spawns); non-dispatch tools never invoke budget evaluation, preserving the read-only/recovery path and keeping the common path cheap.
- Soft/warn never block in the gate; the gate is hard-only. Soft-pause and warn-surfacing happen in the dispatch path and report/next-action respectively.
- One-shot consumption happens at new-wave dispatch (when prepareWaveDispatch actually dispatches, not when it returns already-running workers), so a one-shot is never wasted.
- Override application is lazy-clear: raising a ceiling or granting a one-shot does not auto-flip the progress step; the next dispatch attempt re-evaluates and clears the pause + resumes the clock if the breach is resolved.
- Roadmap and milestone budgets are both evaluated; the most-severe breach across scopes drives the action. A scope with no ceilings contributes no enforcement (backward-compatible no-op).
## Required Work
### enforcement-eval - Budget enforcement evaluation: thresholds, consumption, and enforcement state

Worker: worker-heavy
Objective: Create the single evaluation source that the gate, dispatch path, and report consume: a pure threshold-evaluation function and a cwd-based evaluator that loads config (threshold policy + defaults), roadmap and milestone budget state, and usage, then returns the per-scope enforcement state (warnings, soft/hard breaches, one-shot availability, actionable reasons).

Implementation Notes:
- New file packages/core/src/enforcement.ts.
- Pure function evaluateThresholds(consumption: ConsumptionResult[], policy: BudgetThresholdPolicy) returns the breached level per dimension ('none'|'warn'|'soft'|'hard') and an overall level. Apply defaults at consumption time when a policy level is undefined: warn=75, soft=disabled, hard=100 (per project-init.ts comment). A dimension whose ceiling is undefined is never breached (unlimited). percentage from ConsumptionResult drives the comparison; over_budget implies hard.
- Orchestrator evaluateBudgetEnforcement(cwd): load active state (loadState), project config (loadConfig/parseConfig for budgets.thresholds), roadmap budget state (loadRoadmapBudgetState), active milestone budget state (loadMilestoneBudgetState), and usage (loadUsageSummary). For each scope that has ceilings, compute consumption via computeConsumption(scopeTotals, getElapsedMs(state.time_tracking, now), state.ceilings) and evaluate thresholds. Roadmap scope uses summary.total; milestone scope uses summary.milestones[milestoneId].total.
- Return an EnforcementState: per-scope consumption + breached levels, warnings: BudgetWarning[] (scope, dimension, spent, ceiling, percentage), softBreached, hardBreached, hasAvailableOneShot per scope, and an overall level (most-severe across scopes). With no ceilings in either scope, return a no-op state (no warnings, no breaches) — this is the backward-compatible path.
- Export a formatBudgetBlockReason(level, scope, dimension, spent, ceiling, percentage) helper producing the actionable message consumed by the gate and dispatch path (which limit, scope, dimension, spent vs ceiling, how to override: raise ceiling or grant one-shot continue).
- Must be deterministic: same loaded state produces the same decision. No mutation, no I/O writes. Handle missing active state / no active milestone gracefully (no-op).

Done Criteria:
- evaluateThresholds returns correct breached levels for warn/soft/hard, no-ceiling (unlimited), override-applied, and default-policy-fallback cases
- evaluateBudgetEnforcement returns no warnings and no breaches when no ceilings are configured (no-op)
- evaluateBudgetEnforcement reports correct per-scope consumption and the most-severe breach across roadmap and milestone scopes
- Exports evaluateBudgetEnforcement, evaluateThresholds, EnforcementState, EnforcementLevel, BudgetWarning, formatBudgetBlockReason for downstream tasks
- bun run check passes (tsc no errors); test/enforcement.test.ts passes

Verification Commands:
- bun test test/enforcement.test.ts
- bun run check

Depends On:
- (none)

Owned Files:
- packages/core/src/enforcement.ts
- test/enforcement.test.ts

Owned Modules:
- (none)

Shared Interfaces:
- Exports from enforcement.ts: evaluateBudgetEnforcement(cwd) -> EnforcementState, evaluateThresholds(consumption, policy), EnforcementLevel, EnforcementState, BudgetWarning, formatBudgetBlockReason(level, scope, dimension, spent, ceiling, percentage) — consumed by gate-eval, dispatch-enforcement, override-exposure

### gate-eval - Gate integration: block work dispatch on hard budget limit

Worker: worker
Objective: Extend shouldBlockToolCall to block new work dispatch when a hard budget limit is breached and no one-shot is available, with an actionable reason, while preserving every read-only, recovery, budget-adjustment, recording, and review path.

Implementation Notes:
- In packages/core/src/gate.ts shouldBlockToolCall, add a budget hard-limit check that runs ONLY for work-dispatch tool calls: omr_prepare_wave_dispatch, omr_prepare_worker_redispatch, and `task` spawns whose agent is a worker (worker-light, worker, worker-heavy). Reuse the existing resolveDispatch + agent-detection helpers to identify these. Do NOT run evaluateBudgetEnforcement for any other tool (keep the common path cheap and backward-compatible).
- For a dispatch tool, call evaluateBudgetEnforcement(cwd). If hardBreached and no available one-shot (either scope), return {block: true, reason: formatBudgetBlockReason(...)} naming the limit, scope, dimension, spent vs ceiling, and how to override. If a one-shot is available, allow (the dispatch path consumes it on actual new-wave dispatch).
- Soft and warn levels never block in the gate — the gate is hard-only. The lockout gate and the implementation write-gate remain unchanged and continue to run first.
- Must NOT block: read-only tools (omr_read_*, omr_list_*, omr_search_context, omr_read_context, omr_read_events, omr_validate, omr_render_*, omr_next_action, omr_style_guide, omr_prepare_closeout, omr_render_dependency_graph), record_* tools, wave review tools (omr_prepare_wave_review, omr_record_wave_review), blocker tools (omr_open_blocker, omr_resolve_blocker, omr_list_blockers), and any budget-adjustment surface. The narrow dispatch-only blocklist guarantees this.
- With no budgets configured, evaluateBudgetEnforcement is a no-op, so gate behavior is byte-for-byte unchanged.

Done Criteria:
- Hard limit blocks omr_prepare_wave_dispatch, omr_prepare_worker_redispatch, and worker-agent task spawns with an actionable reason
- Hard limit does NOT block read-only, record_*, review, blocker, or budget-adjustment tools; an available one-shot allows the dispatch call through
- With no budgets configured, existing gate behavior is unchanged (test/lockout.test.ts and related gate tests stay green)
- bun run check passes; test/budget-gate.test.ts passes

Verification Commands:
- bun test test/budget-gate.test.ts
- bun run check

Depends On:
- enforcement-eval

Owned Files:
- packages/core/src/gate.ts
- test/budget-gate.test.ts

Owned Modules:
- (none)

Shared Interfaces:
- (none)

### dispatch-enforcement - Wave-boundary enforcement: soft-pause, hard backstop, and time-clock wiring

Worker: worker-heavy
Objective: Hook budget enforcement into the dispatch path (prepareWaveDispatch and prepareWorkerRedispatch only — NOT prepareWaveReview): soft limit pauses at the wave boundary, hard limit throws a backstop, a one-shot is consumed on actual new-wave dispatch, and the per-scope time clock is started, paused, and resumed across the run lifecycle.

Implementation Notes:
- In packages/core/src/wave-orchestration/dispatch.ts (prepareWaveDispatch and prepareWorkerRedispatch), add a budget dispatch check after assertImplementationReady and before/around assertDispatchableWave. Call evaluateBudgetEnforcement(cwd).
- Soft breach (and not already paused / not resolvable): set progress.step to resolving_blockers with blocked_reason = formatBudgetBlockReason('soft', ...) via the existing setProgress/transition path, pause the roadmap and milestone time clocks (pauseTimeClock) and persist via writeRoadmapBudgetState/writeMilestoneBudgetState, then throw a clear actionable error so the orchestrator surfaces the pause. The existing next-action machinery surfaces 'Resolve blocker: budget soft limit…'. assertDispatchableWave then refuses further dispatch while paused.
- Hard breach with no one-shot: throw an actionable error (backstop to the gate).
- One-shot: if hardBreached but a one-shot is available, allow the dispatch and consume the one-shot (consumeOneShot + write budget state) ONLY when actually dispatching a new wave (the branch that returns assignments), not when returning already-running workers.
- Resume/clear: on a dispatch attempt where step is resolving_blockers with a budget reason but the soft breach is no longer present (ceiling raised) or a one-shot is now available, clear the step back to the prior dispatching state and resume the time clocks (resumeTimeClock) before proceeding.
- Time-clock wiring: start the roadmap and milestone clocks (startTimeClock) at the first new-wave dispatch in each scope if not already running; persist via writeRoadmapBudgetState/writeMilestoneBudgetState. Use getElapsedMs (read by enforcement-eval) for consumption. Use nowIso() from store/shared for timestamps.
- Do NOT add the budget check to prepareWaveReview — review is not new work dispatch and must proceed under a hard limit.

Done Criteria:
- Soft limit pauses prepareWaveDispatch and prepareWorkerRedispatch at the wave boundary (step=resolving_blockers, budget blocked_reason) and pauses the time clock; further dispatch is refused while paused; the pause clears and clock resumes when the ceiling is raised or a one-shot is granted and dispatch is retried
- Hard limit throws an actionable backstop; an available one-shot allows exactly one new-wave dispatch then re-locks (one-shot not consumed when returning already-running workers)
- Time clock starts at first dispatch per scope, pauses on soft-pause, resumes on clear, and survives session resume with no double-counting
- prepareWaveReview is unaffected by budget checks
- With no budgets configured, dispatch behavior is unchanged (test/wave-orchestration.test.ts and related dispatch tests stay green)
- bun run check passes; test/budget-enforcement.test.ts passes

Verification Commands:
- bun test test/budget-enforcement.test.ts
- bun run check

Depends On:
- enforcement-eval

Owned Files:
- packages/core/src/wave-orchestration/dispatch.ts
- packages/core/src/wave-orchestration/context.ts
- test/budget-enforcement.test.ts

Owned Modules:
- (none)

Shared Interfaces:
- Consumes evaluateBudgetEnforcement, formatBudgetBlockReason, EnforcementState from enforcement.ts (task enforcement-eval)

### override-exposure - Override application and warn surfacing

Worker: worker
Objective: Provide the core override-application functions (raise-ceiling, grant one-shot) that operator-surface commands will call, and surface budget WARN notices through the existing renderReport and nextAction paths without interrupting the run.

Implementation Notes:
- In packages/core/src/enforcement.ts (additive — enforcement-eval is complete in wave-1), add applyBudgetRaiseCeiling(cwd, scope, dimension, newCeiling, grantedBy, reason) and grantBudgetOneShot(cwd, scope, grantedBy, reason). scope is 'roadmap' | 'milestone'. Each loads the matching budget state (loadRoadmapBudgetState/writeRoadmapBudgetState or loadMilestoneBudgetState/writeMilestoneBudgetState), applies the delivered pure function (applyRaiseCeiling / grantOneShotContinue from budget.ts) with nowIso(), writes it back, and returns the updated state. Re-evaluation is lazy: the next dispatch attempt clears the pause if the breach is resolved — do not auto-flip the progress step here.
- Warn surfacing: in packages/core/src/report/render.ts renderReport, call evaluateBudgetEnforcement(cwd) and append additive warn notice lines (one per warning: scope, dimension, spent vs ceiling, percentage) when warnings exist. In packages/core/src/report/next-action.ts, augment the next-action description with a budget warn notice when warnings are present and no higher-priority blocker dominates. Keep both changes additive; do not restructure existing report/next-action logic.
- These are core functions and data hooks only; the CLI commands (/omr:budget-*) are ms-operator-surface and are out of scope.

Done Criteria:
- applyBudgetRaiseCeiling and grantBudgetOneShot load/apply/write the scope budget state with full audit fields (granted_by, granted_at, reason, old/new ceiling or consumed flag); raise updates the ceiling, one-shot grants a single unconsumed continue
- renderReport includes additive warn lines when a warn threshold is crossed; nextAction surfaces a warn notice when warnings are present
- With no budgets or no warnings, report and next-action output is unchanged (test/report-next-action.test.ts, test/report-ui.test.ts stay green)
- bun run check passes; test/budget-override.test.ts passes

Verification Commands:
- bun test test/budget-override.test.ts
- bun run check

Depends On:
- enforcement-eval

Owned Files:
- packages/core/src/enforcement.ts
- packages/core/src/report/render.ts
- packages/core/src/report/next-action.ts
- test/budget-override.test.ts

Owned Modules:
- (none)

Shared Interfaces:
- Consumes evaluateBudgetEnforcement from enforcement.ts (task enforcement-eval); exports applyBudgetRaiseCeiling(cwd, scope, dimension, newCeiling, grantedBy, reason) and grantBudgetOneShot(cwd, scope, grantedBy, reason) for ms-operator-surface commands
## Dependency Analysis
- enforcement-eval is the foundation: it defines the evaluation contract (evaluateBudgetEnforcement, evaluateThresholds, EnforcementState, BudgetWarning, formatBudgetBlockReason) consumed by gate-eval, dispatch-enforcement, and override-exposure. It depends only on the already-delivered budget/usage/config modules, so it has no milestone-internal dependency and runs alone in wave-1.
- gate-eval, dispatch-enforcement, and override-exposure all depend on enforcement-eval (they import from enforcement.ts), so they run in wave-2 after wave-1 completes.
- The three wave-2 tasks are mutually independent: gate-eval owns gate.ts; dispatch-enforcement owns dispatch.ts + context.ts; override-exposure owns enforcement.ts (additive override functions), render.ts, and next-action.ts. No shared files, so they run concurrently with no ownership collision.
- dispatch-enforcement consumes consumeOneShot + store writers directly (from the delivered budget.ts and store), not from override-exposure, so it does not depend on override-exposure despite both touching budget writes.
## Execution Waves
### wave-1

Goal: Deliver the single budget enforcement evaluation source (pure thresholds + cwd-based enforcement state) that all enforcement surfaces consume.
Review Checkpoint: Run: bun test test/enforcement.test.ts && bun run check

Tasks:
- enforcement-eval

Exit Criteria:
- enforcement.ts exports evaluateThresholds, evaluateBudgetEnforcement, EnforcementState, BudgetWarning, formatBudgetBlockReason
- Threshold evaluation is deterministic and correct for warn/soft/hard, no-ceiling, override, and default-policy cases
- evaluateBudgetEnforcement is a no-op when no ceilings are configured
- bun run check passes and test/enforcement.test.ts passes

### wave-2

Goal: Wire enforcement into the gate (hard block on dispatch), the dispatch path (soft-pause, hard backstop, one-shot, time clock), and operator exposure (override application + warn surfacing) — all in parallel.
Review Checkpoint: Run: bun test && bun run check

Tasks:
- gate-eval
- dispatch-enforcement
- override-exposure

Exit Criteria:
- Hard limit blocks dispatch tools and worker spawns in the gate; read-only/recovery/budget-adjust paths preserved
- Soft limit pauses at the wave boundary (resolving_blockers + budget reason), pauses/resumes the time clock, and clears on raise/one-shot
- Override application (raise, one-shot) writes audited state; warn notices surface in report and next-action
- With no budgets configured, all existing tests stay green and behavior is unchanged
- bun run check passes and all new + existing tests pass
## Verification
### Acceptance Criteria
- Threshold evaluation is a deterministic pure function: given consumption vs ceiling per dimension and the threshold policy (defaults warn 75 / soft none / hard 100 when a level is unspecified), it returns the highest breached level per scope; dimensions with no ceiling are never breached (unlimited).
- The pre-tool gate blocks new work dispatch (omr_prepare_wave_dispatch, omr_prepare_worker_redispatch, and worker-agent task spawns) on a hard limit with an actionable reason naming the limit, scope, dimension, spent vs ceiling, and how to override — and does NOT block read-only inspection, blocker resolution, budget adjustment, result recording, or wave review.
- A soft limit pauses the run at the next wave boundary by setting progress to resolving_blockers with a budget blocked_reason and pausing the time clock; the pause clears and the clock resumes when the ceiling is raised or a one-shot is granted and dispatch is retried.
- Override mechanism: raise-ceiling updates the stored ceiling and re-evaluates; one-shot-continue grants exactly one wave dispatch past a hard limit then re-locks; both are recorded in .omr state with full audit fields (who/when/what/why).
- Warn-level notices surface in the existing status report and next-action output without interrupting the run.
- With no budgets configured, behavior is byte-for-byte the current behavior — existing tests stay green and no enforcement evaluation runs for non-dispatch tools.
- Enforcement is deterministic under the roadmap+milestone scope combination: the most-severe breach across scopes drives the action; warnings from both scopes are surfaced.
### Verification Commands
- bun run check
- bun test
