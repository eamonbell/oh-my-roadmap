# Roadmap-Engineer Enhancements Implementation Plan

## Summary

Implement the seven approved `ENHANCEMENTS.md` recommendations one enhancement at a time, in dependency-first order. The main implementation agent is
an orchestrator only: it may dispatch subagents, read their summaries, inspect diffs, and ask the user questions, but it must not write code, edit
files, or run tests. Each enhancement must be assigned to a fresh implementation worker subagent; that worker owns all code changes, test changes, and
verification commands for its enhancement.

Locked decisions:

- Order: dependency-first.
- Output: chat handoff only; no plan file written during planning.
- Orchestration v1: current extension surface only. No nested RPC process, no private dispatch API, and no direct subagent spawning from extension
  code.
- Verification: workers run focused tests plus `bun run check`; the final dashboard worker also runs `bun test` before reporting completion.

## Public Interfaces And State Changes

Add these durable files under `.roadmaps/<roadmap-id>/`:

- `events.ndjson` for append-only transition events.
- `blockers.yml` for canonical blocker records.
- Milestone runtime: `milestones/<milestone-id>/runtime.yml`.
- Change runtime: `milestones/<milestone-id>/changes/<change-id>.runtime.yml`.

Add or update public tool surfaces:

- `roadmap_engineer_read_events`
- `roadmap_engineer_list_quality_gates`
- `roadmap_engineer_open_blocker`
- `roadmap_engineer_resolve_blocker`
- `roadmap_engineer_defer_blocker`
- `roadmap_engineer_list_blockers`
- `roadmap_engineer_apply_next_action`
- `roadmap_engineer_prepare_wave_dispatch`
- `roadmap_engineer_record_wave_result`
- `roadmap_engineer_prepare_wave_review`
- `roadmap_engineer_record_wave_review`

Preserve compatibility:

- `roadmap_engineer_next_action` still returns readable text, with structured plan data in `details`.
- `loadState` still returns the effective `RoadmapState`, `MilestonePlan`, and `ChangeRequest` shapes, overlaying runtime state when present.
- Existing roadmap and plan files without runtime/blocker/event files continue to load.

## Sequential Worker Tasks

1. **Worker 1: Enhancement 4, append-only event ledger**
    - Add `RoadmapEvent` types, event path helpers, append/read helpers, and `roadmap_engineer_read_events`.
    - Append one event for every mutating transition, note append, amendment, change request creation, closeout record, and later blocker/gate/runtime
      mutation.
    - Event writes must happen under `.roadmaps/store.lock`; failed state writes must not append events, and failed event appends must fail the
      operation.
    - Tests: new event ledger tests plus focused existing lifecycle tests.

2. **Worker 2: Enhancement 1, durable roadmap quality-gate history**
    - Add `roadmap_revision`, `roadmap_content_hash`, and `RoadmapMilestoneCheck` metadata to roadmap state.
    - Increment revision and recompute `sha256(renderRoadmapMarkdown(roadmap))` on roadmap content mutation.
    - Make approval require a passed roadmap-milestone check for the current revision/hash.
    - Record every roadmap-milestone check as a `quality_gate.recorded` event and add `roadmap_engineer_list_quality_gates`.
    - Update report, state summary, validation, and dashboard summary for pending/failed/stale gate states.
    - Tests: stale-check rejection, failed-history preservation, list tool output, approval happy path.

3. **Worker 3: Enhancement 2, mutable runtime state split**
    - Add runtime types and read/write helpers for milestone and change runtime files.
    - On create, write `plan.md` plus initial runtime file.
    - On draft plan updates, update the plan definition and reset runtime only while planning.
    - Make `update_task_status`, `update_wave_status`, and `update_implementation_progress` write runtime only.
    - Keep `loadState` overlay behavior identical for callers.
    - Tests: old plan-without-runtime load, runtime file creation, runtime-only mutation does not rewrite `plan.md`, change-request runtime overlay.

4. **Worker 4: Enhancement 3, first-class blockers**
    - Add blocker state/types, blocker lifecycle helpers, and blocker tools.
    - Validation and implementation gate must close on open `severity: blocking` blockers.
    - `appendNote({ blocking: true })` auto-creates a canonical blocker and tags the note metadata with `blocker_id`; legacy open blocking notes still
      validate as blockers when no canonical blocker exists.
    - Blocker lifecycle changes append events.
    - Tests: open blocker closes gate, resolved/deferred opens gate, note compatibility, scoped blocker listing.

5. **Worker 5: Enhancement 5, executable next-action tooling**
    - Add `NextActionPlan` builder with stable ids, label, description, status, `safe_to_apply`, blockers, missing inputs, and scope.
    - Keep text next-action compatibility by deriving the old string from the structured plan.
    - Add `roadmap_engineer_apply_next_action` with required `actionId`; it only applies safe, unambiguous non-approval actions.
    - Refuse approval-required, agent-required, blocked, or stale actions with precise reasons.
    - Tests: structured pending/failed/stale gate actions, blocker-aware actions, safe wave/progress actions, refusal cases.

6. **Worker 6: Enhancement 6, automated wave execution orchestration**
    - Implement deterministic v1 orchestration inside the extension: prepare dispatch packages and record results; do not spawn subagents directly.
    - `prepare_wave_dispatch` validates gates, selects the active milestone/change, selects only the active wave, verifies dependencies and ownership,
      and returns exact worker assignments/prompts.
    - `record_wave_result` updates runtime task state and opens blockers for failed/blocked worker results.
    - `prepare_wave_review` returns the reviewer package once active-wave tasks are done.
    - `record_wave_review` marks the wave complete and advances progress on pass, or opens blockers and sets resolving state on failure.
    - Update `/milestone:implement` prompt to call these tools and then dispatch workers with the built-in task tool.
    - Tests: active-wave-only package, dependency refusal, worker role preservation, blocked worker result, passing/failing review transitions.

7. **Worker 7: Enhancement 7, operational dashboard controls**
    - Extend `buildRoadmapDetailSummary` with roadmap health, quality gates, active runtime execution, canonical blockers, recent events, structured
      next action, and available controls.
    - Update `/roadmap:details` TUI to show the new sections.
    - Add keyboard controls for safe next action, prepare wave dispatch, checker rerun instructions, blocker actions, and exact tool-call/prompt
      insertion. Approval-required actions must only insert instructions or ask for approval; they must not mutate directly.
    - Dashboard mutations must call the same core helpers/tools used by command flows.
    - Tests: summary model, narrow/wide TUI rendering, safe-action control behavior, blocker/event/gate display, full `bun test` and `bun run check`.

## Execution Protocol

For each worker task:

- Main agent dispatches exactly one fresh implementation worker subagent with that task text and relevant repo context.
- Worker must update code/tests, run its focused tests, run `bun run check`, and report changed files plus exact verification commands and results.
- Main agent may inspect the worker’s diff and summary but must not edit files or run tests.
- If verification fails or scope is incomplete, main agent re-dispatches the same enhancement to a worker with the failure details.
- No later enhancement starts until the current enhancement is implemented, verified by its worker, and reviewed for scope.

## Acceptance Criteria

- All seven included enhancements are implemented in dependency-first order.
- No enhancement combines code changes with another enhancement’s implementation task.
- Existing state remains readable, and public read/report/detail behavior remains compatible.
- Every mutating workflow operation records an event.
- Roadmap approval is revision/hash-safe.
- Runtime mutations stop rewriting approved plan markdown.
- Canonical blockers control gates and dashboards.
- Next actions are structured and safe actions are executable.
- Wave orchestration v1 produces deterministic dispatch/review packages and records results without direct extension-level subagent spawning.
- `/roadmap:details` becomes the operational surface for health, gates, blockers, events, runtime execution, and safe controls.
