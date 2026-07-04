# Implementation Summary — Batch A: Reliability-first orchestration

**Scope:** Recommendations R3, R4, R5, R12 from `USAGE-FINDINGS.md`
**Commit:** `b359c84` on branch `context-opti`
**Compatibility policy:** break only with migrate — batch stayed fully additive; no `omr migrate` required.

## Goal

Give agents deterministic next-action guidance for observed workflow-order failures:
- `/omr:ms-implement` should open implementation before dispatching workers.
- Completed-wave advancement should be surfaced explicitly via next-action hints (no auto-advance).
- Implementation/planning prompts should stop encouraging repeated short `job` polls.

## Changes by recommendation

### R3 — Deterministic next-action guidance on tool successes/errors

- **`packages/core/src/report/types.ts`** — Added `NextActionTool` and `NextActionHint` interfaces; refactored `NextActionPlan.tool` to `tool?: NextActionTool` (type-only; runtime JSON unchanged).
- **`packages/core/src/report/shared.ts`** — Added `nextActionHint(plan, why): NextActionHint[]` — returns `[]` when `plan.tool` is absent, else a single `{ label, tool, why }`.
- **`packages/core/src/report/index.ts`** — Exports the new types and helper.
- **`packages/extension/src/tools/register/transition-tools.ts`** — `omr_transition` success now returns `{...state, next_actions}` and appends `Next action: <label>.` to the text when a hint exists. State fields (`roadmap`, `milestone`, `changeRequest`, …) remain at top level.
- **`packages/extension/src/tools/register/report-tools.ts`** — `omr_validate` success returns `{...result, next_actions}`, appending `\nNext action: <label>.` only when a hint exists.
- **`packages/extension/src/tools/register/wave-tools.ts`** — `omr_prepare_wave_dispatch` errors are wrapped by `appendNextActionToError()`, which appends `Next action: <label> via <tool> <json> — <why>` computed from `nextActionPlan()`.

**Failure handling:** hint computation is isolated in try/catch everywhere — if `nextActionPlan()` throws while the primary tool succeeded, the tool still succeeds with `next_actions: []`; error-path hint failures fall back to the original error message unchanged.

### R4 — `/omr:ms-implement` first-step guidance

- **`packages/extension/src/extension/commands/prompts.ts`** — Inserted, before the existing dispatch instruction:
  - If phase is `milestone_approved`, call `omr_transition` `start_implementation` first; don't dispatch until implementation is open.
  - If the active change request is `approved`, `start_implementation` before dispatching change-request workers.
  - If phase is `reviewing`/`closeout`, don't dispatch; follow `omr_next_action`/closeout next actions.

### R5 — Explicit completed-wave hints, no auto-advance

- **`packages/core/src/wave-orchestration/types.ts`** — Added optional `next_actions?: NextActionHint[]` to `PrepareWaveDispatchResult` and `RecordWaveReviewResult`.
- **`packages/core/src/wave-orchestration/review.ts`** — On the `passed` branch, existing behavior is preserved (mark wave complete, `setProgress(..., 'ready_for_next_wave', [])`, keep `active_wave_id`). It then returns one hint:
  - **Advance to next wave** → `update_implementation_progress` with `{ activeWaveId: nextWave.id, step: 'not_started', activeTaskIds: [] }`, only when the next wave is `pending`.
  - **Mark closeout ready** → `update_implementation_progress` with `{ step: 'closeout_ready', activeTaskIds: [] }`, when all waves are complete.
  - No hint if the active wave isn't found, or the next incomplete wave is `running`/`reviewing`/`blocked`.
- No `omr_advance_wave` added; `recordWaveReview` never auto-advances state.

### R12 — Tighten job-wait guidance

- **`packages/extension/src/extension/commands/prompts.ts`** — After dispatch/recording guidance in `/omr:ms-implement`: issue one blocking `job` wait with a meaningful timeout; don't loop short polls; retry only after interrupt/timeout/new liveness evidence. Use IRC liveness checks only after timeout/interruption or when a worker should exist but the job handle is absent.
- **`packages/extension/skills/implementation-orchestrator/SKILL.md`** — Same one-blocking-wait rule near dispatch/active-run guidance; existing IRC-first recovery rules preserved.
- **`packages/extension/skills/milestone-planner/SKILL.md`** — Planner waits once (blocking) for the wave-flow-checker result; IRC only for a live peer with context or after timeout.
- **`packages/extension/skills/roadmap-planner/SKILL.md`** — Same one-blocking-wait guidance after the roadmap-milestone-checker dispatch instruction.

Generated worker/reviewer agent templates were intentionally **not** changed in this batch.

## Tests

- **`test/commands.test.ts`** — `/omr:ms-implement` prompt contains the `start_implementation` instruction *before* the dispatch line, plus `one blocking job wait`, `Do not loop short job polls`, and `Use IRC liveness checks only after a timeout`.
- **`test/state/wave-orchestration.test.ts`** — Passing `w01` review returns an `Advance to next wave` hint targeting `w02` while progress stays `{ active_wave_id: 'w01', step: 'ready_for_next_wave' }` (proves no auto-advance); a single/final-wave variant returns `Mark closeout ready` without mutating state to closeout.
- **`test/tools/action-tools.test.ts`** — `omr_prepare_wave_dispatch` before `start_implementation` rejects with the gate error + `Next action: Start implementation via omr_transition`; on a completed active wave rejects with `Active wave w01 is already complete` + `update_implementation_progress` for `w02`.
- **`test/tools/roadmap-tools.test.ts`** — `omr_transition` (approve roadmap) success details include `next_actions[0].tool.input.operation === 'start_milestone_planning'`; `omr_validate` on the same state includes matching `next_actions`.

## Verification

```
bun run check   # tsc --noEmit → exit 0, no errors
bun test test/commands.test.ts test/state/wave-orchestration.test.ts \
  test/tools/action-tools.test.ts test/tools/roadmap-tools.test.ts \
  test/state/tool-friction-improvements.test.ts
# → 51 pass, 0 fail, 518 expect() calls
```

## Notes

- `USAGE-FINDINGS.md` gained a targeting table marking R3/R4/R5/R12 as targeted (Batch A) and all others deferred.
- The final-wave "Mark closeout ready" hint omits `activeWaveId` in its progress input (matches `passedWaveNextActions` in `review.ts`).
- Deferred to future batches: R1/R2/R6/R7/R8/R9/R10/R11/R13/R14/R15.
