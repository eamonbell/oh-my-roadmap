# Roadmap request: Execution budgets & cost governance

> **How to use this file.** Paste the "Feature request" section below as the prompt for `/omr:rm-new` to start a new roadmap. It is written to exercise
> oh-my-roadmap end-to-end (discovery → roadmap → milestone planning → implementation waves → review → closeout) on a real, cross-cutting feature. The
> planner should run its normal user interview and discovery before drafting — the open questions at the end are deliberate.

---

## Feature request

### Summary

Add **execution budgets and cost governance** to oh-my-roadmap: let a user set token / USD-cost / wall-clock ceilings for a roadmap and its milestones,
track live consumption against those ceilings from the work agents already do, and enforce them through the existing gate so an autonomous run warns,
pauses, or stops before it blows past a limit instead of discovering the overspend afterward.

### Motivation / problem

oh-my-roadmap orchestrates fleets of subagents (workers, reviewers, checkers) that run largely unattended across multiple implementation waves. Today
there is per-scope **usage accounting** (tokens and estimated cost are recorded per agent and rolled up per roadmap/milestone), but there is **no way to
cap it**. A mis-scoped milestone, a runaway rework loop, or a worker that keeps retrying can consume a large amount of tokens/money before a human notices.
Operators running this on real repos want a guardrail: "spend at most X on this milestone; warn me at 75%, pause the run at 100%, and never silently
exceed it." Cost control is one of the top real-world blockers to trusting an autonomous implementation agent, so this is a high-value addition.

### What we want (capabilities)

1. **Budget configuration.** Let a user declare budgets at two scopes — the whole **roadmap** and each **milestone** — covering three independent
   dimensions: cumulative **tokens**, estimated **USD cost**, and **wall-clock time** since the scope started. Any subset may be set; unset dimensions are
   unlimited. Budgets should be configurable both up front (at planning time) and adjustable later without corrupting an in-flight run.
2. **Threshold policy.** For each budget, support graduated thresholds with distinct behaviors — at minimum a **warn** level (surface a visible notice, keep
   going), a **soft** level (pause the orchestration at the next safe wave boundary and ask the user to confirm continuing), and a **hard** level (stop
   dispatching new work and require an explicit user override to proceed). Defaults should be sensible (e.g. warn at 75%, hard at 100%) but overridable.
3. **Live consumption accounting.** Reuse the existing usage tracking so budget consumption reflects real recorded token/cost deltas, plus elapsed time,
   rolled up correctly to the active milestone and to the roadmap. Accounting must be accurate under the workflow's realities: parallel workers in a wave,
   nested subagents, worker redispatch after transport failures, and session resume must not double-count or lose consumption.
4. **Enforcement at the gate.** Integrate with the pre-tool gate that already governs the run so that when a hard limit is reached, further work dispatch is
   blocked with a clear, actionable reason (how much was spent, which limit, and how to override or raise it) — mirroring how the pause/lockout gate already
   behaves. Enforcement must not block read-only inspection, blocker resolution, or the commands a user needs to raise/override the budget.
5. **Overrides & controls.** Give the operator first-class controls to inspect budgets and remaining headroom, raise or lower a budget mid-run, and grant a
   bounded, explicit override that lets the run continue past a hard stop (so the guardrail is firm but not a dead end).
6. **Surfacing.** Make budgets visible where operators already look: in status/report output (spent / remaining / % per dimension per scope, with a clear
   over-budget indicator), and in the terminal findings report at the end of a run. A user should never be surprised by spend.

### Usability requirements

- Configuration should feel consistent with the project's existing `.omr/config.yml` conventions and be forgiving: partial budgets, human-friendly units
  (e.g. cost as `"5.00"` or `5`, time as `30m`/`1h`), and clear validation errors on typos rather than silent misbehavior.
- Every enforcement moment (warn/soft/hard) must produce a message a human can act on immediately: what was hit, current spend vs. limit, and the exact
  command to continue, override, or adjust. No dead ends and no cryptic blocks.
- Status/reporting must be scannable at a glance and truthful when data is partial (e.g. cost is an estimate) — say so rather than implying false precision.

### Quality & accuracy requirements

- **No double-counting and no loss.** Consumption rollups must be exact across parallel waves, nested subagents, redispatched workers, and session
  resume/branch. A transport-failure redispatch must not re-bill the abandoned attempt's usage twice, and a resumed session must continue from the prior
  total, not reset.
- **No false enforcement.** A run must never be blocked by a budget that was not actually exceeded, and enforcement must be deterministic (the same state
  produces the same decision). Read-only and recovery paths must remain available even when a hard limit is hit.
- **Backward compatible.** Projects with no budgets configured must behave exactly as they do today (unlimited, no new prompts, no gate changes). Existing
  `.omr` state and configs must load unchanged.

### Scope (in)

- Budget config schema + validation at roadmap and milestone scope, across tokens / cost / time.
- Threshold policy (warn / soft / hard) with defaults and overrides.
- Consumption rollup built on the existing usage-tracking deltas, plus elapsed-time tracking per scope.
- Gate enforcement (block new work dispatch on hard limit; pause on soft limit) with clear reasons and preserved recovery/inspection paths.
- Operator controls to inspect, adjust, and override budgets (CLI and/or in-session commands consistent with the existing `/omr:*` surface).
- Surfacing in status/report output and the terminal findings report.
- Tests and documentation.

### Non-goals (out)

- Real-time provider billing integration or exact invoice reconciliation — estimated cost from existing usage accounting is sufficient; do not build a
  billing API client.
- Per-tool or per-file micro-budgets, and budgets for ad-hoc (`/omr:adhoc-*`) runs — roadmap and milestone scope only for this feature.
- A GUI/web dashboard — surface through the existing terminal report/status and command surfaces.
- Hard real-time interruption mid-tool-call — enforcement at dispatch/wave boundaries (the run's natural safe points) is acceptable and preferred.

### Integration constraints (fit the existing architecture)

- Config lives in `.omr/config.yml`, parsed and validated in `packages/core` alongside the existing agent/orchestration config; global→project merge and
  the "re-run init preserves settings" behavior should extend naturally.
- Consumption must build on the existing usage subsystem (`packages/core/src/usage.ts` and the `usage-tracking` extension wiring) rather than a parallel
  accounting path.
- Enforcement must go through the existing pre-tool gate (`packages/core/src/gate.ts` + `hooks/pre/roadmap-gate.ts`) and the orchestration pause mechanism,
  not a new interception layer.
- Follow the project's engineering guidance in `AGENTS.md` (keep it simple, control scope, no speculative abstraction) and the monorepo conventions
  (core = TS source consumed directly, extension = TS, CLI = bundled). New operator commands should match the `/omr:*` naming and routing.

### Acceptance intent (definition of done)

- A user can configure a roadmap-level and milestone-level budget across tokens/cost/time, run a milestone, and observe accurate live consumption and
  remaining headroom in status/report output.
- Crossing a warn threshold surfaces a visible notice without interrupting; crossing a soft threshold pauses at the next safe wave boundary; crossing a
  hard threshold blocks new work dispatch with an actionable reason and a working override.
- With no budgets configured, behavior is byte-for-byte the current behavior (verified by existing tests staying green).
- Accounting is proven correct under parallel workers, nested subagents, worker redispatch, and session resume.

### Verification approach (respect project constraints)

- Verify with `bun run check` (tsc) and `bun test`; add focused unit tests for budget parsing/validation, consumption rollup (including the double-count and
  resume cases), and the gate enforcement decision (warn/soft/hard, override, read-only-still-allowed). Node-level smoke where useful.
- **Do not** run the extension under a live OMP session as a verification step; exercise the pure core logic (config, rollup, gate) directly in tests.

### Open questions for planning (resolve during discovery/interview)

- Where exactly do time budgets start counting — scope creation, first dispatch, or first assistant turn — and how should elapsed time survive a paused run?
- Should thresholds be percentages, absolute values, or both, and should the three dimensions each carry independent warn/soft/hard levels?
- What is the safest override model — a one-shot "continue once", a raised ceiling, or a time-boxed grant — and how is it recorded/audited in `.omr` state?
- How should budgets interact with change requests (`/omr:chg-*`) layered onto a milestone?
- What is the right precision and disclaimer for the cost estimate, and how should partial/unknown usage be represented in status?
