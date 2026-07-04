## Context

Implement every recommendation still deferred after Batch A in `USAGE-FINDINGS.md`: R1, R2, R6, R7, R8, R9, R10, R11, R13, R14, and R15. Batch A already implemented R3, R4, R5, and R12; do not rework those behaviors except where the new receipt/schema/scope work must integrate with their `next_actions` fields. The intended end state is lower default mutation-result bloat, narrower state/checker context, closeout by item IDs rather than exact long text, strict operation-specific transition inputs, plan-derived worker/reviewer manifests, staged context search modes, earlier style-rule access, better shell/search failure guidance, and reusable persisted scout findings.

Compatibility policy: **break only with migrate**, but this batch intentionally treats R7 rejection of irrelevant operation fields as invalid-payload tightening rather than a persisted-data break. Persisted `.omr` state must remain readable without migration. `omr_transition` default output changes to a compact receipt; callers that still need the old full loaded state must pass `returnScope: "state"`.

## Approach

### 1. Update the findings status table for the remaining batch

Edit `USAGE-FINDINGS.md` under `## Recommendations` so the status table reflects the new implementation batch.

Replace the existing status rows with this exact table:

| Recommendation | Status for this implementation | Batch | Notes |
| --- | --- | --- | --- |
| R1 | Targeted | B — Remaining usage recommendations | Default `omr_transition` to compact receipts with full state available by explicit `returnScope: "state"`. |
| R2 | Targeted | B — Remaining usage recommendations | Add narrow `omr_read_state` scopes, including checker package scopes. |
| R3 | Completed | A — Reliability-first orchestration | Already implemented in Batch A; keep existing next-action hints. |
| R4 | Completed | A — Reliability-first orchestration | Already implemented in Batch A; keep `/omr:ms-implement` first-step guidance. |
| R5 | Completed | A — Reliability-first orchestration | Already implemented in Batch A; keep explicit wave advancement hints and no auto-advance. |
| R6 | Targeted | B — Remaining usage recommendations | Add closeout preparation with ordinal item IDs and ID-based closeout recording. |
| R7 | Targeted | B — Remaining usage recommendations | Replace broad transition input with strict operation-specific schema/type. |
| R8 | Targeted | B — Remaining usage recommendations | Add plan-derived manifests to worker/reviewer packages and prompts. |
| R9 | Targeted | B — Remaining usage recommendations | Add plan-derived verification hints; do not probe the environment. |
| R10 | Targeted | B — Remaining usage recommendations | Add context search result modes and prompt rules for staged search. |
| R11 | Targeted | B — Remaining usage recommendations | Use new checker package state scopes instead of full roadmap/plan reads. |
| R12 | Completed | A — Reliability-first orchestration | Already implemented in Batch A; keep one-blocking-wait guidance. |
| R13 | Targeted | B — Remaining usage recommendations | Broaden `omr_style_guide` guidance before throwaway code or edits. |
| R14 | Targeted | B — Remaining usage recommendations | Add prompt guidance for search tool use and structured PASS/FAIL verification output. |
| R15 | Targeted | B — Remaining usage recommendations | Add roadmap-scoped persisted scout findings and reuse prompts. |

Do not edit recommendation bodies except where a test forces wording that contradicts the new table.

### 2. Add strict transition input types and schemas while preserving valid callers

Implement R7 first because R1 receipts and R6 closeout input depend on the final transition contract.

Core type changes:

- In `packages/core/src/store/contract.ts`, replace broad `TransitionInput` with a discriminated union keyed by `operation`.
- Keep the operation string literals unchanged.
- Add `export type TransitionReturnScope = 'receipt' | 'state';`.
- Every operation variant must allow optional `returnScope?: TransitionReturnScope`; the store ignores it, and the extension tool consumes it.
- Define a shared base `type TransitionBase<Operation extends string> = { operation: Operation; returnScope?: TransitionReturnScope }` or equivalent.
- Define exact variants:
  - `record_discovery`: `operation`, optional `discovery` with the existing `Partial<RoadmapState['discovery']>` shape.
  - `approve_roadmap`: `operation`, optional `approver`, optional `summary`.
  - `reopen_roadmap`: `operation`, required `reason`.
  - `record_roadmap_milestone_check`: `operation`, required `roadmapMilestoneCheck`.
  - `start_milestone_planning`: `operation` only besides `returnScope`.
  - `create_milestone_plan`: `operation`, required `milestone`.
  - `approve_milestone`: `operation`, optional `approver`, optional `summary`.
  - `update_milestone_plan`: `operation`, required `milestone`.
  - `start_implementation`: `operation` only besides `returnScope`.
  - `start_reviewing`: `operation` only besides `returnScope`.
  - `start_closeout`: `operation` only besides `returnScope`.
  - `complete_milestone`: `operation` only besides `returnScope`.
  - `request_bypass`: `operation`, required `reason`, optional `approver`.
  - `clear_bypass`: `operation` only besides `returnScope`.
  - `approve_change`: `operation`, optional `approver`, optional `summary`.
  - `update_change_request_plan`: `operation`, required `changeRequest`.
  - `close_change`: `operation` only besides `returnScope`.
  - `update_task_status`: `operation`, required `taskId`, required `taskStatus`.
  - `update_wave_status`: `operation`, required `waveId`, required `waveStatus`.
  - `update_implementation_progress`: `operation`, required `progress`.
  - `record_closeout`: `operation`, required `closeout` using the new closeout input type from step 5.
  - `record_wave_flow_check`: `operation`, required `waveFlowCheck`.
- Do not keep catch-all optional fields on the union. A payload such as `{operation: 'start_milestone_planning', milestone: {...}}` is invalid and must be rejected before the core state machine runs.

Extension schema changes:

- In `packages/extension/src/tools/register/transition-tools.ts`, replace the single broad `z.object({...})` parameters schema with a strict `z.discriminatedUnion('operation', [...])` built from the existing schemas in `packages/extension/src/tools/register/shared.ts`.
- Each variant must be `.strict()` or otherwise reject unknown keys. `returnScope` is allowed on every variant with enum `['receipt', 'state']` and default handled in execute logic as `receipt`.
- Keep the existing user-visible tool name `omr_transition`; do not add a legacy transition tool.
- Treat strict rejection of irrelevant fields as invalid-payload tightening. Do not add `omr migrate` for this schema change because no persisted `.omr` data changes and valid operation payloads keep working.

Failure handling:

- Zod/parameter validation should name the unexpected field and operation. If the extension schema cannot emit a focused operation-specific message, add a lightweight pre-parse guard in `transition-tools.ts` that detects irrelevant top-level fields for the selected operation and throws `Operation <operation> does not accept field <field>.` before normal schema validation.
- Do not change core phase guards in `packages/core/src/store/plans.ts`; they still own legal state-machine sequencing.

### 3. Implement core transition receipts and make receipt the default tool result

Implement R1 through core receipt plumbing plus extension result selection.

Core additions:

- In `packages/core/src/store/contract.ts`, add:
  - `export interface TransitionReceipt { operation: TransitionInput['operation']; event_id: string; event_type: string; summary: string; scope: RoadmapEventScope; before?: Record<string, unknown>; after?: Record<string, unknown>; }`
  - `export interface TransitionResult { state: LoadedState; receipt: TransitionReceipt; }`
- Import `RoadmapEventScope` and `LoadedState` types as needed without creating runtime cycles.
- In `packages/core/src/store/events.ts`, add `export function receiptFromEvent(event: RoadmapEvent): TransitionReceipt` returning exactly:
  - `operation: event.operation ?? ''` cast or narrowed to `TransitionInput['operation']` only for transition events,
  - `event_id: event.id`,
  - `event_type: event.type`,
  - `summary: event.summary`,
  - `scope: event.scope`,
  - `before: event.before` only when present,
  - `after: event.after` only when present.
- In `packages/core/src/store/plans.ts`:
  - Add `transitionWithReceipt(cwd: string, input: TransitionInput): Promise<TransitionResult>`.
  - Refactor `transitionImpl()` so the branch that currently calls `appendTransitionEvent(...)` captures the returned event, builds `receiptFromEvent(event)`, and returns `{state: after, receipt}`.
  - Preserve existing `transition(cwd, input): Promise<LoadedState>` as a compatibility wrapper that calls `transitionWithReceipt(cwd, input)` and returns `.state`.
  - For the ad-hoc status branch at `transitionImpl()` lines 231-233, return a receipt with `operation`, `event_id: ''`, `event_type: 'adhoc.transition'`, `summary: 'Applied <operation>.'`, `scope: {roadmap_id: loaded.adhoc.adhoc_id, milestone_id: loaded.adhoc.adhoc_id}`, `before`/`after` snapshots from `loadedSnapshot` or equivalent. This branch currently does not append roadmap events; do not add event-ledger writes for ad-hoc in this batch.
- Export `transitionWithReceipt`, `TransitionReceipt`, `TransitionResult`, and `TransitionReturnScope` from `packages/core/src/store/index.ts`.

Extension result changes:

- In `packages/extension/src/tools/register/transition-tools.ts`, call `transitionWithReceipt(ctx.cwd, input)` instead of `transition(ctx.cwd, input)`.
- Continue computing `next_actions` with `nextActionPlan(ctx.cwd)` and `nextActionHint(...)` exactly as Batch A does; if this secondary computation throws, keep `next_actions: []` and do not fail the successful transition.
- If `(input.returnScope ?? 'receipt') === 'receipt'`, return details exactly `{...receipt, next_actions}`.
- If `input.returnScope === 'state'`, return details exactly `{...state, next_actions}` to preserve the old top-level full-state shape for explicit callers.
- Text output remains `Transition applied: ${input.operation}.` and appends `Next action: ${hint.label}.` when a hint exists.
- Do not include a nested `state` field in receipt mode.

Expected observable behavior:

- `omr_transition {operation: 'approve_roadmap'}` details no longer contains `roadmap`, `milestone`, or full plan fields by default.
- The same call with `returnScope: 'state'` returns the previous full loaded state shape plus `next_actions`.
- Receipt details include `operation`, `event_id`, `event_type`, `summary`, `scope`, `before`, `after`, and `next_actions`.

### 4. Add narrow `omr_read_state` scopes and route checker prompts to them

Implement R2 and R11 with additive state scopes only. Do not add dedicated checker tools.

State summary changes in `packages/core/src/state-summary.ts`:

- Extend `StateReadScope` to:
  - existing: `compact`, `roadmap`, `active_milestone`, `active_wave`, `active_change`, `usage`,
  - new: `phase`, `progress`, `quality_gates`, `milestone_outlines`, `closeout_requirements`, `roadmap_checker_package`, `wave_flow_checker_package`.
- Add small helper summaries instead of expanding `roadmapSummary()` / `planSummary()`:
  - `phaseSummary(state)` returns `{active, roadmap: {roadmap_id, title, phase, active_milestone_id, active_change_request_id}, milestone_status, change_request_status}` with missing entries omitted.
  - `progressSummary(state)` returns `{active, progress: {active_wave_id, step, active_task_ids, blocked_reason, updated_at}, active_wave: {id, status}, task_counts, wave_counts}` for the active milestone/change plan. `task_counts` and `wave_counts` are status count objects only, not full task/wave lists.
  - `qualityGateSummary(state)` returns `{active, roadmap_milestone_check: {status, checked_by, checked_at, roadmap_revision, current_roadmap_revision, stale}, wave_flow_check: {status, checked_by, checked_at, findings_count}}`.
  - `milestoneOutlinesSummary(state)` returns `{active, roadmap: {roadmap_id, title, phase}, milestones: [{id, title, status, dependencies, scope_items, risks, acceptance_items, verification_items}]}`.
  - `closeoutRequirementsSummary(state)` returns `{active, status, acceptance: [{id, item, result_status?}], verification: [{id, item, result_status?}], worker_notes_reviewed, review_summary_present, unresolved_risks}` using the ordinal ID helper from step 5.
  - `roadmapCheckerPackageSummary(state)` returns `{active, roadmap: {roadmap_id, title, phase, roadmap_revision, roadmap_content_hash, roadmap_milestone_check_status}, milestones: [...]}` where each milestone includes full outline fields `id`, `title`, `status`, `goal`, `scope`, `non_goals`, `evidence`, `dependencies`, `risks`, `acceptance_intent`, and `verification_intent`. Do not include roadmap `success_criteria`, `constraints`, `discovery`, `open_questions`, or full `roadmap_milestone_check.findings`.
  - `waveFlowCheckerPackageSummary(state)` returns `{active, plan: {roadmap_id, milestone_id, change_request_id?, title, status, acceptance_criteria, verification_commands}, tasks: [...], waves: [...], wave_flow_check}`. Task entries include `id`, `title`, `worker`, `status`, `depends_on`, `owned_files`, `owned_modules`, `shared_interfaces`, `done_criteria`, and `verification_commands`. Wave entries include `id`, `goal`, `status`, `tasks`, `exit_criteria`, and `review_checkpoint`. Do not include `implementation_notes`, `user_interview`, `decisions`, `dependency_analysis`, or context section bodies.
- Existing scopes must remain byte-for-byte compatible except where TypeScript formatting changes are unavoidable.

Tool schema changes in `packages/extension/src/tools/register/context-tools.ts`:

- Add the new scope names to the `omr_read_state` `scope` enum.
- Context section lookups must stay skipped for new scopes unless a new summary explicitly uses section refs. The new `phase`, `progress`, `quality_gates`, `milestone_outlines`, `closeout_requirements`, `roadmap_checker_package`, and `wave_flow_checker_package` scopes should not call `searchContext()` just to populate `context_sections`.

Prompt changes:

- In `packages/core/agent-templates/roadmap-milestone-checker/AGENT.md`, replace the rule that says to read active roadmap state/generated roadmap sections with: `Start with omr_read_state scope roadmap_checker_package. Use omr_search_context only if that package is missing a referenced section you need to inspect.`
- In `packages/core/agent-templates/wave-flow-checker/AGENT.md`, replace the analogous rule with: `Start with omr_read_state scope wave_flow_checker_package. Use omr_search_context only if the package references code or documentation you must inspect.`
- In `packages/extension/src/extension/commands/prompts.ts` and `packages/extension/skills/*/SKILL.md`, update orientation guidance so orchestrators use `phase` for flow control, `progress` for implementation cursor checks, `quality_gates` before approvals, and `closeout_requirements` before closeout.

### 5. Add closeout preparation and ID-based closeout recording

Implement R6 with ordinal IDs and legacy text compatibility. Persisted `CloseoutEvidence` remains text-based; IDs are accepted at input time and normalized before writing.

Core closeout helpers in `packages/core/src/closeout.ts`:

- Add `export type CloseoutItemKind = 'acceptance' | 'verification';`.
- Add `export function closeoutItemId(kind: CloseoutItemKind, index: number): string` returning exactly `${kind}:${index + 1}`. Index is zero-based input; IDs exposed to agents are one-based, e.g. `acceptance:1`, `verification:1`.
- Add `export interface CloseoutRequirement { id: string; item: string; result?: EvidenceResult; }`.
- Add `export function closeoutRequirements(acceptance: string[], verification: string[], evidence?: CloseoutEvidence): { acceptance: CloseoutRequirement[]; verification: CloseoutRequirement[] }` that maps canonical plan text to ordinal IDs and attaches the matching existing result by exact item text when present.
- Add `export interface EvidenceResultInput extends Omit<EvidenceResult, 'item'> { item?: string; itemId?: string; }`.
- Add `export interface CloseoutEvidenceInput extends Omit<CloseoutEvidence, 'acceptance_results' | 'verification_results'> { acceptance_results: EvidenceResultInput[]; verification_results: EvidenceResultInput[]; }`.
- Add `export function normalizeCloseoutEvidenceInput(input: CloseoutEvidenceInput, expectedAcceptance: string[], expectedVerification: string[]): CloseoutEvidence`:
  - For each acceptance result, if `itemId` is present, it must match `acceptance:<n>` where `n` points to an existing expected acceptance item; set persisted `item` to that canonical text.
  - For each verification result, if `itemId` is present, it must match `verification:<n>` where `n` points to an existing expected verification command; set persisted `item` to that canonical text.
  - If `item` is present and `itemId` is absent, keep legacy behavior and validate by exact text.
  - If both `item` and `itemId` are present, `item` must equal the canonical item resolved by `itemId`; otherwise throw `Closeout itemId <id> does not match item text.`
  - If neither `item` nor `itemId` is present, throw `Closeout result requires itemId or item.`
  - Unknown IDs throw `Unknown closeout itemId: <id>`.

Transition input and schema:

- In `packages/core/src/store/contract.ts`, `record_closeout` uses `CloseoutEvidenceInput`.
- In `packages/extension/src/tools/register/shared.ts`, replace `evidenceResultSchema.item` with optional `item` and optional `itemId`; add a `.refine()` or equivalent that requires at least one.
- Keep `closeoutSchema.status`, `worker_notes_reviewed`, `review_summary`, `unresolved_risks`, `closed_by`, and `closed_at` unchanged.
- In `packages/core/src/store/plans.ts` `record_closeout` branch, normalize input before constructing milestone/change evidence:
  - For active change requests, use `loaded.changeRequest.acceptance_criteria` and `loaded.changeRequest.verification_commands`.
  - For milestone closeout, use `loaded.milestone.acceptance_criteria` and `loaded.milestone.verification_commands`.
  - Write only normalized text-based `CloseoutEvidence`; do not persist `itemId`.

New read tool:

- Register `omr_prepare_closeout` in `packages/extension/src/tools/register/transition-tools.ts` or a new closeout register file imported by `packages/extension/src/tools/register.ts`.
- Tool approval is `read`.
- Parameters: optional `roadmapId`, `milestoneId`, `changeRequestId` only if existing active-target resolution helpers make those cheap; otherwise no parameters and active state only. Use the active milestone/change request by default.
- Details shape exactly:
  - `roadmap_id`, `milestone_id`, optional `change_request_id`,
  - `status`: current closeout status or `'open'`,
  - `acceptance`: array of `{id, item, result_status?}`,
  - `verification`: array of `{id, item, result_status?}`,
  - `worker_notes_reviewed`, `review_summary_present`, `unresolved_risks`,
  - `next_operation`: `'record_closeout'` when evidence is not closed, otherwise `'complete_milestone'` for milestone closeout or `'close_change'` for change closeout,
  - `example_closeout`: a minimal payload using `itemId` fields, `status: 'closed'`, all acceptance/verification statuses set to `'passed'`, `worker_notes_reviewed: true`, `review_summary: '<summary>'`, and `unresolved_risks: []`.
- Text output should be compact JSON via `JSON.stringify(details)`, matching existing context-tool style.

Next-action and prompt integration:

- In `packages/core/src/report/next-action.ts`, when phase is `closeout` and evidence is not closed, keep status `needs_input` but change the description to mention `omr_prepare_closeout` and item IDs.
- In `packages/extension/src/extension/commands/prompts.ts`, replace closeout guidance that asks agents to reproduce canonical long text with: call `omr_prepare_closeout`, fill the `example_closeout` with actual statuses/reasons, then call `omr_transition` `record_closeout`.

Failure handling:

- Legacy exact text remains accepted.
- ID-based input must be normalized before validation, so `validateCloseoutEvidence()` continues to validate persisted text and unknown legacy text exactly as before.

### 6. Add plan-derived path manifests and verification preflight hints to worker/reviewer packages

Implement R8 and R9 without filesystem probing and without new plan schema fields.

Types in `packages/core/src/wave-orchestration/types.ts`:

- Add:
  - `export interface PlanDerivedManifest { owned_files: string[]; owned_modules: string[]; shared_interfaces: string[]; dependencies: string[]; reserved_sibling_scope: string[]; relevant_existing_code: string[]; relevant_documentation: string[]; }`
  - `export interface VerificationPreflightHint { commands: string[]; cli_assumption_warnings: string[]; guidance: string[]; }`
- Add optional `manifest: PlanDerivedManifest` and `verification_preflight: VerificationPreflightHint` to worker assignment result types and `PrepareWaveReviewResult`.

Implementation in `packages/core/src/wave-orchestration/dispatch.ts`:

- Reuse `reservedSiblingScope(ctx, task)` for `reserved_sibling_scope`.
- Add `manifestForTask(ctx, task)` returning:
  - `owned_files`, `owned_modules`, `shared_interfaces`, and `dependencies` from the task,
  - `reserved_sibling_scope` from current same-wave siblings,
  - `relevant_existing_code` and `relevant_documentation` from `ctx.plan`.
- Add `verificationPreflightFor(commands: string[])` returning:
  - `commands` unchanged,
  - `cli_assumption_warnings` for commands whose first token is one of `psql`, `mysql`, `redis-cli`, `docker`, `kubectl`, `aws`, `gcloud`, `az`, or `curl`, with message `Do not assume <tool> is installed; prefer repo-native helpers or configured MCP/tools unless the plan explicitly requires this CLI.`,
  - `guidance` containing exactly `Run assigned verification when practical. If a verification command depends on an unavailable external CLI or service, stop and append a blocking note with the missing prerequisite instead of inventing a substitute.`
- Include these two objects in each returned assignment and embed the same information in `workerPrompt()` under headings `Plan-derived manifest:` and `Verification preflight:`.

Implementation in `packages/core/src/wave-orchestration/review.ts`:

- Add a review-level manifest built from all active-wave tasks:
  - `owned_files`, `owned_modules`, `shared_interfaces`, and `dependencies` are de-duplicated concatenations across active tasks,
  - `reserved_sibling_scope` is empty for reviewer packages because reviewers inspect the wave as a whole,
  - `relevant_existing_code` and `relevant_documentation` come from `ctx.plan`.
- Add review-level verification preflight from `ctx.plan.verification_commands`.
- Include both in `PrepareWaveReviewResult` and in `reviewPrompt()` under the same headings.

Prompt boundaries:

- Prompts must state that the manifest is plan-derived and not proof that paths exist.
- If a path is not in the manifest or prior tool output, agents must use `glob` or `omr_search_context` before `read`.
- If an external CLI warning appears, agents must not shell out to that CLI unless it is explicitly required by the plan or a repo-native helper is unavailable and the CLI exists.

### 7. Add context search modes and staged-search prompt rules

Implement R10 on OMR-owned context tools only. Do not attempt to change OMP built-in `grep`.

Core changes in `packages/core/src/context-types.ts` and `packages/core/src/context.ts`:

- Add `export type ContextSearchMode = 'count' | 'ids' | 'snippets' | 'bodies';`.
- Add `mode?: ContextSearchMode` to `SearchContextInput`.
- Keep default behavior as `mode: 'snippets'` to preserve current callers.
- Mode behavior:
  - `count`: return `{roadmapId?, total, returned: 0, results: []}`. Do not build snippets or bodies for returned entries.
  - `ids`: return result entries with existing required fields, `snippet: ''`, `snippetTruncated: false`, and no `body`. This avoids changing `ContextEntryResult` shape.
  - `snippets`: current behavior with snippets and optional `includeBodies` ignored unless `includeBodies` is explicitly true for backward compatibility.
  - `bodies`: equivalent to current `includeBodies: true`; body text still respects `maxBodyChars`.
- Keep `maxResults`, `snippetChars`, and `maxBodyChars` behavior. In `count` mode, `maxResults` has no effect on `total`.

Tool schema changes in `packages/extension/src/tools/register/context-tools.ts`:

- Add `mode: z.enum(['count', 'ids', 'snippets', 'bodies']).optional()` to `omr_search_context`.
- Description must mention: `Use mode=count or mode=ids before snippets/bodies for broad discovery.`

Prompt changes:

- In `packages/extension/src/extension/commands/prompts.ts`, replace generic search guidance with: broad context discovery starts with `omr_search_context mode: 'count'` or `mode: 'ids'`; expand to `snippets` or `omr_read_context` only for selected IDs.
- In worker, reviewer, roadmap-milestone-checker, and wave-flow-checker source templates, add: do not use shell search commands for code/context discovery; use dedicated search tools, start broad OMR context searches with `count`/`ids`, and read focused ranges.
- For R14, add verification guidance to worker and reviewer templates: if writing a temporary verification script or comparison command, print a clear `PASS:` or `FAIL:` line and exit non-zero only when code must be revised; treat non-zero output with actionable diagnostics as test feedback, not as an unexplained tool failure.

### 8. Broaden style-guide/rule access before throwaway code

Implement R13 using the existing `omr_style_guide` surface. Do not add a new rules tool and do not hard-code language rules beyond what the user has recorded.

Prompt/template changes:

- In `packages/core/agent-templates/worker-light/AGENT.md`, `worker/AGENT.md`, and `worker-heavy/AGENT.md`, extend the existing `omr_style_guide` rule to say: call it before editing files **or before creating throwaway verification code that targets those files/languages**.
- In `packages/core/agent-templates/reviewer/AGENT.md`, add a rule near the orientation section: before creating throwaway verification code or code-level repros, call `omr_style_guide` with the relevant task owned files from the review package or the files being inspected; follow recorded hard/style guidance where practical. If no relevant file path is known, skip the call and avoid inventing language-specific rules.
- In `packages/core/src/wave-orchestration/review.ts`, add the same instruction to `reviewPrompt()` so reviewers spawned from current code get it even before generated source templates are refreshed.
- Do not fail reviews solely for advisory style mismatches; keep the existing reviewer rule that style mismatch is at most `NON_BLOCKING:` unless correctness/ownership/acceptance is affected.

### 9. Add roadmap-scoped scout findings store and reuse prompts

Implement R15 with a new roadmap JSONL store.

Core types and paths:

- In `packages/core/src/types.ts`, add:
  - `export interface ScoutFinding { id: string; roadmap_id: string; subsystem: string; milestone_ids: string[]; source_paths: string[]; summary: string; findings: string[]; created_by: string; created_at: string; stale?: boolean; }`
- In `packages/core/src/paths.ts`, add `export function roadmapScoutFindingsPath(cwd: string, roadmapId: string): string` returning `.omr/roadmaps/<roadmapId>/scout-findings.jsonl` using existing `roadmapDir(cwd, roadmapId)`.

Core store module:

- Add `packages/core/src/store/scout-findings.ts`.
- Implement:
  - `export interface RecordScoutFindingInput { subsystem: string; milestoneIds?: string[]; sourcePaths?: string[]; summary: string; findings?: string[]; createdBy?: string; stale?: boolean; }`
  - `export interface ListScoutFindingsInput { roadmapId?: string; subsystem?: string; milestoneId?: string; sourcePath?: string; includeStale?: boolean; limit?: number; }`
  - `export interface ListScoutFindingsResult { roadmapId?: string; total: number; returned: number; findings: ScoutFinding[]; }`
  - `export async function recordScoutFinding(cwd: string, input: RecordScoutFindingInput): Promise<ScoutFinding>`.
  - `export async function listScoutFindings(cwd: string, input: ListScoutFindingsInput = {}): Promise<ListScoutFindingsResult>`.
- Use active roadmap from `loadState(cwd)` unless `input.roadmapId` is supplied for reads.
- Generate IDs as `scout_${crypto.randomUUID().slice(0, 8)}` or use the existing project ID style if a helper already exists in the touched files; do not introduce a heavyweight ID system.
- Append one JSON record per line. If the file is missing, reads return `total: 0`, `returned: 0`, `findings: []`.
- Filtering:
  - `subsystem` exact match,
  - `milestoneId` included in `milestone_ids`,
  - `sourcePath` exact match in `source_paths`,
  - omit `stale: true` unless `includeStale` is true,
  - `limit` defaults to 20 and caps returned findings after filtering.
- Export the new functions/types from `packages/core/src/store/index.ts` and `packages/core/src/index.ts` if other store APIs are exported there.

Extension tools:

- Register tools in a new `packages/extension/src/tools/register/scout-tools.ts`, imported from `packages/extension/src/tools/register.ts`.
- `omr_record_scout_finding`: approval `write`, parameters mirror `RecordScoutFindingInput`, result text `Recorded scout finding ${id} for ${subsystem}.`, details are the finding.
- `omr_list_scout_findings`: approval `read`, parameters mirror `ListScoutFindingsInput`, result text compact JSON, details are `ListScoutFindingsResult`.

Prompt integration:

- In `packages/extension/src/extension/commands/prompts.ts`, roadmap/milestone planning guidance must say: before dispatching broad scout agents for a subsystem, call `omr_list_scout_findings` filtered by subsystem and milestone when known; pass relevant prior summaries to new scouts; after a scout returns durable findings, record a compact finding with `omr_record_scout_finding`.
- In `packages/extension/skills/roadmap-planner/SKILL.md` and `milestone-planner/SKILL.md`, add the same reuse rule.
- Do not require workers/reviewers to record scout findings; this is planner/scout orchestration only.

### 10. Keep generated-agent source templates in sync only

Generated agent refresh policy is source templates only.

- Update source templates under `packages/core/agent-templates/*/AGENT.md` as described in steps 4, 7, and 8.
- Do not edit generated `.omp/agents/*.md` files in the repository or user workspace.
- Do not add runtime auto-refresh.
- Keep existing `omr apply`/`init` behavior; tests only need to prove new source template content is generated by existing project-init paths.

### 11. Wire exports and tool registration without creating new abstractions

After implementing the behavior steps, update only necessary index/registration files:

- `packages/core/src/store/index.ts`: export `transitionWithReceipt`, receipt types, closeout input/helper types if currently exported store contracts are re-exported there, and scout-finding store functions/types.
- `packages/core/src/index.ts`: export scout-finding APIs only if this file already re-exports comparable store/project APIs needed by extension or tests.
- `packages/extension/src/tools/register.ts`: import and call `registerScoutTools(ctx)` and any closeout tool register if not added to `transition-tools.ts`.
- Avoid new service layers or registries. Add small local helpers in existing files unless a new store module is explicitly named above.

## Critical files & anchors

- `packages/extension/src/tools/register/transition-tools.ts` — `registerTransitionTools()` owns strict operation schema, `returnScope`, receipt-vs-state result selection, and likely `omr_prepare_closeout` registration.
- `packages/core/src/store/plans.ts` — `transitionImpl()`, new `transitionWithReceipt()`, and `record_closeout` normalization are the core state-machine changes.
- `packages/core/src/state-summary.ts` — `StateReadScope` and `summarizeState()` own new narrow flow/checker scopes.
- `packages/core/src/context.ts` and `packages/core/src/context-types.ts` — `SearchContextInput` and `searchContext()` own count/ids/snippets/bodies modes.
- `packages/core/src/wave-orchestration/dispatch.ts` and `packages/core/src/wave-orchestration/review.ts` — worker/reviewer prompt packages own plan-derived manifests, verification hints, and reviewer style-guide guidance.

## Verification

Run from the repository root.

1. Typecheck:

```sh
bun run check
```

Expected result: exits 0 with no TypeScript errors.

2. Focused tests:

```sh
bun test test/tools/roadmap-tools.test.ts test/tools/context-tools.test.ts test/tools/action-tools.test.ts test/state/tool-friction-improvements.test.ts test/state/lifecycle.test.ts test/state/report-next-action.test.ts test/state/wave-orchestration.test.ts test/commands.test.ts test/style.test.ts test/project-init.test.ts test/event-ledger.test.ts
```

Expected result: all tests pass.

Add or update focused assertions:

- `test/tools/roadmap-tools.test.ts`:
  - `omr_transition` returns compact receipt details by default with `operation`, `event_id`, `event_type`, `summary`, `scope`, `before`, `after`, and `next_actions`.
  - Default receipt details do not contain top-level `roadmap`.
  - `omr_transition` with `returnScope: 'state'` returns the old top-level `roadmap` shape plus `next_actions`.
  - Strict schema rejects `{operation: 'start_milestone_planning', milestone: ...}` with a focused invalid-field message, while `{operation: 'start_milestone_planning'}` succeeds in the right phase.
- `test/tools/context-tools.test.ts`:
  - `omr_read_state` scopes `phase`, `progress`, `quality_gates`, `milestone_outlines`, `closeout_requirements`, `roadmap_checker_package`, and `wave_flow_checker_package` return only their specified payloads and do not include full roadmap discovery or full plan implementation notes.
  - `omr_search_context mode: 'count'` returns totals and no results.
  - `mode: 'ids'` returns IDs/titles/metadata with empty snippets and no bodies.
  - `mode: 'bodies'` includes bodies capped by `maxBodyChars`.
- `test/state/tool-friction-improvements.test.ts` or `test/state/lifecycle.test.ts`:
  - `omr_prepare_closeout` returns ordinal IDs `acceptance:1` and `verification:1` plus `example_closeout` using `itemId`.
  - `record_closeout` accepts `itemId` results and persists canonical text in `CloseoutEvidence`.
  - Legacy text-based closeout still succeeds.
  - Unknown IDs and mismatched `itemId`/`item` pairs reject with the specified messages.
- `test/state/report-next-action.test.ts`:
  - Closeout next action mentions `omr_prepare_closeout` when evidence is missing or recorded-but-not-closed.
- `test/state/wave-orchestration.test.ts`:
  - `prepareWaveDispatch()` assignments include `manifest` and `verification_preflight` from task/plan fields.
  - Worker prompt includes `Plan-derived manifest:` and `Verification preflight:` and warns not to assume listed paths exist.
  - `prepareWaveReview()` includes de-duplicated review manifest and verification preflight.
- `test/commands.test.ts`:
  - Slash-command prompts mention `phase`, `progress`, `quality_gates`, and `closeout_requirements` scopes where appropriate.
  - Planning prompts mention `omr_list_scout_findings` before dispatching broad scouts and `omr_record_scout_finding` after durable scout findings.
  - Search guidance says broad context discovery starts with `mode: 'count'` or `mode: 'ids'`.
  - Verification guidance says temporary checks should print `PASS:`/`FAIL:` and use non-zero exit only when code must be revised.
- `test/style.test.ts` and/or `test/project-init.test.ts`:
  - Generated worker templates include `omr_style_guide` before throwaway verification code.
  - Generated reviewer template includes `omr_style_guide` before throwaway verification code or code-level repros.
  - Existing `initProject()`/template generation still emits the updated source templates.
- New or existing scout-finding tests, preferably `test/tools/context-tools.test.ts` or a new focused `test/tools/scout-tools.test.ts` if the file stays small:
  - `omr_record_scout_finding` appends a roadmap-scoped JSONL record.
  - `omr_list_scout_findings` filters by subsystem, milestone ID, source path, stale flag, and limit.
  - Missing scout store returns an empty result rather than throwing.
- `test/event-ledger.test.ts`:
  - Transition receipts use the same event ID as the appended roadmap event for non-ad-hoc transitions.

Do not run transcript-index remeasurement, full `bun test`, or a manual OMR end-to-end scenario for this batch; the selected verification depth is focused tests plus typecheck.

## Assumptions & contingencies

- All remaining deferred recommendations are in scope in one comprehensive batch: R1/R2/R6/R7/R8/R9/R10/R11/R13/R14/R15.
- R3/R4/R5/R12 are already complete from Batch A. Keep their tests passing and integrate with their `next_actions`; do not redesign those behaviors.
- `omr_transition` default details shape intentionally changes from full loaded state to receipt. This is a public output change accepted for this batch; `returnScope: 'state'` is the explicit compatibility escape hatch.
- Strict R7 schema rejects irrelevant fields as invalid payloads. Do not add `omr migrate` for this because persisted `.omr` state is unchanged and valid operation payloads still work.
- Closeout item IDs are ordinal and one-based (`acceptance:1`, `verification:1`). If criteria reorder between `omr_prepare_closeout` and `record_closeout`, the ID maps to the current canonical order at record time; callers should call `omr_prepare_closeout` again after plan edits.
- Plan-derived manifests are not filesystem discovery. If a worker/reviewer needs a path not listed or doubts a listed path exists, it must use `glob`/context search before reading.
- R15 scout findings are roadmap-scoped JSONL. Do not build cross-roadmap/global scout reuse in this batch.
- Source templates only: do not edit generated `.omp/agents/*.md` artifacts and do not add runtime auto-refresh.
- If implementation reveals that the extension tool framework cannot express `z.discriminatedUnion` with the current `ExtensionAPI['zod']['z']`, use strict runtime pre-parse validation in `transition-tools.ts` while keeping the exported TypeScript `TransitionInput` discriminated union. The observable contract remains strict operation-specific rejection.
