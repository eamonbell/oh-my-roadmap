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

---

# Implementation Summary — Batch B: Remaining usage recommendations

**Scope:** Recommendations R1, R2, R6, R7, R8, R9, R10, R11, R13, R14, R15 from `USAGE-FINDINGS.md`
**Branch:** `context-opti` (uncommitted working tree)
**Compatibility policy:** break only with migrate — persisted `.omr` state stays readable without migration. R7's rejection of irrelevant operation fields is treated as invalid-payload tightening (not a persisted-data break); `omr_transition`'s default output changes to a compact receipt, with the old full-state shape available via `returnScope: 'state'`.

## Goal

Lower default mutation-result bloat and narrow the context agents load:
- Compact `omr_transition` receipts by default; full state only on request.
- Narrow state/checker read scopes instead of full roadmap/plan reads.
- Closeout by ordinal item IDs rather than exact long text.
- Strict operation-specific transition inputs.
- Plan-derived worker/reviewer manifests + verification preflight hints.
- Staged context-search modes, earlier style-rule access, better search/verification guidance, and reusable persisted scout findings.

## Changes by recommendation

### R7 — Strict operation-specific transition inputs

- **`packages/core/src/store/contract.ts`** — Replaced the broad `TransitionInput` with a `TransitionBase<Operation>` discriminated union keyed on `operation`; one strict variant per operation with exactly its required/optional fields (e.g. `reopen_roadmap` requires `reason`, `record_closeout` carries `closeout: CloseoutEvidenceInput`, `update_task_status` requires `taskId`+`taskStatus`). Added `TransitionReturnScope = 'receipt' | 'state'` and made it optional on every variant.
- **`packages/core/src/store/events.ts`** — Made `transitionEventScope`/`transitionActor`/`transitionDetails` type-safe against the union via `'field' in input` guards (behavior unchanged).
- **`packages/extension/src/tools/register/transition-tools.ts`** — Added an `OPERATION_FIELDS` map and an `assertStrictTransitionInput` pre-execute guard that throws `Operation <operation> does not accept field <field>.` for irrelevant top-level fields. (Per the spec's sanctioned contingency, the zod params schema stays permissive and strictness is enforced by the runtime guard; the exported TS `TransitionInput` remains a true strict union.)

### R1 — Compact transition receipts as the default result

- **`packages/core/src/store/contract.ts`** — Added `TransitionReceipt { operation, event_id, event_type, summary, scope, before?, after? }` and `TransitionResult { state, receipt }`.
- **`packages/core/src/store/events.ts`** — Added `receiptFromEvent(event)` (includes `before`/`after` only when present).
- **`packages/core/src/store/plans.ts`** — `transitionImpl` now returns `TransitionResult`; the main path captures the appended ledger event and builds the receipt, the ad-hoc branch returns a synthetic `adhoc.transition` receipt (`event_id: ''`). Added `transitionWithReceipt(cwd, input)`; `transition()` is now a thin wrapper returning `.state`. Threaded a pre-generated event id through create/update milestone-plan paths so those receipts carry the real ledger id.
- **`packages/core/src/store/index.ts`** — Re-exports `transitionWithReceipt`, `TransitionReceipt`, `TransitionResult`, `TransitionReturnScope`.
- **`packages/extension/src/tools/register/transition-tools.ts`** — Calls `transitionWithReceipt`; returns `{...receipt, next_actions}` by default and `{...state, next_actions}` when `returnScope: 'state'`. Text output unchanged. Batch A's `next_actions` computation is preserved and still fails soft to `[]`.

### R2 / R11 — Narrow read-state and checker-package scopes

- **`packages/core/src/state-summary.ts`** — Extended `StateReadScope` with `phase`, `progress`, `quality_gates`, `milestone_outlines`, `closeout_requirements`, `roadmap_checker_package`, `wave_flow_checker_package`, each with its own helper summary (`phaseSummary`, `progressSummary`, `qualityGateSummary`, `milestoneOutlinesSummary`, `closeoutRequirementsSummary`, `roadmapCheckerPackageSummary`, `waveFlowCheckerPackageSummary`) wired into `summarizeState()`. Existing scopes unchanged. The checker-package scopes deliberately omit heavy fields (roadmap `success_criteria`/`constraints`/`discovery`/`open_questions`, plan `implementation_notes`/`user_interview`/`decisions`/context bodies).
- **`packages/extension/src/tools/register/context-tools.ts`** — Added the seven scopes to the `omr_read_state` enum; new scopes skip `searchContext()`/`context_sections`.
- **`packages/core/agent-templates/roadmap-milestone-checker/AGENT.md`** & **`wave-flow-checker/AGENT.md`** — Now instruct starting from `omr_read_state scope roadmap_checker_package` / `wave_flow_checker_package`, using `omr_search_context` only for referenced sections/code.

### R6 — Closeout preparation + ID-based recording

- **`packages/core/src/closeout.ts`** — Added `CloseoutItemKind`, `closeoutItemId(kind, index)` → `${kind}:${index+1}` (one-based), `CloseoutRequirement`, `closeoutRequirements(...)`, `EvidenceResultInput`, `CloseoutEvidenceInput`, and `normalizeCloseoutEvidenceInput(...)` with exact errors `Unknown closeout itemId: <id>`, `Closeout itemId <id> does not match item text.`, `Closeout result requires itemId or item.`
- **`packages/core/src/store/plans.ts`** — `record_closeout` normalizes ID-based input against the active change-request/milestone acceptance+verification text before persisting text-only `CloseoutEvidence` (no `itemId` persisted). Legacy exact-text still accepted.
- **`packages/extension/src/tools/register/shared.ts`** — `evidenceResultSchema.item` now optional plus optional `itemId`, with a `.refine()` requiring at least one.
- **`packages/extension/src/tools/register/transition-tools.ts`** — New `omr_prepare_closeout` tool (approval `read`, active state): returns `{roadmap_id, milestone_id, change_request_id?, status, acceptance[], verification[], worker_notes_reviewed, review_summary_present, unresolved_risks, next_operation, example_closeout}` with ordinal IDs and an `example_closeout` using `itemId` refs.
- **`packages/core/src/report/next-action.ts`** — Closeout-phase `needs_input` description now mentions `omr_prepare_closeout` and item IDs.
- **`packages/extension/src/extension/commands/prompts.ts`** — Closeout guidance now: call `omr_prepare_closeout` → fill `example_closeout` → `omr_transition record_closeout`.

### R8 / R9 — Plan-derived manifests + verification preflight (no filesystem probing)

- **`packages/core/src/wave-orchestration/types.ts`** — Added `PlanDerivedManifest` and `VerificationPreflightHint`; optional `manifest`/`verification_preflight` on the worker assignment type and `PrepareWaveReviewResult`.
- **`packages/core/src/wave-orchestration/dispatch.ts`** — `manifestForTask(ctx, task)` (task ownership/`depends_on` + `reservedSiblingScope` + plan-derived relevant code/docs) and `verificationPreflightFor(commands)` (CLI-assumption warnings for `psql/mysql/redis-cli/docker/kubectl/aws/gcloud/az/curl` + the fixed guidance string). Embedded in `workerPrompt()` under `Plan-derived manifest:` / `Verification preflight:` with the "not proof that any listed path exists → use glob/omr_search_context before read" boundary.
- **`packages/core/src/wave-orchestration/review.ts`** — Review-level de-duplicated manifest across active-wave tasks (`reserved_sibling_scope: []`) + plan-level preflight, included in `PrepareWaveReviewResult` and `reviewPrompt()`.

### R10 / R14 — Context search modes + staged-search / verification guidance

- **`packages/core/src/context-types.ts`** — Added `ContextSearchMode = 'count' | 'ids' | 'snippets' | 'bodies'` and `mode?` on `SearchContextInput`.
- **`packages/core/src/context.ts`** — `searchContext()` mode behavior: `count` → `{roadmapId?, total, returned: 0, results: []}` (no snippet/body work); `ids` → entries with `snippet: ''`, `snippetTruncated: false`, no body; `bodies` == prior `includeBodies: true` (respects `maxBodyChars`); default stays `snippets`. `maxResults`/`snippetChars`/`maxBodyChars` semantics preserved.
- **`packages/extension/src/tools/register/context-tools.ts`** — Added `mode` enum to `omr_search_context`; description mentions `Use mode=count or mode=ids before snippets/bodies for broad discovery.`
- **`prompts.ts` + worker/reviewer/checker templates** — Staged-search rule (start broad OMR searches with `count`/`ids`, expand for selected IDs; no shell search for code/context discovery). R14: temporary verification scripts print `PASS:`/`FAIL:` and exit non-zero only when code must be revised; non-zero-with-diagnostics is test feedback, not tool failure (added to worker/reviewer templates and the slash-command prompt).

### R13 — Earlier style-rule access

- **`packages/core/agent-templates/worker*/AGENT.md`** — Extended the `omr_style_guide` rule to cover throwaway verification code targeting those files/languages, not just edits.
- **`packages/core/agent-templates/reviewer/AGENT.md`** & **`wave-orchestration/review.ts` `reviewPrompt()`** — Call `omr_style_guide` with relevant owned files before throwaway verification code / code-level repros; skip if no relevant path; don't invent language rules. Style mismatch remains at most non-blocking.

### R15 — Roadmap-scoped scout findings

- **`packages/core/src/types.ts`** — Added `ScoutFinding` interface.
- **`packages/core/src/paths.ts`** — `roadmapScoutFindingsPath(cwd, roadmapId)` → `.omr/roadmaps/<roadmapId>/scout-findings.jsonl`.
- **`packages/core/src/store/scout-findings.ts`** (new) — `recordScoutFinding`/`listScoutFindings` (append one JSON line; filter by subsystem/milestoneId/sourcePath/stale; `limit` defaults 20 caps after filtering; missing file → empty result; IDs `scout_<uuid8>`; active roadmap via `loadState` unless `roadmapId` given). Re-exported from `store/index.ts`.
- **`packages/extension/src/tools/register/scout-tools.ts`** (new) — `omr_record_scout_finding` (approval `write`) and `omr_list_scout_findings` (approval `read`); registered from `register.ts`.
- **`prompts.ts` + `roadmap-planner`/`milestone-planner` SKILL.md** — List prior findings by subsystem/milestone before dispatching broad scouts; record durable findings after.

### Findings table (step 1)

- **`USAGE-FINDINGS.md`** — Status table updated to mark R1/R2/R6/R7/R8/R9/R10/R11/R13/R14/R15 as Targeted (Batch B) and R3/R4/R5/R12 as Completed (Batch A). Recommendation bodies untouched.

## Tests

- **`test/tools/roadmap-tools.test.ts`** — Compact receipt default (`operation`/`event_id`/`event_type`/`summary`/`scope`/`before`/`after`/`next_actions`, no top-level `roadmap`); `returnScope: 'state'` restores the full shape; strict-schema rejection of `{operation:'start_milestone_planning', milestone:…}` + success for the bare payload.
- **`test/tools/context-tools.test.ts`** — Each new read-state scope returns only its own payload; search modes `count`/`ids`/`bodies`.
- **`test/tools/scout-tools.test.ts`** (new) — Record appends roadmap-scoped JSONL; list filters by subsystem/milestone/sourcePath/stale/limit; missing store → empty.
- **`test/state/tool-friction-improvements.test.ts`** — `omr_prepare_closeout` ordinal IDs + `example_closeout(itemId)`; `record_closeout` via `itemId` persists canonical text; legacy text still succeeds; unknown-ID and mismatched itemId/item rejections.
- **`test/state/report-next-action.test.ts`** — Closeout next action mentions `omr_prepare_closeout` for missing and recorded-but-not-closed evidence.
- **`test/state/wave-orchestration.test.ts`** — Dispatch assignments carry `manifest` + `verification_preflight`; worker prompt headings + not-proof warning; review de-duplicated manifest + preflight.
- **`test/commands.test.ts`** — Prompts mention the new scopes, scout list-before/record-after, `mode:'count'`/`'ids'` staged search, and PASS/FAIL verification guidance.
- **`test/project-init.test.ts`** — Generated worker/reviewer templates include `omr_style_guide` before throwaway verification code; checker template mentions `roadmap_checker_package`.
- **`test/event-ledger.test.ts`** — Transition receipt `event_id` equals the appended roadmap event id for non-ad-hoc transitions.
- **`test/state/lifecycle.test.ts`** — Reopen-without-reason rejection reworked as a clean assertion of the strict runtime guard.

## Verification

```
bun run check   # tsc --noEmit → exit 0, no errors
bun test test/tools/roadmap-tools.test.ts test/tools/context-tools.test.ts \
  test/tools/action-tools.test.ts test/state/tool-friction-improvements.test.ts \
  test/state/lifecycle.test.ts test/state/report-next-action.test.ts \
  test/state/wave-orchestration.test.ts test/commands.test.ts test/style.test.ts \
  test/project-init.test.ts test/event-ledger.test.ts test/tools/scout-tools.test.ts
# → 141 pass, 0 fail, 1069 expect() calls across 12 files
```

Per the spec's chosen depth, full `bun test`, transcript-index remeasurement, and manual end-to-end were **not** run.

## Notes

- `omr_transition` default details intentionally change from full loaded state to a receipt; `returnScope: 'state'` is the compatibility escape hatch. No `omr migrate` — persisted `.omr` data is unchanged.
- Closeout item IDs are ordinal/one-based and map to canonical order at record time; callers should re-run `omr_prepare_closeout` after plan edits.
- Plan-derived manifests are not filesystem discovery; agents must glob/context-search before reading unlisted or doubted paths.
- Source templates only — generated `.omp/agents/*.md` artifacts were not edited and no runtime auto-refresh was added.
- One source touch beyond the per-recommendation scope: a PASS/FAIL R14 guidance bullet was added to `prompts.ts` (it existed in templates but the `commands.test.ts` assertion required it in the slash-command prompt too).
- Remaining non-blocking TypeScript hints in touched test files (a few unused imports and redundant `await`s) do not affect `bun run check` (exit 0) or the suite; left as-is.
