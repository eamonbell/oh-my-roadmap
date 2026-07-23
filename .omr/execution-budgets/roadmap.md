---
roadmap_id: execution-budgets
title: Execution budgets & cost governance
status: finalized
---

# Execution budgets & cost governance

## Goal

Add execution budgets and cost governance to oh-my-roadmap: let operators set token, USD-cost, and wall-clock ceilings at roadmap and milestone scope, track live consumption against those ceilings from existing usage deltas plus elapsed time, and enforce through the existing gate so autonomous runs warn, pause, or stop before exceeding a limit instead of discovering overspend afterward.

## Success Criteria

- A user can configure a roadmap-level and milestone-level budget across tokens/cost/time, run a milestone, and observe accurate live consumption and remaining headroom in status/report output
- Crossing a warn threshold surfaces a visible notice without interrupting; crossing a soft threshold pauses at the next safe wave boundary; crossing a hard threshold blocks new work dispatch with an actionable reason and a working override
- With no budgets configured, behavior is byte-for-byte the current behavior (existing tests stay green)
- Accounting is proven correct under parallel workers, nested subagents, worker redispatch, and session resume (no double-counting, no loss)
- Operator controls exist to inspect budgets/headroom, raise or lower a ceiling mid-run, and grant a one-shot continue past a hard stop

## Constraints

- Config lives in .omr/config.yml alongside existing agent/orchestration config; global->project merge and ensureConfig preservation must extend naturally (packages/core/src/project-init.ts)
- Consumption must build on the existing usage subsystem (packages/core/src/usage.ts) and the usage-tracking extension wiring (packages/extension/src/extension/usage-tracking.ts), not a parallel accounting path
- Enforcement must go through the existing pre-tool gate (packages/core/src/gate.ts + hooks/pre/roadmap-gate.ts) and the orchestration pause mechanism, not a new interception layer
- Wave-boundary enforcement hooks into prepareWaveDispatch/prepareWorkerRedispatch via assertImplementationReady (packages/core/src/wave-orchestration/dispatch.ts, context.ts)
- New operator commands must match the /omr:* naming and routing convention (packages/extension/src/extension/commands/catalog.ts)
- Follow AGENTS.md: keep it simple, control scope, no speculative abstraction, no reusable systems for single-use code
- Backward compatible: projects with no budgets must behave exactly as today; existing .omr state and configs must load unchanged
- Do not run the extension under a live OMP session for verification; exercise pure core logic directly in tests

## Non-Goals

- Real-time provider billing integration or exact invoice reconciliation — estimated cost from existing usage accounting is sufficient
- Per-tool or per-file micro-budgets
- Budgets for ad-hoc (/omr:adhoc-*) runs — roadmap and milestone scope only
- A GUI/web dashboard — surface through existing terminal report/status and command surfaces
- Hard real-time interruption mid-tool-call — enforcement at dispatch/wave boundaries is acceptable and preferred
- Separate change-request budgets — change requests inherit the parent milestone's budget

## Context

- Budget storage model (user decision): default threshold policy in .omr/config.yml (global->project merge), per-roadmap/milestone budget ceilings set via commands and stored in .omr state files
- Time budget start (user decision): clock starts at first wave dispatch in the scope; pausing (soft limit or manual disable) stops the clock; resuming continues from prior elapsed total
- Threshold model (user decision): shared percentage thresholds across all three dimensions (defaults: warn 75%, soft none, hard 100%), overridable per budget
- Override model (user decision): support both raising the ceiling and granting a one-shot continue; both recorded/audited in .omr state
- Change request interaction (user decision): change requests inherit the parent milestone's budget; no separate CR budget
- Cost estimate verification: cost.total (from @oh-my-pi/pi-catalog/models.ts calculateCost) includes cache token costs (input + output + cacheRead + cacheWrite pricing). estimated_usd in usage.ts reads cost.total as-is. usd_unavailable flag set when OMP provides no cost.total. Reasoning tokens are NOT in cost.total directly (provider-dependent overlap with output).
- Token dimension: existing totalTokens() in report/shared.ts sums input + output + cache_read + cache_write, excluding reasoning_tokens. Budget token accounting should decide whether reasoning_tokens count.
- Usage dedup: usage.ts applyDelta uses dedupe_keys array to prevent double-counting. Already handles nested subagents via collectTaskDeltas and task tool results. recordMainUsage handles assistant messages; recordTaskUsage handles task results.
- Gate structure: gate.ts shouldBlockToolCall has two gates — lockout (isOmrToolCall + loadDisabled) and implementation write-gate (DIRECT_FILE_WRITE_TOOLS + validateImplementationGate). Budget enforcement adds a third dimension to the dispatch-blocking gate.
- Wave dispatch enforcement point: prepareWaveDispatch and prepareWorkerRedispatch both call assertImplementationReady before dispatching. This is where hard/soft budget limits hook in.
- Reporting surface: report/shared.ts usageLines formats per-scope usage. formatUsd shows $X.XXXX + unknown when usd_unavailable. Budget status extends this with spent/remaining/%/over-budget indicators.
- State storage: roadmapStatePath = .omr/<id>/state.yml, roadmapUsagePath = .omr/<id>/usage.yml, milestoneDir = .omr/<id>/milestones/<ms-id>/. Budget state follows these conventions.

## Evidence

- packages/core/src/project-init.ts:57-66 — RoadmapProjectConfig interface with agents, orchestration, disabled, style, moshi fields. New budgets field would be optional.
- packages/core/src/project-init.ts:266-287 — parseConfig with rejectUnknownKeys; new field must be added to allowed list
- packages/core/src/project-init.ts:309-346 — ensureConfig preserves existing optional keys (disabled, style, moshi) on re-init; budgets must follow same pattern
- packages/core/src/project-init.ts:365-401 — mergeConfigs shallow-merges optional fields; budgets must merge similarly
- packages/core/src/usage.ts:7-32 — UsageTotals (estimated_usd, usd_unavailable, requests, input/output/cache_read/cache_write/reasoning_tokens), RoadmapUsageSummary with dedupe_keys and milestones map
- packages/core/src/usage.ts:250-290 — totalsFromUsage reads cost.total from OMP message; applyDelta deduplicates via dedupe_keys; already handles nested subagents
- packages/core/src/usage.ts:357-449 — recordMainUsage (assistant messages) and recordTaskUsage (task results with nested subagent deltas)
- packages/core/src/gate.ts:81-111 — shouldBlockToolCall: lockout gate + implementation write-gate. Budget enforcement extends the dispatch-blocking path.
- packages/core/src/wave-orchestration/dispatch.ts:228-285 — prepareWaveDispatch calls assertImplementationReady before dispatching; the wave-boundary enforcement point
- packages/core/src/wave-orchestration/dispatch.ts:287-366 — prepareWorkerRedispatch also calls assertImplementationReady
- packages/core/src/wave-orchestration/context.ts:56-62 — assertImplementationReady calls validateImplementationGate
- packages/core/src/validation.ts:405-479 — validateImplementationGate checks phase, approval, blocker state
- packages/core/src/report/shared.ts:29-89 — totalTokens, formatUsd, formatUsage, usageLines: the reporting surface to extend
- packages/extension/src/extension/commands/catalog.ts — /omr:* command naming convention; omr:rm-usage already exists
- packages/extension/src/extension/usage-tracking.ts — usage-tracking extension wiring (message_end, tool_execution_end events)
- packages/extension/hooks/pre/roadmap-gate.ts — gate hook calling shouldBlockToolCall
- node_modules/@oh-my-pi/pi-catalog/src/models.ts:46-54 — calculateCost: cost.total = input + output + cacheRead + cacheWrite costs, confirming cost estimates include cache usage

## Discovery Findings

- Config system (packages/core/src/project-init.ts): RoadmapProjectConfig uses strict rejectUnknownKeys, supports global->project merge via mergeConfigs, and ensureConfig preserves existing settings on re-init. New optional fields must be added to the allowed-keys list in parseConfig, ensureConfig, and mergeConfigs.
- Usage system (packages/core/src/usage.ts): Delta-based rollup with dedupe_keys array prevents double-counting. UsageTotals has estimated_usd + usd_unavailable flag. recordMainUsage handles assistant messages; recordTaskUsage handles task tool results including nested subagents via collectTaskDeltas. Storage at .omr/<roadmap_id>/usage.yml. No time tracking exists today.
- Gate system (packages/core/src/gate.ts): shouldBlockToolCall has two gates — lockout (isOmrToolCall + loadDisabled) and implementation write-gate (DIRECT_FILE_WRITE_TOOLS + validateImplementationGate). Hook in packages/extension/hooks/pre/roadmap-gate.ts. Budget enforcement would add a third gate or extend the lockout pattern.
- Wave dispatch (packages/core/src/wave-orchestration/dispatch.ts): prepareWaveDispatch calls assertImplementationReady → validateImplementationGate before dispatching. prepareWorkerRedispatch also calls assertImplementationReady. These are the wave-boundary enforcement points where soft/hard budget limits would hook in.
- Commands (packages/extension/src/extension/commands/catalog.ts): /omr:* naming convention. omr:rm-usage already exists for usage reporting. Budget commands would follow omr:budget-* naming.
- Reporting (packages/core/src/report/shared.ts): usageLines formats per-scope usage (roadmap/milestone/change). formatUsd shows $X.XXXX + 'unknown' when usd_unavailable. Budget status would extend this with spent/remaining/%/over-budget indicators.
- State types (packages/core/src/types.ts): RoadmapState holds roadmap-level state; LoadedState includes usage. MilestonePlan holds milestone-level state. Budget ceilings and overrides would be stored in these state structures or companion state files.
- Paths (packages/core/src/paths.ts): roadmapStatePath = .omr/<id>/state.yml, roadmapUsagePath = .omr/<id>/usage.yml, milestoneDir = .omr/<id>/milestones/<ms-id>/. Budget state files would follow these conventions.
- Cost estimate verification: cost.total (from @oh-my-pi/pi-catalog/models.ts calculateCost) includes cache token costs (input + output + cacheRead + cacheWrite pricing). estimated_usd in usage.ts reads cost.total as-is. usd_unavailable flag set when OMP provides no cost.total. Reasoning tokens are NOT in cost.total directly (provider-dependent overlap with output).

## Milestones

### ms-budget-model - Budget model: config, validation, and consumption accounting

Goal: Establish the core budget data model: config schema and validation for threshold defaults, per-roadmap/milestone budget ceiling storage in .omr state, consumption computation (spent vs ceiling per dimension per scope) built on existing usage deltas, and pause-aware elapsed-time tracking. This milestone delivers the pure core logic that enforcement and surfacing build on, with no gate or UI changes yet.

Scope:
- Budget config schema in .omr/config.yml: a `budgets` section with default threshold policy (warn/soft/hard percentages). Extend RoadmapProjectConfig, parseConfig (rejectUnknownKeys), ensureConfig (preserve on re-init), and mergeConfigs (global->project merge) in packages/core/src/project-init.ts.
- Budget parsing and validation: human-friendly units (time as 30m/1h/2h30m, cost as 5.00 or 5, tokens as integer). Clear validation errors on typos. Follow the existing parseRoleConfig/parseOrchestrationConfig pattern.
- Per-roadmap and per-milestone budget ceiling storage in .omr state: budget ceilings (tokens/cost/time) settable at roadmap scope (state.yml or companion file) and milestone scope (plan.md frontmatter or runtime). Any subset of dimensions may be set; unset = unlimited.
- Consumption computation: a pure function that takes the existing RoadmapUsageSummary (tokens + estimated_usd) plus elapsed time and computes spent vs ceiling per dimension per scope (roadmap, milestone). Built on packages/core/src/usage.ts loadUsageSummary, not a parallel accounting path.
- Elapsed-time tracking per scope: record a start timestamp at first wave dispatch in the scope (extend the implementation progress or runtime state). Track pause/resume intervals so pausing (soft limit, manual disable) stops the clock and resuming continues from the prior elapsed total. Must survive session resume.
- Token dimension definition: decide whether token budgets include reasoning_tokens (currently excluded from totalTokens in report/shared.ts). Document the choice and apply consistently.
- Override state model: data structures for raise-ceiling and one-shot-continue overrides, stored in .omr state with audit fields (who, when, what dimension, old/new ceiling or oneshot grant, reason).
- Unit tests for budget parsing/validation (valid/invalid configs, human-friendly units, partial budgets), consumption computation (spent vs ceiling, unlimited dimensions), and elapsed-time tracking (pause/resume, session resume, no double-count).

Non-Goals:
- Gate enforcement (warn/soft/hard behavior, dispatch blocking) — that is ms-enforcement
- Operator commands and CLI surface — that is ms-operator-surface
- Status/report output changes and findings report integration — that is ms-operator-surface
- Moshi notifications for budget events

Evidence:
- packages/core/src/project-init.ts:57-66,266-346,365-401 — config interface, parsing, ensureConfig, mergeConfigs
- packages/core/src/usage.ts:7-32,196-290 — UsageTotals, loadUsageSummary, applyDelta with dedupe
- packages/core/src/report/shared.ts:29-31 — totalTokens excludes reasoning_tokens
- packages/core/src/types.ts:96-120,253-270 — RoadmapState, PlanRuntime (progress, worker_runs)
- packages/core/src/paths.ts:59-69,95-105 — roadmapStatePath, roadmapUsagePath, milestoneDir, milestoneRuntimePath

Dependencies:
- (none)

Risks:
- Elapsed-time tracking is a new subsystem — no existing time-tracking code to build on. The pause-aware model (stop on pause, resume from prior total) requires careful state management to survive session resume without losing or double-counting time.
- Adding a new config field to rejectUnknownKeys is safe for existing configs (they simply won't have it), but ensureConfig must preserve it on re-init like it does for disabled/style/moshi.
- The token dimension definition (with/without reasoning_tokens) must be consistent across consumption, reporting, and enforcement — changing it later would break budget semantics.

Acceptance Intent:
- Budget config can be parsed from .omr/config.yml with threshold defaults, validated with clear errors, and merged across global/project scopes
- Per-roadmap and per-milestone budget ceilings can be stored in .omr state and read back correctly
- Consumption computation correctly reports spent vs ceiling per dimension per scope, using existing usage deltas
- Elapsed-time tracking starts at first dispatch, pauses correctly, and survives session resume
- All budget model unit tests pass

Verification Intent:
- bun run check (tsc) passes with no type errors
- bun test passes including new budget model unit tests
- Existing config/usage tests remain green (backward compatibility)

### ms-enforcement - Enforcement: threshold policy, gate integration, and overrides

Goal: Wire the budget model into the existing enforcement machinery: evaluate thresholds (warn/soft/hard) against live consumption, integrate with the pre-tool gate to block new work dispatch on hard limits and pause on soft limits at wave boundaries, implement the override mechanism (raise ceiling + one-shot continue), and ensure read-only/recovery paths remain available when a hard limit is hit.

Scope:
- Threshold evaluation: a pure function that takes consumption (spent vs ceiling per dimension) and threshold policy (warn/soft/hard percentages) and returns the highest breached level per scope. Deterministic — same state produces same decision. Shared percentages across all three dimensions.
- Gate integration: extend shouldBlockToolCall in packages/core/src/gate.ts to check budget enforcement alongside the existing lockout and write gates. Hard limit blocks new work dispatch (omr agent spawns, omr dispatch tools) with a clear, actionable reason (which limit, current spend vs ceiling, how to override). Must NOT block read-only inspection, blocker resolution, or budget adjustment commands.
- Wave-boundary enforcement: hook budget evaluation into the dispatch path (prepareWaveDispatch/prepareWorkerRedispatch via assertImplementationReady or a parallel assertion). Soft limit pauses at the next safe wave boundary (sets implementation progress to a blocked/paused state with a budget-pause reason). Hard limit throws with an actionable message.
- Override mechanism: implement raise-ceiling (updates the stored budget ceiling, re-evaluates enforcement) and one-shot-continue (grants a single wave dispatch past the hard limit, then re-locks). Both recorded in .omr state with audit fields. Overrides are applied via budget commands, not config file edits.
- Warn-level surfacing: when a warn threshold is crossed, surface a visible notice (in status output, next-action hints, or report) without interrupting the run. The notice includes which dimension/scope, current spend vs ceiling, and the percentage.
- Soft-pause behavior: when a soft threshold is crossed, the run pauses at the next wave boundary with a clear message asking the user to confirm continuing. The user can continue (which may trigger a one-shot or raise) or adjust the budget.
- Read-only path preservation: verify that when a hard limit is hit, omr status/report/search/usage commands, blocker resolution, and budget adjustment commands all still work. Only work dispatch is blocked.
- Unit tests for threshold evaluation (warn/soft/hard, no-budget, unlimited dimensions, override-applied), gate enforcement decision (block dispatch, allow reads, allow budget commands), and override application (raise, one-shot, re-lock after one-shot).

Non-Goals:
- Operator command UI/CLI parsing and routing — that is ms-operator-surface (this milestone provides the core functions the commands call)
- Status/report output formatting — that is ms-operator-surface (this milestone provides the enforcement data to display)
- Budget config parsing and consumption computation — delivered in ms-budget-model
- Moshi notifications for budget events

Evidence:
- packages/core/src/gate.ts:81-111 — shouldBlockToolCall: lockout gate + write gate. Budget enforcement extends this.
- packages/core/src/wave-orchestration/dispatch.ts:228-285 — prepareWaveDispatch calls assertImplementationReady before dispatching
- packages/core/src/wave-orchestration/dispatch.ts:287-366 — prepareWorkerRedispatch also calls assertImplementationReady
- packages/core/src/wave-orchestration/context.ts:56-62,118-125 — assertImplementationReady, assertDispatchableWave
- packages/core/src/validation.ts:405-479 — validateImplementationGate: phase/approval/blocker checks
- packages/extension/hooks/pre/roadmap-gate.ts — gate hook
- packages/core/src/types.ts:206-270 — ImplementationProgress, PlanRuntime (step, active_wave_id, blockedReason)

Dependencies:
- ms-budget-model

Risks:
- The gate must distinguish between work-dispatch tools (block on hard limit) and read-only/recovery tools (always allow). The existing isOmrToolCall check is too broad — it blocks ALL omr tools. Budget enforcement needs a finer-grained classification.
- Soft-pause at wave boundary must not corrupt in-flight worker runs. If workers are already dispatched when a soft limit is crossed, the pause must wait for the current wave to complete, not interrupt running workers.
- One-shot continue must be atomic: grant, allow one dispatch, then re-lock. If the dispatch fails or the worker is redispatched, the one-shot must not be consumed incorrectly.
- Threshold evaluation reads usage state which is updated asynchronously by the usage-tracking extension. The existing withStoreWriteLock protects writes; threshold evaluation must read consistently (either under the lock or from a consistent snapshot).

Acceptance Intent:
- Crossing a warn threshold surfaces a visible notice without interrupting the run
- Crossing a soft threshold pauses at the next safe wave boundary with a clear message and recovery instructions
- Crossing a hard threshold blocks new work dispatch with an actionable reason (which limit, spend vs ceiling, override command)
- Read-only inspection, blocker resolution, and budget adjustment commands work even when a hard limit is hit
- Raise-ceiling override re-evaluates enforcement and allows dispatch if under the new ceiling
- One-shot continue allows exactly one wave dispatch past the hard limit, then re-locks
- Enforcement is deterministic — same state produces same decision

Verification Intent:
- bun run check (tsc) passes
- bun test passes including new enforcement unit tests (threshold evaluation, gate decision, override application)
- Existing gate/validation tests remain green (no budgets = no enforcement, backward compatible)

### ms-operator-surface - Operator controls & surfacing

Goal: Deliver the operator-facing surface: budget commands (inspect, set/adjust, override) following the /omr:* convention, budget status in report/status output (spent/remaining/%/over-budget per dimension per scope), and budget summary in the terminal findings report. Also verify end-to-end backward compatibility.

Scope:
- Budget commands: omr:budget-show (inspect budgets and remaining headroom per scope), omr:budget-set (set or adjust a roadmap/milestone budget ceiling), omr:budget-override (grant raise-ceiling or one-shot-continue override). Follow the existing command registration pattern in packages/extension/src/extension/commands/ (catalog.ts, register.ts, prompts.ts).
- Status/report integration: extend report/shared.ts usageLines and related formatters to show budget status — spent / remaining / % per dimension per scope, with a clear over-budget indicator and estimated-cost disclaimer (usd_unavailable). Integrate into omr:rm-status and omr:rm-usage output.
- Findings report integration: include a budget summary (spent vs ceiling per scope, any breached thresholds, overrides granted) in the terminal findings report at the end of a run, via omr_submit_findings_report.
- Command prompt templates: add prompt templates for the budget commands in packages/extension/src/prompts/ or the commands prompts file, guiding the orchestrator to call the right core functions.
- End-to-end backward compatibility verification: run the full existing test suite (bun test) to confirm no budgets = current behavior. Add a smoke test that creates a roadmap with no budgets, runs status/report, and verifies output is unchanged.
- Documentation: update docs/ (design.md or tutorial.md) with budget configuration and usage examples, consistent with existing doc style.
- Integration tests: verify that setting a budget, running a milestone, and observing consumption/enforcement works end-to-end through the core functions (not a live OMP session).

Non-Goals:
- Budget config parsing, consumption computation, elapsed-time tracking — delivered in ms-budget-model
- Threshold evaluation, gate enforcement, override mechanism — delivered in ms-enforcement
- New budget-specific Moshi notification events
- Per-tool or per-file budget micro-management

Evidence:
- packages/extension/src/extension/commands/catalog.ts — /omr:* command naming and catalog
- packages/extension/src/extension/commands/register.ts — command registration pattern
- packages/extension/src/extension/commands/prompts.ts — command prompt templates
- packages/extension/src/extension/commands/usage.ts — existing omr:rm-usage command (pattern to follow)
- packages/core/src/report/shared.ts:29-89 — usageLines, formatUsd, formatUsage (reporting surface to extend)
- packages/core/src/state-summary.ts — state summary for status reporting
- packages/extension/src/findings.ts — findings report tile
- packages/extension/src/extension/commands/messages.ts — command message sending
- docs/design.md, docs/tutorial.md — existing documentation

Dependencies:
- ms-budget-model
- ms-enforcement

Risks:
- Command surface must be minimal and consistent — AGENTS.md warns against unnecessary abstraction. Three commands (show, set, override) is the minimum viable set; avoid over-fragmenting.
- Status/report output must remain scannable — adding budget lines to already-dense usage output risks information overload. Budget status should be shown only when budgets are configured.
- Backward compatibility verification must be thorough — any change to report/shared.ts or state-summary.ts that affects non-budget output is a regression.
- Documentation must match the actual implementation, not the design intent — write docs after implementation is verified.

Acceptance Intent:
- omr:budget-show displays budgets and remaining headroom per dimension per scope with clear over-budget indicators
- omr:budget-set sets or adjusts a roadmap/milestone budget ceiling, stored in .omr state
- omr:budget-override grants a raise-ceiling or one-shot-continue override, recorded with audit fields
- omr:rm-status and omr:rm-usage output includes budget status when budgets are configured, and is unchanged when no budgets are configured
- The terminal findings report includes a budget summary
- Full existing test suite passes (backward compatibility)
- Documentation describes budget configuration and usage

Verification Intent:
- bun run check (tsc) passes
- bun test passes including new command and reporting tests
- Existing tests remain green (no budgets = current output, backward compatible)
- Manual verification: set a budget, run status, observe budget lines; clear budgets, run status, observe no budget lines

## Risks

- Elapsed-time tracking is a new subsystem with no existing precedent in the codebase. Pause-aware time accounting (stop clock on pause, resume from prior total) adds state management complexity. Must survive session resume correctly.
- Budget enforcement at the gate must not block read-only inspection, blocker resolution, or budget adjustment commands. The existing lockout gate blocks ALL omr tools when disabled — budget enforcement needs a more nuanced gate that blocks only work dispatch, not recovery/inspection.
- Config.yml is project-wide but budgets are per-roadmap/milestone. The split between config defaults (threshold policy) and state overrides (actual ceilings) must be clean and not create confusion about which is authoritative.
- Backward compatibility is critical: any change to config parsing, usage tracking, or gate logic that affects projects without budgets must be a no-op. The rejectUnknownKeys pattern means a new config field must be explicitly allowed or existing configs will fail to parse.
- Override auditing: both raise-ceiling and one-shot-continue overrides must be recorded in .omr state with enough detail (who, when, what, why) for post-run audit. State file format must be stable and forward-compatible.
- Threshold evaluation must be deterministic — the same state produces the same decision. Race conditions between parallel usage recording and threshold evaluation must be handled (usage recording is already lock-protected via withStoreWriteLock).

## Open Questions

- (none)
