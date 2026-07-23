---
roadmap_id: execution-budgets
milestone_id: ms-budget-model
title: "Budget model: config, validation, and consumption accounting"
status: milestone_approved
approvals:
  - by: user
    at: 2026-07-22T21:07:43.505Z
    summary: "Milestone ms-budget-model plan approved. 3 tasks across 2 waves:
      budget-config (worker-light) + elapsed-time (worker) in wave 1,
      budget-model (worker-heavy) in wave 2. Wave-flow check passed. Key
      decisions: exclude reasoning_tokens, companion budget.yml per scope,
      scope-defined test coverage."
open_questions: []
verification_commands:
  - bun run check
  - bun test
acceptance_criteria:
  - Budget config can be parsed from .omr/config.yml with threshold defaults
    (warn 75%, soft none, hard 100%), validated with clear errors, and merged
    across global/project scopes
  - Per-roadmap and per-milestone budget ceilings can be stored in companion
    budget.yml state files and read back correctly
  - Consumption computation correctly reports spent vs ceiling per dimension per
    scope (tokens, cost, time), using existing usage deltas and excluding
    reasoning_tokens from the token dimension
  - Elapsed-time tracking starts at first dispatch, pauses correctly, resumes
    from prior total, and survives session resume with no double-counting
  - Override state model records raise-ceiling and one-shot-continue with full
    audit fields (who, when, what dimension, old/new ceiling or oneshot grant,
    reason)
  - All budget model unit tests pass and existing config/usage tests remain
    green (backward compatibility)
cleanup_policy: approval-gated
user_interview:
  - "Token dimension: Should budget token accounting include reasoning_tokens?
    Decision: Exclude reasoning_tokens — budget token spent = totalTokens()
    (input + output + cache_read + cache_write), consistent with reporting. No
    changes to report/shared.ts in this milestone."
  - "Budget state storage: Where should budget ceilings, overrides, and time
    tracking be stored? Decision: Companion budget.yml per scope —
    .omr/<id>/budget.yml (roadmap) and .omr/<id>/milestones/<ms-id>/budget.yml
    (milestone). Contains ceilings, overrides, and time-tracking state."
  - "Test coverage: What depth? Decision: Scope-defined + backward compat — unit
    tests for parsing/validation, consumption, time tracking, config
    merge/preservation, and load/save roundtrips. Existing config/usage tests
    stay green."
relevant_existing_code:
  - packages/core/src/project-init.ts:57-66 — RoadmapProjectConfig interface
    (agents, orchestration, disabled, style, moshi). New budgets field would be
    optional.
  - "packages/core/src/project-init.ts:152-264 — parseRoleConfig,
    parseOrchestrationConfig, parseStyle, parseMoshi: the parsing patterns to
    follow (requirePlainObject, rejectUnknownKeys, clear errors)."
  - packages/core/src/project-init.ts:266-287 — parseConfig with
    rejectUnknownKeys allowed list. New 'budgets' key must be added here.
  - packages/core/src/project-init.ts:309-346 — ensureConfig preserves optional
    keys (disabled, style, moshi) on re-init. budgets must follow same pattern.
  - packages/core/src/project-init.ts:365-401 — mergeConfigs shallow-merges
    optional fields (disabled, style, moshi). budgets must merge similarly.
  - packages/core/src/usage.ts:7-32 — UsageTotals (estimated_usd,
    usd_unavailable, requests,
    input/output/cache_read/cache_write/reasoning_tokens), UsageScopeSummary,
    RoadmapUsageSummary.
  - packages/core/src/usage.ts:196-290 — loadUsageSummary, applyDelta (dedup via
    dedupe_keys), totalsFromUsage (reads cost.total).
  - "packages/core/src/report/shared.ts:29-31 — totalTokens: sums input + output
    + cache_read + cache_write, excludes reasoning_tokens. Budget consumption
    uses this."
  - packages/core/src/types.ts:96-120,246-294 — RoadmapState,
    ImplementationProgress, PlanRuntime, MilestonePlan.
  - packages/core/src/paths.ts:59-69,95-105 — roadmapStatePath,
    roadmapUsagePath, milestoneDir, milestoneRuntimePath. Budget paths follow
    these conventions.
  - packages/core/src/store/persistence.ts:138-165,452-476 — load/write state
    patterns (loadRoadmapStateImpl/writeRoadmapStateImpl, public accessors with
    storeTiming wrapping).
  - packages/core/src/store/index.ts — public export surface for store functions
    (re-exports from persistence).
  - test/project-init.test.ts — test patterns for config (bun:test, temp dirs
    via mkdtemp, describe/test/expect).
  - test/usage.test.ts — test patterns for usage (temp dirs, helper functions
    for setup).
relevant_documentation: []
decisions:
  - "Token dimension: Exclude reasoning_tokens — budget token spent =
    totalTokens() (input + output + cache_read + cache_write), consistent with
    reporting. No changes to report/shared.ts in this milestone."
  - "Budget state storage: Companion budget.yml per scope — .omr/<id>/budget.yml
    (roadmap), .omr/<id>/milestones/<ms-id>/budget.yml (milestone). Contains
    ceilings, overrides, and time-tracking state. Follows one-file-per-concern
    pattern (usage.yml, state.yml, blockers.yml)."
  - "Test coverage: Scope-defined + backward compat — unit tests for
    parsing/validation, consumption, time tracking, config merge/preservation,
    and load/save roundtrips. Existing config/usage tests stay green."
  - "Thresholds: Config-only default threshold policy (warn 75%, soft none, hard
    100%) in .omr/config.yml budgets section. No per-budget threshold overrides
    in state for this milestone — threshold evaluation is ms-enforcement."
  - "Time tracking: Pure functions in elapsed-time.ts (no I/O); state stored
    within BudgetScopeState.time_tracking in budget.yml. Functions take/return
    TimeTracking state; storage handled by budget.ts persistence."
  - "Module structure: elapsed-time.ts (pure time tracking) + budget.ts (ceiling
    types, unit parsing, consumption, overrides, storage) + project-init.ts
    extension (config thresholds). Three focused files, no over-fragmentation."
dependency_analysis:
  - Task budget-config is independent — extends project-init.ts only, no imports
    from new modules.
  - Task elapsed-time is independent — pure functions in elapsed-time.ts, no
    I/O, no imports from other new modules.
  - Task budget-model depends on elapsed-time — imports TimeTracking,
    emptyTimeTracking, normalizeTimeTracking from elapsed-time.ts. Must complete
    after elapsed-time.
  - Task budget-model does NOT depend on budget-config — consumption uses
    ceilings (state) + usage (existing), not config thresholds. Threshold
    evaluation is ms-enforcement.
  - Wave 1 (budget-config + elapsed-time) runs in parallel with no
    cross-dependencies. Wave 2 (budget-model) runs after Wave 1 completes.
tasks:
  - id: budget-config
    title: Budget config schema, parsing, and validation
    objective: Add a `budgets` section to .omr/config.yml with default threshold
      policy (warn/soft/hard percentages). Extend RoadmapProjectConfig,
      parseConfig (rejectUnknownKeys), ensureConfig (preserve on re-init), and
      mergeConfigs (global->project merge) following the existing
      parseMoshi/parseStyle pattern.
    implementation_notes:
      - "Add BudgetThresholdPolicy interface: { warn?: number; soft?: number;
        hard?: number } — each is a percentage 0-100 (integer). Undefined means
        that threshold level is disabled."
      - "Add BudgetConfig interface: { thresholds: BudgetThresholdPolicy }."
      - "Add parseBudgetConfig(value: unknown): BudgetConfig | undefined —
        follows parseMoshi pattern (project-init.ts:241-264):
        requirePlainObject, rejectUnknownKeys(['thresholds']), validate each
        percentage is an integer 0-100 or undefined. Clear error messages:
        'budgets.thresholds.warn must be an integer 0-100' etc."
      - "Add 'budgets?: BudgetConfig' to RoadmapProjectConfig interface
        (project-init.ts:57-66)."
      - "In parseConfig (line 266-287): add 'budgets' to the rejectUnknownKeys
        allowed list (line 268 and 319). Parse root.budgets with
        parseBudgetConfig, assign if defined (like moshi at line 284-285)."
      - "In ensureConfig (line 309-346): preserve root.budgets unchanged on
        re-init (like disabled/style/moshi at lines 340-342): if (root.budgets
        !== undefined) expanded.budgets = root.budgets."
      - "In mergeConfigs (line 365-390): shallow-merge budgets — project
        overrides global (like disabled at line 376-377): const budgets =
        override.budgets ?? base.budgets; if (budgets !== undefined)
        merged.budgets = budgets."
      - defaultConfig() (line 302-307) should NOT include budgets — absent means
        enforcement uses hardcoded defaults (warn 75, soft none, hard 100) at
        consumption time.
      - Threshold defaults are NOT stored in config; they are applied at
        enforcement time (ms-enforcement). The config section is optional; when
        absent, enforcement uses the hardcoded defaults.
    done_criteria:
      - budgets section in config.yml parses with threshold policy
        (warn/soft/hard percentages)
      - Invalid percentages (negative, >100, non-integer) produce clear error
        messages
      - Unknown keys in budgets section are rejected by rejectUnknownKeys
      - ensureConfig preserves budgets field on re-init (like
        disabled/style/moshi)
      - mergeConfigs merges global+project budgets (project wins, like disabled)
      - Config without budgets section parses without error (backward compat)
      - Existing project-init tests remain green
    verification_commands:
      - bun test test/project-init.test.ts
    worker: worker-light
    depends_on: []
    owned_files:
      - packages/core/src/project-init.ts
      - test/project-init.test.ts
    owned_modules: []
    shared_interfaces: []
  - id: elapsed-time
    title: "Elapsed-time tracking: pause-aware clock per scope"
    objective: Create a pure elapsed-time tracking module with
      start/pause/resume/getElapsed functions. The clock starts at first wave
      dispatch, pauses on soft-limit or manual-disable (stops the clock), and
      resumes from the prior accumulated total. Must survive session resume
      without losing or double-counting time.
    implementation_notes:
      - Create packages/core/src/elapsed-time.ts.
      - "Define TimeTracking interface: { started_at?: string; paused_at?:
        string; accumulated_ms: number } — started_at is ISO timestamp when
        clock is running; paused_at is ISO timestamp when paused; accumulated_ms
        is total elapsed ms from prior intervals."
      - "emptyTimeTracking(): TimeTracking — returns { accumulated_ms: 0 }."
      - "startTimeClock(state: TimeTracking | undefined, now: string):
        TimeTracking — if state is undefined or started_at is undefined, set
        started_at = now. Idempotent: if already running (started_at set, no
        paused_at), return state unchanged. Does NOT reset accumulated_ms."
      - "pauseTimeClock(state: TimeTracking, now: string): TimeTracking — if
        running (started_at set, paused_at undefined): add (Date.parse(now) -
        Date.parse(started_at)) to accumulated_ms, set paused_at = now, delete
        started_at. If already paused, return state unchanged (no-op)."
      - "resumeTimeClock(state: TimeTracking, now: string): TimeTracking — if
        paused (paused_at set): set started_at = now, delete paused_at. If
        already running, return state unchanged."
      - "getElapsedMs(state: TimeTracking | undefined, now: string): number — if
        undefined: 0. If running (started_at set, paused_at undefined):
        accumulated_ms + (Date.parse(now) - Date.parse(started_at)). If paused:
        accumulated_ms."
      - "normalizeTimeTracking(value: unknown): TimeTracking — for loading from
        YAML. Validate accumulated_ms is a non-negative finite number (default
        0). Validate started_at/paused_at are strings if present. Return
        emptyTimeTracking() for undefined/null input."
      - "ALL functions must be PURE: take state as input, return a new state
        object, no I/O, no side effects, no mutation of the input argument."
      - Timestamps are ISO 8601 strings (consistent with the codebase which uses
        nowIso() from store/shared.ts). Elapsed computation uses Date.parse()
        for the difference.
      - Export TimeTracking interface and all functions from elapsed-time.ts.
    done_criteria:
      - startTimeClock is idempotent (first call starts clock, subsequent calls
        while running are no-ops)
      - pauseTimeClock stops the clock and accumulates elapsed time correctly
        (adds running interval to accumulated_ms)
      - resumeTimeClock continues from the prior accumulated total (sets new
        started_at without resetting accumulated_ms)
      - getElapsedMs returns correct elapsed time when running, paused, or
        undefined
      - "Session resume: serialize TimeTracking to plain object, deserialize via
        normalizeTimeTracking, getElapsedMs returns correct value"
      - "No double-counting: pause -> resume -> pause does not add phantom time
        between pause and resume"
      - All functions are pure (no I/O, no side effects, no input mutation)
    verification_commands:
      - bun test test/elapsed-time.test.ts
    worker: worker
    depends_on: []
    owned_files:
      - packages/core/src/elapsed-time.ts
      - test/elapsed-time.test.ts
    owned_modules: []
    shared_interfaces:
      - TimeTracking interface and pure functions (startTimeClock,
        pauseTimeClock, resumeTimeClock, getElapsedMs, emptyTimeTracking,
        normalizeTimeTracking) exported from elapsed-time.ts — consumed by Task
        budget-model
  - id: budget-model
    title: "Budget state model: ceilings, overrides, consumption, and storage"
    objective: Create the budget state model module with ceiling types,
      human-friendly unit parsing, consumption computation (spent vs ceiling per
      dimension per scope), override state model (raise-ceiling +
      one-shot-continue with audit fields), and load/save to companion
      budget.yml files. Builds on existing usage.ts and elapsed-time.ts.
    implementation_notes:
      - Create packages/core/src/budget.ts.
      - Import TimeTracking, emptyTimeTracking, normalizeTimeTracking from
        ./elapsed-time.
      - Import UsageTotals from ./usage. Import totalTokens from ./report/shared.
      - Define BudgetDimension type = 'tokens' | 'cost' | 'time'.
      - "Define BudgetCeiling interface: { tokens?: number; cost?: number;
        time?: number } — any subset of dimensions; unset = unlimited. Time in
        milliseconds, cost in USD, tokens as integer count."
      - Define BudgetOverrideType = 'raise_ceiling' | 'one_shot_continue'.
      - "Define BudgetOverride interface: { id: string; type:
        BudgetOverrideType; dimension?: BudgetDimension; old_ceiling?: number;
        new_ceiling?: number; reason: string; granted_by: string; granted_at:
        string; consumed?: boolean } — consumed tracks one-shot-continue
        (false/undefined = available, true = used)."
      - "Define BudgetScopeState interface: { ceilings: BudgetCeiling;
        overrides: BudgetOverride[]; time_tracking: TimeTracking }."
      - "Define ConsumptionResult interface: { dimension: BudgetDimension;
        spent: number; ceiling: number | undefined; remaining: number |
        undefined; percentage: number | undefined; over_budget: boolean } —
        ceiling undefined = unlimited; percentage undefined when ceiling
        undefined; over_budget false when ceiling undefined."
      - "Human-friendly unit parsing: parseTimeDuration(value: string): number —
        '30m'->1800000, '1h'->3600000, '2h30m'->9000000, '90s'->90000. Support
        h/m/s. Return ms. Throw clear error on invalid."
      - "parseCost(value: string): number — '5.00'->5.0, '5'->5.0, '0.50'->0.5.
        Return USD number. Throw on non-numeric."
      - "parseTokenCount(value: string): number — '1000000'->1000000.
        Non-negative integer. Throw on non-integer or negative."
      - "parseBudgetCeiling(value: unknown): BudgetCeiling — parse from raw
        object { tokens?, cost?, time? }. Use
        parseTokenCount/parseCost/parseTimeDuration for each field.
        rejectUnknownKeys for unknown fields."
      - "Consumption: computeConsumption(totals: UsageTotals, elapsedMs: number,
        ceiling: BudgetCeiling): ConsumptionResult[] — pure function returning
        one result per dimension."
      - Token spent = totalTokens(totals) = input + output + cache_read +
        cache_write (EXCLUDES reasoning_tokens per user decision).
      - Cost spent = totals.estimated_usd. When totals.usd_unavailable is true,
        spent is 0 and unreliable — the ConsumptionResult for cost should still
        report it (enforcement handles the unavailable case).
      - Time spent = elapsedMs (from elapsed-time.ts getElapsedMs, passed in by
        the caller).
      - "For each dimension: spent, ceiling (undefined = unlimited), remaining
        (ceiling - spent, undefined if unlimited), percentage
        (spent/ceiling*100, undefined if unlimited), over_budget (spent >
        ceiling, false if unlimited)."
      - "Override model: applyRaiseCeiling(state: BudgetScopeState, dimension:
        BudgetDimension, newCeiling: number, grantedBy: string, reason: string,
        now: string): BudgetScopeState — update state.ceilings[dimension],
        record BudgetOverride with type='raise_ceiling', old_ceiling,
        new_ceiling, audit fields. Return new state."
      - "grantOneShotContinue(state: BudgetScopeState, grantedBy: string,
        reason: string, now: string): BudgetScopeState — add BudgetOverride with
        type='one_shot_continue', consumed=false. Return new state."
      - "hasAvailableOneShot(state: BudgetScopeState): boolean — true if any
        override has type='one_shot_continue' and consumed !== true."
      - "consumeOneShot(state: BudgetScopeState): BudgetScopeState — mark the
        most recent unconsumed one-shot as consumed=true. Return new state."
      - "Storage: emptyBudgetScopeState(): BudgetScopeState — returns {
        ceilings: {}, overrides: [], time_tracking: emptyTimeTracking() }."
      - "normalizeBudgetScopeState(value: unknown): BudgetScopeState —
        validate/normalize from YAML. Missing/undefined ->
        emptyBudgetScopeState(). Normalize ceilings (validate numeric),
        overrides (validate fields, generate id if missing), time_tracking (via
        normalizeTimeTracking)."
      - "Paths (add to packages/core/src/paths.ts): roadmapBudgetPath(cwd,
        roadmapId) = path.join(roadmapDir(cwd, roadmapId), 'budget.yml').
        milestoneBudgetPath(cwd, roadmapId, milestoneId) =
        path.join(milestoneDir(cwd, roadmapId, milestoneId), 'budget.yml')."
      - "Persistence (add to packages/core/src/store/persistence.ts): follow
        loadRoadmapBlockersImpl/writeRoadmapBlockersImpl pattern
        (persistence.ts:146-154). Add loadRoadmapBudgetStateImpl,
        loadMilestoneBudgetStateImpl (return undefined if file missing),
        writeRoadmapBudgetStateImpl, writeMilestoneBudgetStateImpl. Add public
        accessors with storeTiming wrapping (like persistence.ts:452-476)."
      - "Store exports (add to packages/core/src/store/index.ts): export
        loadRoadmapBudgetState, writeRoadmapBudgetState,
        loadMilestoneBudgetState, writeMilestoneBudgetState from
        './persistence'."
      - Budget types and functions in budget.ts are accessible via
        @oh-my-roadmap/core/budget (package.json ./* export pattern). No main
        index.ts change needed.
    done_criteria:
      - "Human-friendly units parse correctly: '30m'->1800000ms,
        '1h'->3600000ms, '2h30m'->9000000ms, '5.00'->5.0, '5'->5.0,
        '1000000'->1000000"
      - Invalid unit formats produce clear error messages (typos, negative,
        non-numeric)
      - "Partial ceilings work: any subset of {tokens, cost, time} can be set;
        unset = unlimited"
      - Consumption correctly computes spent vs ceiling per dimension per scope
      - Token spent excludes reasoning_tokens (uses totalTokens() from
        report/shared.ts)
      - Cost spent handles usd_unavailable (reports spent=0 when unavailable)
      - Unlimited dimensions (unset ceiling) return ceiling=undefined,
        percentage=undefined, over_budget=false
      - Override model records raise-ceiling with old/new ceiling and full audit
        fields (id, type, dimension, old_ceiling, new_ceiling, reason,
        granted_by, granted_at)
      - Override model records one-shot-continue with consumed tracking
        (hasAvailableOneShot, consumeOneShot)
      - Budget state loads/saves correctly (write -> read roundtrip preserves
        ceilings, overrides, and time_tracking)
      - Empty/missing budget file returns undefined (no budgets = unlimited,
        backward compat)
      - New store exports (loadRoadmapBudgetState, writeRoadmapBudgetState,
        loadMilestoneBudgetState, writeMilestoneBudgetState) accessible via
        @oh-my-roadmap/core/store/index
    verification_commands:
      - bun test test/budget.test.ts
    worker: worker-heavy
    depends_on:
      - elapsed-time
    owned_files:
      - packages/core/src/budget.ts
      - packages/core/src/paths.ts
      - packages/core/src/store/persistence.ts
      - packages/core/src/store/index.ts
      - test/budget.test.ts
    owned_modules: []
    shared_interfaces:
      - Imports TimeTracking, emptyTimeTracking, normalizeTimeTracking from
        elapsed-time.ts (Task elapsed-time)
waves:
  - id: wave-1
    goal: Deliver budget config schema/parsing and elapsed-time tracking — the two
      independent foundation pieces with no cross-dependencies
    exit_criteria:
      - Budget config parses from .omr/config.yml with threshold defaults,
        validates with clear errors, merges across global/project scopes
      - Elapsed-time tracking functions are pure, start at first dispatch,
        pause/resume correctly, survive session resume with no double-counting
      - bun run check passes (tsc no errors)
      - Existing project-init tests remain green
    review_checkpoint: "Run: bun test test/project-init.test.ts
      test/elapsed-time.test.ts && bun run check"
    tasks:
      - budget-config
      - elapsed-time
  - id: wave-2
    goal: "Deliver budget state model: ceilings, overrides, consumption computation,
      and storage — building on elapsed-time tracking"
    exit_criteria:
      - Budget ceilings parse from human-friendly units and store/load correctly
        in budget.yml per scope
      - Consumption computation reports spent vs ceiling per dimension per scope
        using existing usage deltas (excluding reasoning_tokens)
      - Override state model records raise-ceiling and one-shot-continue with
        full audit fields
      - All budget model unit tests pass
      - Existing config/usage tests remain green (backward compat)
      - bun run check passes
    review_checkpoint: "Run: bun test && bun run check"
    tasks:
      - budget-model
---

# Budget model: config, validation, and consumption accounting
## Summary
Milestone: ms-budget-model
Title: Budget model: config, validation, and consumption accounting
Status: milestone_approved
## User Interview
- Token dimension: Should budget token accounting include reasoning_tokens? Decision: Exclude reasoning_tokens — budget token spent = totalTokens() (input + output + cache_read + cache_write), consistent with reporting. No changes to report/shared.ts in this milestone.
- Budget state storage: Where should budget ceilings, overrides, and time tracking be stored? Decision: Companion budget.yml per scope — .omr/<id>/budget.yml (roadmap) and .omr/<id>/milestones/<ms-id>/budget.yml (milestone). Contains ceilings, overrides, and time-tracking state.
- Test coverage: What depth? Decision: Scope-defined + backward compat — unit tests for parsing/validation, consumption, time tracking, config merge/preservation, and load/save roundtrips. Existing config/usage tests stay green.
## Context
### Relevant Existing Code
- packages/core/src/project-init.ts:57-66 — RoadmapProjectConfig interface (agents, orchestration, disabled, style, moshi). New budgets field would be optional.
- packages/core/src/project-init.ts:152-264 — parseRoleConfig, parseOrchestrationConfig, parseStyle, parseMoshi: the parsing patterns to follow (requirePlainObject, rejectUnknownKeys, clear errors).
- packages/core/src/project-init.ts:266-287 — parseConfig with rejectUnknownKeys allowed list. New 'budgets' key must be added here.
- packages/core/src/project-init.ts:309-346 — ensureConfig preserves optional keys (disabled, style, moshi) on re-init. budgets must follow same pattern.
- packages/core/src/project-init.ts:365-401 — mergeConfigs shallow-merges optional fields (disabled, style, moshi). budgets must merge similarly.
- packages/core/src/usage.ts:7-32 — UsageTotals (estimated_usd, usd_unavailable, requests, input/output/cache_read/cache_write/reasoning_tokens), UsageScopeSummary, RoadmapUsageSummary.
- packages/core/src/usage.ts:196-290 — loadUsageSummary, applyDelta (dedup via dedupe_keys), totalsFromUsage (reads cost.total).
- packages/core/src/report/shared.ts:29-31 — totalTokens: sums input + output + cache_read + cache_write, excludes reasoning_tokens. Budget consumption uses this.
- packages/core/src/types.ts:96-120,246-294 — RoadmapState, ImplementationProgress, PlanRuntime, MilestonePlan.
- packages/core/src/paths.ts:59-69,95-105 — roadmapStatePath, roadmapUsagePath, milestoneDir, milestoneRuntimePath. Budget paths follow these conventions.
- packages/core/src/store/persistence.ts:138-165,452-476 — load/write state patterns (loadRoadmapStateImpl/writeRoadmapStateImpl, public accessors with storeTiming wrapping).
- packages/core/src/store/index.ts — public export surface for store functions (re-exports from persistence).
- test/project-init.test.ts — test patterns for config (bun:test, temp dirs via mkdtemp, describe/test/expect).
- test/usage.test.ts — test patterns for usage (temp dirs, helper functions for setup).
### Relevant Documentation
- (none)
### Decisions
- Token dimension: Exclude reasoning_tokens — budget token spent = totalTokens() (input + output + cache_read + cache_write), consistent with reporting. No changes to report/shared.ts in this milestone.
- Budget state storage: Companion budget.yml per scope — .omr/<id>/budget.yml (roadmap), .omr/<id>/milestones/<ms-id>/budget.yml (milestone). Contains ceilings, overrides, and time-tracking state. Follows one-file-per-concern pattern (usage.yml, state.yml, blockers.yml).
- Test coverage: Scope-defined + backward compat — unit tests for parsing/validation, consumption, time tracking, config merge/preservation, and load/save roundtrips. Existing config/usage tests stay green.
- Thresholds: Config-only default threshold policy (warn 75%, soft none, hard 100%) in .omr/config.yml budgets section. No per-budget threshold overrides in state for this milestone — threshold evaluation is ms-enforcement.
- Time tracking: Pure functions in elapsed-time.ts (no I/O); state stored within BudgetScopeState.time_tracking in budget.yml. Functions take/return TimeTracking state; storage handled by budget.ts persistence.
- Module structure: elapsed-time.ts (pure time tracking) + budget.ts (ceiling types, unit parsing, consumption, overrides, storage) + project-init.ts extension (config thresholds). Three focused files, no over-fragmentation.
## Required Work
### budget-config - Budget config schema, parsing, and validation

Worker: worker-light
Objective: Add a `budgets` section to .omr/config.yml with default threshold policy (warn/soft/hard percentages). Extend RoadmapProjectConfig, parseConfig (rejectUnknownKeys), ensureConfig (preserve on re-init), and mergeConfigs (global->project merge) following the existing parseMoshi/parseStyle pattern.

Implementation Notes:
- Add BudgetThresholdPolicy interface: { warn?: number; soft?: number; hard?: number } — each is a percentage 0-100 (integer). Undefined means that threshold level is disabled.
- Add BudgetConfig interface: { thresholds: BudgetThresholdPolicy }.
- Add parseBudgetConfig(value: unknown): BudgetConfig | undefined — follows parseMoshi pattern (project-init.ts:241-264): requirePlainObject, rejectUnknownKeys(['thresholds']), validate each percentage is an integer 0-100 or undefined. Clear error messages: 'budgets.thresholds.warn must be an integer 0-100' etc.
- Add 'budgets?: BudgetConfig' to RoadmapProjectConfig interface (project-init.ts:57-66).
- In parseConfig (line 266-287): add 'budgets' to the rejectUnknownKeys allowed list (line 268 and 319). Parse root.budgets with parseBudgetConfig, assign if defined (like moshi at line 284-285).
- In ensureConfig (line 309-346): preserve root.budgets unchanged on re-init (like disabled/style/moshi at lines 340-342): if (root.budgets !== undefined) expanded.budgets = root.budgets.
- In mergeConfigs (line 365-390): shallow-merge budgets — project overrides global (like disabled at line 376-377): const budgets = override.budgets ?? base.budgets; if (budgets !== undefined) merged.budgets = budgets.
- defaultConfig() (line 302-307) should NOT include budgets — absent means enforcement uses hardcoded defaults (warn 75, soft none, hard 100) at consumption time.
- Threshold defaults are NOT stored in config; they are applied at enforcement time (ms-enforcement). The config section is optional; when absent, enforcement uses the hardcoded defaults.

Done Criteria:
- budgets section in config.yml parses with threshold policy (warn/soft/hard percentages)
- Invalid percentages (negative, >100, non-integer) produce clear error messages
- Unknown keys in budgets section are rejected by rejectUnknownKeys
- ensureConfig preserves budgets field on re-init (like disabled/style/moshi)
- mergeConfigs merges global+project budgets (project wins, like disabled)
- Config without budgets section parses without error (backward compat)
- Existing project-init tests remain green

Verification Commands:
- bun test test/project-init.test.ts

Depends On:
- (none)

Owned Files:
- packages/core/src/project-init.ts
- test/project-init.test.ts

Owned Modules:
- (none)

Shared Interfaces:
- (none)

### elapsed-time - Elapsed-time tracking: pause-aware clock per scope

Worker: worker
Objective: Create a pure elapsed-time tracking module with start/pause/resume/getElapsed functions. The clock starts at first wave dispatch, pauses on soft-limit or manual-disable (stops the clock), and resumes from the prior accumulated total. Must survive session resume without losing or double-counting time.

Implementation Notes:
- Create packages/core/src/elapsed-time.ts.
- Define TimeTracking interface: { started_at?: string; paused_at?: string; accumulated_ms: number } — started_at is ISO timestamp when clock is running; paused_at is ISO timestamp when paused; accumulated_ms is total elapsed ms from prior intervals.
- emptyTimeTracking(): TimeTracking — returns { accumulated_ms: 0 }.
- startTimeClock(state: TimeTracking | undefined, now: string): TimeTracking — if state is undefined or started_at is undefined, set started_at = now. Idempotent: if already running (started_at set, no paused_at), return state unchanged. Does NOT reset accumulated_ms.
- pauseTimeClock(state: TimeTracking, now: string): TimeTracking — if running (started_at set, paused_at undefined): add (Date.parse(now) - Date.parse(started_at)) to accumulated_ms, set paused_at = now, delete started_at. If already paused, return state unchanged (no-op).
- resumeTimeClock(state: TimeTracking, now: string): TimeTracking — if paused (paused_at set): set started_at = now, delete paused_at. If already running, return state unchanged.
- getElapsedMs(state: TimeTracking | undefined, now: string): number — if undefined: 0. If running (started_at set, paused_at undefined): accumulated_ms + (Date.parse(now) - Date.parse(started_at)). If paused: accumulated_ms.
- normalizeTimeTracking(value: unknown): TimeTracking — for loading from YAML. Validate accumulated_ms is a non-negative finite number (default 0). Validate started_at/paused_at are strings if present. Return emptyTimeTracking() for undefined/null input.
- ALL functions must be PURE: take state as input, return a new state object, no I/O, no side effects, no mutation of the input argument.
- Timestamps are ISO 8601 strings (consistent with the codebase which uses nowIso() from store/shared.ts). Elapsed computation uses Date.parse() for the difference.
- Export TimeTracking interface and all functions from elapsed-time.ts.

Done Criteria:
- startTimeClock is idempotent (first call starts clock, subsequent calls while running are no-ops)
- pauseTimeClock stops the clock and accumulates elapsed time correctly (adds running interval to accumulated_ms)
- resumeTimeClock continues from the prior accumulated total (sets new started_at without resetting accumulated_ms)
- getElapsedMs returns correct elapsed time when running, paused, or undefined
- Session resume: serialize TimeTracking to plain object, deserialize via normalizeTimeTracking, getElapsedMs returns correct value
- No double-counting: pause -> resume -> pause does not add phantom time between pause and resume
- All functions are pure (no I/O, no side effects, no input mutation)

Verification Commands:
- bun test test/elapsed-time.test.ts

Depends On:
- (none)

Owned Files:
- packages/core/src/elapsed-time.ts
- test/elapsed-time.test.ts

Owned Modules:
- (none)

Shared Interfaces:
- TimeTracking interface and pure functions (startTimeClock, pauseTimeClock, resumeTimeClock, getElapsedMs, emptyTimeTracking, normalizeTimeTracking) exported from elapsed-time.ts — consumed by Task budget-model

### budget-model - Budget state model: ceilings, overrides, consumption, and storage

Worker: worker-heavy
Objective: Create the budget state model module with ceiling types, human-friendly unit parsing, consumption computation (spent vs ceiling per dimension per scope), override state model (raise-ceiling + one-shot-continue with audit fields), and load/save to companion budget.yml files. Builds on existing usage.ts and elapsed-time.ts.

Implementation Notes:
- Create packages/core/src/budget.ts.
- Import TimeTracking, emptyTimeTracking, normalizeTimeTracking from ./elapsed-time.
- Import UsageTotals from ./usage. Import totalTokens from ./report/shared.
- Define BudgetDimension type = 'tokens' | 'cost' | 'time'.
- Define BudgetCeiling interface: { tokens?: number; cost?: number; time?: number } — any subset of dimensions; unset = unlimited. Time in milliseconds, cost in USD, tokens as integer count.
- Define BudgetOverrideType = 'raise_ceiling' | 'one_shot_continue'.
- Define BudgetOverride interface: { id: string; type: BudgetOverrideType; dimension?: BudgetDimension; old_ceiling?: number; new_ceiling?: number; reason: string; granted_by: string; granted_at: string; consumed?: boolean } — consumed tracks one-shot-continue (false/undefined = available, true = used).
- Define BudgetScopeState interface: { ceilings: BudgetCeiling; overrides: BudgetOverride[]; time_tracking: TimeTracking }.
- Define ConsumptionResult interface: { dimension: BudgetDimension; spent: number; ceiling: number | undefined; remaining: number | undefined; percentage: number | undefined; over_budget: boolean } — ceiling undefined = unlimited; percentage undefined when ceiling undefined; over_budget false when ceiling undefined.
- Human-friendly unit parsing: parseTimeDuration(value: string): number — '30m'->1800000, '1h'->3600000, '2h30m'->9000000, '90s'->90000. Support h/m/s. Return ms. Throw clear error on invalid.
- parseCost(value: string): number — '5.00'->5.0, '5'->5.0, '0.50'->0.5. Return USD number. Throw on non-numeric.
- parseTokenCount(value: string): number — '1000000'->1000000. Non-negative integer. Throw on non-integer or negative.
- parseBudgetCeiling(value: unknown): BudgetCeiling — parse from raw object { tokens?, cost?, time? }. Use parseTokenCount/parseCost/parseTimeDuration for each field. rejectUnknownKeys for unknown fields.
- Consumption: computeConsumption(totals: UsageTotals, elapsedMs: number, ceiling: BudgetCeiling): ConsumptionResult[] — pure function returning one result per dimension.
- Token spent = totalTokens(totals) = input + output + cache_read + cache_write (EXCLUDES reasoning_tokens per user decision).
- Cost spent = totals.estimated_usd. When totals.usd_unavailable is true, spent is 0 and unreliable — the ConsumptionResult for cost should still report it (enforcement handles the unavailable case).
- Time spent = elapsedMs (from elapsed-time.ts getElapsedMs, passed in by the caller).
- For each dimension: spent, ceiling (undefined = unlimited), remaining (ceiling - spent, undefined if unlimited), percentage (spent/ceiling*100, undefined if unlimited), over_budget (spent > ceiling, false if unlimited).
- Override model: applyRaiseCeiling(state: BudgetScopeState, dimension: BudgetDimension, newCeiling: number, grantedBy: string, reason: string, now: string): BudgetScopeState — update state.ceilings[dimension], record BudgetOverride with type='raise_ceiling', old_ceiling, new_ceiling, audit fields. Return new state.
- grantOneShotContinue(state: BudgetScopeState, grantedBy: string, reason: string, now: string): BudgetScopeState — add BudgetOverride with type='one_shot_continue', consumed=false. Return new state.
- hasAvailableOneShot(state: BudgetScopeState): boolean — true if any override has type='one_shot_continue' and consumed !== true.
- consumeOneShot(state: BudgetScopeState): BudgetScopeState — mark the most recent unconsumed one-shot as consumed=true. Return new state.
- Storage: emptyBudgetScopeState(): BudgetScopeState — returns { ceilings: {}, overrides: [], time_tracking: emptyTimeTracking() }.
- normalizeBudgetScopeState(value: unknown): BudgetScopeState — validate/normalize from YAML. Missing/undefined -> emptyBudgetScopeState(). Normalize ceilings (validate numeric), overrides (validate fields, generate id if missing), time_tracking (via normalizeTimeTracking).
- Paths (add to packages/core/src/paths.ts): roadmapBudgetPath(cwd, roadmapId) = path.join(roadmapDir(cwd, roadmapId), 'budget.yml'). milestoneBudgetPath(cwd, roadmapId, milestoneId) = path.join(milestoneDir(cwd, roadmapId, milestoneId), 'budget.yml').
- Persistence (add to packages/core/src/store/persistence.ts): follow loadRoadmapBlockersImpl/writeRoadmapBlockersImpl pattern (persistence.ts:146-154). Add loadRoadmapBudgetStateImpl, loadMilestoneBudgetStateImpl (return undefined if file missing), writeRoadmapBudgetStateImpl, writeMilestoneBudgetStateImpl. Add public accessors with storeTiming wrapping (like persistence.ts:452-476).
- Store exports (add to packages/core/src/store/index.ts): export loadRoadmapBudgetState, writeRoadmapBudgetState, loadMilestoneBudgetState, writeMilestoneBudgetState from './persistence'.
- Budget types and functions in budget.ts are accessible via @oh-my-roadmap/core/budget (package.json ./* export pattern). No main index.ts change needed.

Done Criteria:
- Human-friendly units parse correctly: '30m'->1800000ms, '1h'->3600000ms, '2h30m'->9000000ms, '5.00'->5.0, '5'->5.0, '1000000'->1000000
- Invalid unit formats produce clear error messages (typos, negative, non-numeric)
- Partial ceilings work: any subset of {tokens, cost, time} can be set; unset = unlimited
- Consumption correctly computes spent vs ceiling per dimension per scope
- Token spent excludes reasoning_tokens (uses totalTokens() from report/shared.ts)
- Cost spent handles usd_unavailable (reports spent=0 when unavailable)
- Unlimited dimensions (unset ceiling) return ceiling=undefined, percentage=undefined, over_budget=false
- Override model records raise-ceiling with old/new ceiling and full audit fields (id, type, dimension, old_ceiling, new_ceiling, reason, granted_by, granted_at)
- Override model records one-shot-continue with consumed tracking (hasAvailableOneShot, consumeOneShot)
- Budget state loads/saves correctly (write -> read roundtrip preserves ceilings, overrides, and time_tracking)
- Empty/missing budget file returns undefined (no budgets = unlimited, backward compat)
- New store exports (loadRoadmapBudgetState, writeRoadmapBudgetState, loadMilestoneBudgetState, writeMilestoneBudgetState) accessible via @oh-my-roadmap/core/store/index

Verification Commands:
- bun test test/budget.test.ts

Depends On:
- elapsed-time

Owned Files:
- packages/core/src/budget.ts
- packages/core/src/paths.ts
- packages/core/src/store/persistence.ts
- packages/core/src/store/index.ts
- test/budget.test.ts

Owned Modules:
- (none)

Shared Interfaces:
- Imports TimeTracking, emptyTimeTracking, normalizeTimeTracking from elapsed-time.ts (Task elapsed-time)
## Dependency Analysis
- Task budget-config is independent — extends project-init.ts only, no imports from new modules.
- Task elapsed-time is independent — pure functions in elapsed-time.ts, no I/O, no imports from other new modules.
- Task budget-model depends on elapsed-time — imports TimeTracking, emptyTimeTracking, normalizeTimeTracking from elapsed-time.ts. Must complete after elapsed-time.
- Task budget-model does NOT depend on budget-config — consumption uses ceilings (state) + usage (existing), not config thresholds. Threshold evaluation is ms-enforcement.
- Wave 1 (budget-config + elapsed-time) runs in parallel with no cross-dependencies. Wave 2 (budget-model) runs after Wave 1 completes.
## Execution Waves
### wave-1

Goal: Deliver budget config schema/parsing and elapsed-time tracking — the two independent foundation pieces with no cross-dependencies
Review Checkpoint: Run: bun test test/project-init.test.ts test/elapsed-time.test.ts && bun run check

Tasks:
- budget-config
- elapsed-time

Exit Criteria:
- Budget config parses from .omr/config.yml with threshold defaults, validates with clear errors, merges across global/project scopes
- Elapsed-time tracking functions are pure, start at first dispatch, pause/resume correctly, survive session resume with no double-counting
- bun run check passes (tsc no errors)
- Existing project-init tests remain green

### wave-2

Goal: Deliver budget state model: ceilings, overrides, consumption computation, and storage — building on elapsed-time tracking
Review Checkpoint: Run: bun test && bun run check

Tasks:
- budget-model

Exit Criteria:
- Budget ceilings parse from human-friendly units and store/load correctly in budget.yml per scope
- Consumption computation reports spent vs ceiling per dimension per scope using existing usage deltas (excluding reasoning_tokens)
- Override state model records raise-ceiling and one-shot-continue with full audit fields
- All budget model unit tests pass
- Existing config/usage tests remain green (backward compat)
- bun run check passes
## Verification
### Acceptance Criteria
- Budget config can be parsed from .omr/config.yml with threshold defaults (warn 75%, soft none, hard 100%), validated with clear errors, and merged across global/project scopes
- Per-roadmap and per-milestone budget ceilings can be stored in companion budget.yml state files and read back correctly
- Consumption computation correctly reports spent vs ceiling per dimension per scope (tokens, cost, time), using existing usage deltas and excluding reasoning_tokens from the token dimension
- Elapsed-time tracking starts at first dispatch, pauses correctly, resumes from prior total, and survives session resume with no double-counting
- Override state model records raise-ceiling and one-shot-continue with full audit fields (who, when, what dimension, old/new ceiling or oneshot grant, reason)
- All budget model unit tests pass and existing config/usage tests remain green (backward compatibility)
### Verification Commands
- bun run check
- bun test
