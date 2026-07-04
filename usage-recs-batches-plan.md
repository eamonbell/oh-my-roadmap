## Context

Implement the first selected batch from `USAGE-FINDINGS.md`: **Option A — Reliability-first orchestration batch**, targeting R3, R4, R5, and R12 only. The intended end state is that agents get deterministic next-action guidance for the observed workflow-order failures, `/omr:ms-implement` starts implementation before dispatching workers from `milestone_approved`, completed-wave advancement is explicit via next-action hints, and implementation/planning prompts stop encouraging repeated short `job` polls. `USAGE-FINDINGS.md` must also be updated during execution with a targeting table showing R3/R4/R5/R12 as targeted and all other recommendations as deferred for this batch.

Compatibility policy for this batch: no public behavior or persisted state shape should break. The user selected “break only with migrate”; this batch is expected to stay additive, so do not add `omr migrate` unless a required implementation detail would otherwise break existing persisted files, generated agents, or public tool input/output defaults.

## Approach

### 1. Mark the selected recommendations in `USAGE-FINDINGS.md`

Edit `USAGE-FINDINGS.md` before code changes so the source findings reflect the selected scope.

- Insert a compact targeting table immediately after the `## Recommendations` heading and before `### R1. Return compact mutation receipts from omr_transition`.
- Use this exact table content:

| Recommendation | Status for this implementation | Batch | Notes |
| --- | --- | --- | --- |
| R1 | Deferred | — | Not in reliability-first batch. |
| R2 | Deferred | — | Not in reliability-first batch. |
| R3 | Targeted | A — Reliability-first orchestration | Add deterministic next-action guidance to relevant tool successes/errors. |
| R4 | Targeted | A — Reliability-first orchestration | Fix `/omr:ms-implement` first-step guidance. |
| R5 | Targeted | A — Reliability-first orchestration | Use next-action hints only; do not auto-advance waves and do not add `omr_advance_wave`. |
| R6 | Deferred | — | Not in reliability-first batch. |
| R7 | Deferred | — | Not in reliability-first batch; strict schema work is intentionally deferred. |
| R8 | Deferred | — | Not in reliability-first batch. |
| R9 | Deferred | — | Not in reliability-first batch. |
| R10 | Deferred | — | Not in reliability-first batch. |
| R11 | Deferred | — | Not in reliability-first batch. |
| R12 | Targeted | A — Reliability-first orchestration | Tighten job-wait guidance in implementation and planning prompts. |
| R13 | Deferred | — | Not in reliability-first batch. |
| R14 | Deferred | — | Not in reliability-first batch. |
| R15 | Deferred | — | Not in reliability-first batch. |

- Do not edit recommendation bodies beyond inserting this table.

### 2. Add a shared next-action hint type without changing existing `NextActionPlan` shape

Make result hints reusable, additive, and small.

- In `packages/core/src/report/types.ts`:
  - Add `export interface NextActionTool { name: string; input: Record<string, unknown>; }`.
  - Add `export interface NextActionHint { label: string; tool: NextActionTool; why: string; }`.
  - Change `NextActionPlan.tool?: { name: string; input: Record<string, unknown>; }` to `tool?: NextActionTool` only as a type refactor; the runtime JSON shape must stay identical.
- In `packages/core/src/report/shared.ts`:
  - Add `export function nextActionHint(plan: NextActionPlan, why: string): NextActionHint[]`.
  - Implementation must return `[]` when `plan.tool` is absent; otherwise return exactly `[{ label: plan.label, tool: plan.tool, why }]`.
  - Keep existing `transitionTool(input: TransitionInput)` behavior and returned JSON unchanged.
- In `packages/core/src/report/index.ts`, export `NextActionHint`, `NextActionTool`, and `nextActionHint`.

Failure handling: if a computed `NextActionPlan` has no executable `tool`, emit no `next_actions` entry rather than inventing one.

### 3. Add next-action hints to `omr_transition` and `omr_validate` success details

Surface R3 guidance in the tools agents already call, without changing existing state payload fields.

- In `packages/extension/src/tools/register/transition-tools.ts`:
  - Import `nextActionPlan` and `nextActionHint` from `@oh-my-roadmap/core/report/index`.
  - After `const state = await transition(ctx.cwd, input)`, call `const next = await nextActionPlan(ctx.cwd)`.
  - Return text `Transition applied: ${input.operation}.` when no hint exists.
  - When a hint exists, return text `Transition applied: ${input.operation}. Next action: ${hint.label}.`.
  - Return details as a shallow object that preserves every current top-level `LoadedState` field and adds `next_actions`: `return textResult(text, {...state, next_actions})`.
  - Do not wrap the state under a new `state` key; existing tests and callers must still find `details.roadmap`, `details.milestone`, `details.changeRequest`, etc.
- In `packages/extension/src/tools/register/report-tools.ts` for `omr_validate`:
  - After `validateRoadmapState(ctx.cwd)`, call `nextActionPlan(ctx.cwd)` and build hints with `nextActionHint(next, 'Roadmap validation completed; this is the next executable workflow action.')`.
  - Keep existing text summary and error lines unchanged, appending `\nNext action: ${hint.label}.` only when a hint exists.
  - Return details as `{...result, next_actions}`.

Failure handling: if `nextActionPlan(ctx.cwd)` itself throws while the primary tool succeeded, do not fail the primary tool. Catch that secondary failure and use `next_actions: []` with the original text.

### 4. Add explicit completed-wave next-action hints without advancing state

Implement the selected R5 option: **next-action hint only**.

- In `packages/core/src/wave-orchestration/types.ts`:
  - Import `type {NextActionHint}` from `../report/index`.
  - Add optional `next_actions?: NextActionHint[]` to `PrepareWaveDispatchResult` and `RecordWaveReviewResult`.
- In `packages/core/src/wave-orchestration/review.ts`:
  - In the `input.status === 'passed'` branch of `recordWaveReview`, keep the existing behavior: mark the active wave `complete`, call `setProgress(cwd, ctx, 'ready_for_next_wave', [])`, and keep `active_wave_id` on the completed wave.
  - After setting progress, compute `next_actions` from `ctx.plan.waves` and `ctx.activeWave.id`:
    - If a later wave exists with `status !== 'complete'`, return one hint:
      - `label`: `Advance to next wave`
      - `tool`: `{ name: 'omr_transition', input: { operation: 'update_implementation_progress', progress: { activeWaveId: nextWave.id, step: 'not_started', activeTaskIds: [] } } }`
      - `why`: `Wave ${ctx.activeWave.id} passed review and progress is ready_for_next_wave; ${nextWave.id} is the next pending wave.`
    - If no later incomplete wave exists, return one hint:
      - `label`: `Mark closeout ready`
      - `tool`: `{ name: 'omr_transition', input: { operation: 'update_implementation_progress', progress: { step: 'closeout_ready', activeTaskIds: [] } } }`
      - `why`: `Wave ${ctx.activeWave.id} passed review and all waves are complete.`
    - If the current active wave cannot be found in `ctx.plan.waves`, return no hint and leave existing result fields unchanged.
  - Include `next_actions` in the returned `RecordWaveReviewResult` only on the passed path.
  - Do not add `omr_advance_wave` and do not auto-advance from inside `recordWaveReview`.

Failure handling: if the next wave is already `running`, `reviewing`, or `blocked`, do not emit an update-progress hint to it. Return no `next_actions`; existing blockers/progress state remains authoritative.

### 5. Add deterministic error guidance for `omr_prepare_wave_dispatch`

Make the two observed dispatch-order mistakes self-correcting: dispatch before implementation opens, and dispatch while the active wave is already complete.

- In `packages/extension/src/tools/register/wave-tools.ts`:
  - Import `nextActionPlan` and `nextActionHint` from `@oh-my-roadmap/core/report/index`.
  - Add a small local async helper, for example `async function appendNextActionToError(cwd: string, error: unknown, why: string): Promise<Error>`.
  - The helper must:
    - Preserve the original error message first.
    - Call `nextActionPlan(cwd)` and `nextActionHint(plan, why)`.
    - If a hint exists, return a new `Error` with message `${original}\nNext action: ${hint.label} via ${hint.tool.name} ${JSON.stringify(hint.tool.input)} — ${hint.why}`.
    - If no hint exists or computing the hint throws, return the original `Error` message unchanged.
  - Wrap only the `omr_prepare_wave_dispatch` `execute` body in `try/catch`; on catch, throw `await appendNextActionToError(ctx.cwd, error, 'Dispatch preparation failed; this is the next executable workflow action from current state.')`.
  - Do not wrap every wave tool in this batch; R5 only requires the dispatch misuse path, and broad wrapping would add untested behavior.

Expected observable behavior:

- Calling `omr_prepare_wave_dispatch` while the roadmap phase is `milestone_approved` still rejects, but the error message includes `Next action: Start implementation via omr_transition {"operation":"start_implementation"}`.
- Calling `omr_prepare_wave_dispatch` after a passed review leaves state unchanged and rejects with the existing completed-wave message plus a next action pointing to `update_implementation_progress` for the next wave.

### 6. Fix `/omr:ms-implement` first-step prompt guidance

Implement R4 in the slash-command prompt so agents do not call dispatch before opening implementation.

- In `packages/extension/src/extension/commands/prompts.ts`, inside `commandSpecificInstructions(name, transportResumeAttempts)` for `name === 'omr:ms-implement'`:
  - Insert these instructions before the existing line that starts `- Call omr_prepare_wave_dispatch before dispatching implementation work.`:
    - `- If the current roadmap phase is milestone_approved, first call omr_transition with operation start_implementation; do not call omr_prepare_wave_dispatch until implementation is legally open.`
    - `- If the active change request status is approved, first call omr_transition with operation start_implementation before dispatching change-request workers.`
    - `- If the current phase is reviewing or closeout, do not dispatch workers; follow omr_next_action and closeout next actions instead.`
  - Keep the existing “Do not write or modify code yourself” rule.
  - Keep the existing dispatch/review/rework loop text; do not rewrite the whole prompt.

Failure handling: if current state is ambiguous in the report, the prompt should tell the orchestrator to call `omr_next_action` or `omr_read_state` rather than guessing. Use existing prompt wording for `ask` only when user decisions are missing.

### 7. Tighten job-wait guidance in implementation and planning prompts

Implement R12 without changing the `job` tool or background-agent APIs.

- In `packages/extension/src/extension/commands/prompts.ts`, in `/omr:ms-implement` instructions after worker dispatch/recording guidance:
  - Add: `- After dispatching all worker or reviewer jobs for the current wave and recording their job ids, if you are blocked waiting for those jobs, issue one blocking job wait for the relevant job ids or for all running jobs with a meaningful timeout. Do not loop short job polls; retry only after an interrupt, timeout, or new liveness evidence.`
  - Add: `- Use IRC liveness checks only after a timeout/interruption or when state says a worker should exist but the job handle is absent.`
- In `packages/extension/skills/implementation-orchestrator/SKILL.md`:
  - Add the same “one blocking job wait” rule near the existing dispatch and active-run guidance.
  - Preserve the existing IRC-first recovery rules for live peers and transport failures.
- In `packages/extension/skills/milestone-planner/SKILL.md`:
  - After the wave-flow-checker dispatch instruction, add that the planner should wait once with a meaningful blocking `job` wait for the checker result, not loop short polls; use IRC only when a live checker peer already has context or after timeout.
- In `packages/extension/skills/roadmap-planner/SKILL.md`:
  - After the roadmap-milestone-checker dispatch instruction, add the same one-blocking-wait guidance.

Scope boundary: do not change worker/reviewer generated agent templates for R12 in this batch. The selected agent refresh policy is existing `omr apply`, but this batch does not require generated `.omp/agents/*.md` template changes.

### 8. Update focused tests for the selected behavior

Add or update tests that directly exercise the new guidance. Do not add transcript remeasurement or synthetic full-flow tests; the selected verification depth is focused tests.

- `test/commands.test.ts`:
  - Extend the existing `/omr:ms-implement` prompt test to assert the prompt contains `first call omr_transition with operation start_implementation`.
  - Assert that the start-implementation instruction appears before the first `omr_prepare_wave_dispatch before dispatching implementation work` occurrence.
  - Assert the prompt contains `one blocking job wait`, `Do not loop short job polls`, and `Use IRC liveness checks only after a timeout`.
- `test/state/wave-orchestration.test.ts`:
  - Extend `prepares review and records a passing review transition` to assert `recordWaveReview` returns `next_actions` with one entry whose `label` is `Advance to next wave` and whose tool input is `{operation: 'update_implementation_progress', progress: {activeWaveId: 'w02', step: 'not_started', activeTaskIds: []}}`.
  - Keep existing assertions that progress remains `{active_wave_id: 'w01', step: 'ready_for_next_wave'}`; this proves there is no auto-advance.
  - Add one focused single-wave variant or modify a local fixture to prove a passed final wave returns `Mark closeout ready` with `progress: {step: 'closeout_ready', activeTaskIds: []}` while still not mutating state to closeout-ready automatically.
- `test/tools/action-tools.test.ts`:
  - Add a test using registered `omr_prepare_wave_dispatch` before `start_implementation` on an approved milestone. Expect rejection text to include the original implementation-gate failure and `Next action: Start implementation via omr_transition`.
  - Add a test that completes/reviews wave `w01`, then calls registered `omr_prepare_wave_dispatch` while `active_wave_id` is still `w01`; expect rejection text to include `Active wave w01 is already complete` and `update_implementation_progress` for `w02`.
- `test/tools/roadmap-tools.test.ts` or `test/state/tool-friction-improvements.test.ts`:
  - Add one `omr_transition` tool success assertion where the next executable action has a tool, such as approving a roadmap and expecting `details.next_actions[0].tool.input.operation === 'start_milestone_planning'`.
  - Add one `omr_validate` tool assertion on the same valid state if convenient: validation details include `next_actions` when the next executable action is safe.

Do not update tests for R1/R2/R6/R7/R8/R9/R10/R11/R13/R14/R15 in this batch.

## Critical files & anchors

- `USAGE-FINDINGS.md` — insert the targeting table under `## Recommendations`; this satisfies the user's requested post-selection marking.
- `packages/extension/src/extension/commands/prompts.ts` — `commandSpecificInstructions()` branch for `omr:ms-implement`; this owns R4 and the slash-command side of R12.
- `packages/core/src/report/types.ts` and `packages/core/src/report/shared.ts` — add the small shared next-action hint type/helper used by tool results.
- `packages/core/src/wave-orchestration/review.ts` — `recordWaveReview()` passed branch; this owns the R5 next-action hint while preserving no-auto-advance behavior.
- `packages/extension/src/tools/register/wave-tools.ts` — `omr_prepare_wave_dispatch` registration; this owns deterministic error guidance for dispatch misuse.

## Verification

Run from the repository root.

1. Typecheck the touched TypeScript:

```sh
bun run check
```

Expected result: exits 0 with no TypeScript errors.

2. Run focused prompt/tool/state tests:

```sh
bun test test/commands.test.ts test/state/wave-orchestration.test.ts test/tools/action-tools.test.ts test/tools/roadmap-tools.test.ts test/state/tool-friction-improvements.test.ts
```

Expected result: all tests pass.

3. New behavior checks covered by the focused tests:

- `/omr:ms-implement` prompt contains the `start_implementation` instruction before dispatch guidance.
- `recordWaveReview()` after wave `w01` pass returns a `next_actions` hint to advance to `w02` but leaves persisted progress at `active_wave_id: 'w01'` and `step: 'ready_for_next_wave'`.
- `omr_prepare_wave_dispatch` before implementation opens rejects with the original gate error plus a deterministic `Start implementation` next action.
- `omr_prepare_wave_dispatch` on a completed active wave rejects with the original completed-wave error plus a deterministic `update_implementation_progress` next action.
- `omr_transition` and `omr_validate` success details include additive `next_actions` only when the next action has an executable tool.

Do not run transcript-index remeasurement for this batch; the user selected focused tests.

## Assumptions & contingencies

- Selected batch is **A — Reliability-first orchestration**. Do not implement unselected recommendations in this execution: R1/R2/R6/R7/R8/R9/R10/R11/R13/R14/R15 stay deferred in `USAGE-FINDINGS.md`.
- R5 choice is **next-action hint only**. Do not add `omr_advance_wave`, and do not make `recordWaveReview` auto-advance waves.
- Breaking-change policy is **break only with migrate**. This plan is additive; if implementation reveals a required breaking change, add `omr migrate` instead of silently changing behavior. The migrate command should be a Commander subcommand in `packages/cli/src/index.ts` and should call a core helper that performs only the required compatibility rewrite. If no breaking rewrite is required, do not add `omr migrate` in this batch.
- R1 default choice was **default stays state**, but R1 is not selected for this batch. Do not add `returnScope` or compact transition receipts here.
- R7 strict-union preference was recorded for a future schema batch, but R7 is not selected here. Do not change `omr_transition` input strictness in this batch.
- Existing generated project agents should be refreshed through `omr apply` for prompt-template batches. This batch changes extension command/skill guidance only and should not require generated agent regeneration.
