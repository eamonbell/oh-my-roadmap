# Usage Transcript Findings: Context Bloat And Tool-Flow Reliability

Date: 2026-07-04

## Grounding

`oh-my-roadmap` is a local OMP extension for complex feature/refactor work. It drives agents through a stateful workflow of roadmap discovery, roadmap approval, milestone planning, implementation waves, review, closeout evidence, and completion. The canonical state lives in `.omr`; user-facing commands such as `/omr:rm-new`, `/omr:ms-plan`, and `/omr:ms-implement` guide agents through extension tools such as `omr_read_state`, `omr_search_context`, `omr_transition`, and the wave orchestration tools.

The provided transcripts cover a real roadmap to port an Aidea service from Gorm/SQLite to sqlx/Postgres:

- `new-roadmap`: `/omr:rm-new` created and approved the migration roadmap.
- `milestone-plan-1`: `/omr:ms-plan postgres-foundation-schema` planned the first milestone.
- `milestone-implement`: `/omr:ms-implement` implemented the first milestone through three waves.
- `milestone-plan-2`: `/omr:ms-plan` planned the next milestone after the first milestone completed.

The user-interview preferences for this analysis were:

- Optimize for higher task success and lower raw token volume.
- Recommend across tool schemas/results, agent prompts/skills, IRC orchestration, and workflow state machine.
- Keep breaking-change tolerance low.
- Write for coding agents that will plan implementations of the recommendations.
- Prefer failure-heavy paths over uniform coverage.
- Provide both strategic themes and actionable backlog items.
- Prefer hybrid guidance: deterministic tool hints first, IRC only when a live peer already has context.
- Treat raw tokens as the main bloat proxy; dollar cost is secondary.

## Methodology

Constraints followed:

- I did not fully read any `session.json` file.
- I used `session-index.md` and `session-index.json` files to identify messages, line ranges, tool names, error counts, token snapshots, and byte spans.
- I read only selected line ranges from `session.json` and sub-agent `.jsonl` files when the indexes showed a failure or representative bloated result.
- I did not modify project code. The only artifact created is this file.

Index coverage:

- 22 index files inspected.
- 45,419,143 raw transcript tokens represented across indexes.
- 1,025 tool calls represented across indexes.
- 21 indexed tool errors.

Aggregate by transcript group:

| Group | Sessions | Raw tokens | Tool calls | Errors | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `milestone-implement` | 9 | 23,649,531 | 447 | 13 | Largest contributor; contains implementation orchestration, worker, and review loops. |
| `milestone-plan-2` | 6 | 11,358,077 | 300 | 4 | Heavy planning/scouting; largest single planning session after first milestone completion. |
| `milestone-plan-1` | 5 | 6,339,703 | 200 | 3 | Foundation milestone planning; several duplicated scout/checker patterns later recur. |
| `new-roadmap` | 2 | 4,071,832 | 78 | 1 | Roadmap creation plus roadmap checker. |

Aggregate result bytes by tool, from index `byteEnd - byteStart` as a bloat proxy:

| Tool | Calls | Errors | Indexed result bytes | Main observation |
| --- | ---: | ---: | ---: | --- |
| `read` | 443 | 3 | 3,948,177 | Many full/raw reads and large generated artifacts. |
| `omr_transition` | 29 | 4 | 1,910,332 | Mutation receipts repeatedly returned full loaded state. |
| `grep` | 96 | 0 | 1,331,450 | Broad searches returned high-volume matches. |
| `omr_read_state` | 31 | 0 | 626,999 | “compact”/scoped reads still included large roadmap or plan data. |
| `omr_read_context` | 19 | 0 | 459,676 | Useful but sometimes too large for checker/scout needs. |
| `job` | 76 | 0 | 178,109 | Small per call, but repeated polling inflated context. |

Representative ranged reads used for evidence:

- `usage-transcripts/milestone-implement/session.json:4532-4546,8075-8089,15716-15730,19695-19709,21161-21175` for implementation sequencing/closeout errors.
- `usage-transcripts/milestone-implement/session.json:18350-18410` for `omr_transition` returning full roadmap details after `record_closeout`.
- `usage-transcripts/milestone-plan-2/session.json:15848-15910` for `omr_transition create_milestone_plan` returning full roadmap details.
- `usage-transcripts/new-roadmap/session.json:11964-11978` for roadmap milestone slug validation failure.
- `usage-transcripts/milestone-plan-1/session.json:5152-5166,7709-7726` for missing docs path and misleading partial `start_milestone_planning` input.
- `usage-transcripts/milestone-implement/sub-agents/t5-test-helper-tests.jsonl:20,40,107,119` for path/tool/test failures.
- `usage-transcripts/milestone-plan-2/sub-agents/ScoutIndexRuntime.jsonl:54,108` for guessed-path failures.
- `usage-transcripts/milestone-implement/sub-agents/wave-2-review.jsonl:82-83` for TTSR interruption after a throwaway verification program used legacy `math/rand`.

## Strategic discoveries

### 1. Mutation receipts are the biggest project-controlled bloat source

`omr_transition` returned full `LoadedState` in `details` after many mutations. The text content was small, but the serialized `details` repeated the full roadmap, success criteria, constraints, milestones, milestone plans, and closeout state.

Evidence:

- `packages/extension/src/tools/register/transition-tools.ts` returns `textResult("Transition applied: ...", state)`.
- `packages/core/src/store/plans.ts` returns the full loaded state after transitions.
- `usage-transcripts/milestone-plan-2/session-index.json` shows these single results:
  - `create_milestone_plan`: 102,060 bytes / 1,454 lines.
  - `record_wave_flow_check` failed result recording: 105,300 bytes / 1,504 lines.
  - `update_milestone_plan`: 105,352 bytes / 1,506 lines.
  - `record_wave_flow_check` passed result recording: 107,058 bytes / 1,522 lines.
  - `approve_milestone`: 107,551 bytes / 1,531 lines.
- `usage-transcripts/milestone-implement/session-index.json` shows closeout/completion transition results between 87,552 and 96,075 bytes each.
- The ranged read at `usage-transcripts/milestone-implement/session.json:18350-18410` shows `record_closeout` returned the full roadmap goal, success criteria, constraints, and milestone-check details, even though the agent only needed confirmation plus next step.

This is high-impact because the agent already has the needed context in the call it just made or can request a narrow state scope after mutation. Most mutation results should be receipts, not snapshots.

### 2. “Compact” state and checker context are still too broad

`omr_read_state` and checker/scout context calls often returned tens of kilobytes before any implementation work began.

Evidence:

- `usage-transcripts/milestone-plan-1/sub-agents/WaveFlowCheckLeafStores-index.md`:
  - `omr_read_state scope=roadmap`: 46,451 bytes.
  - `omr_read_state scope=active_milestone`: 33,005 bytes.
  - `omr_read_context` required-work/dependency sections: 27,770 bytes.
- `usage-transcripts/milestone-plan-1/sub-agents/WaveFlowRecheckLeafStores-index.md`:
  - `omr_read_state scope=compact`: 46,989 bytes.
- `usage-transcripts/new-roadmap/sub-agents/RoadmapMilestoneCheck-index.json`:
  - `omr_search_context` for milestones: 62,932 bytes.
  - Follow-up raw roadmap milestone read: 80,191 bytes.
- `packages/core/src/state-summary.ts` shows `compact` includes both `roadmapSummary` and `planSummary`; `roadmapSummary` includes full `roadmap_milestone_check`, `open_questions`, `bypass`, and `discovery`, while `planSummary` includes all task summaries, owned files/modules, verification commands, and `wave_flow_check`.

The current scopes are useful but not narrow enough for repeated orientation. Agents need tiny “phase/header/next-action” views for flow control and dedicated structured sections for checkers.

### 3. Agents repeatedly polled jobs instead of blocking once

Repeated `job` calls contributed less result volume than `read`/`omr_transition`, but they added avoidable turns and context churn.

Evidence:

- `milestone-implement/session-index.json`: 39 `job` calls, including repeated loops:
  - `Re-polling wave-1 workers` 6 times.
  - `Re-polling wave-2 reviewer` 6 times.
  - `Re-polling wave-3 worker` 6 times.
  - `Re-polling t3-ddl-runner` 5 times.
- `milestone-plan-1/session-index.json`: 13 `job` calls, including 7 waits for the first wave-flow checker and 5 waits for the revised checker.
- `milestone-plan-2/session-index.json`: 19 `job` calls, including 6 waits for wave check and 5 waits for recheck.
- `new-roadmap/session-index.json`: 5 waits for checker.

This is mostly prompt/tool-use discipline. The orchestrator should wait on the relevant job(s) with a sufficiently long window and only check IRC/liveness when there is evidence of failure or timeout.

### 4. Broad code search/read patterns produced high-volume results that were not always needed

The agents often used wide regex searches and full/raw reads when a count, file list, or tighter selector would have answered the local question.

Evidence:

- `new-roadmap/session-index.json`:
  - `grep Finding preload associations`: 142 matches in 20 files, 48,282 bytes.
  - `grep Listing store methods`: 98 matches in 18 files, 52,004 bytes.
- `milestone-plan-1/sub-agents/ScoutStoreBoundary-index.json` and `milestone-plan-2/sub-agents/ScoutStoreBoundary-index.json` each include:
  - 13 repeated `grep` calls with missing/`None` intents.
  - A 90,365-byte grep result with 92 matches in 20 files.
  - A 46,523-byte grep result with 51 matches in 20 files.
- `milestone-plan-2/sub-agents/ScoutIndexRuntime-index.json`:
  - `grep Find artifact persistence path`: 160 matches in 20 files, 66,764 bytes.
  - `grep Find context index handler routes`: 123 matches in 16 files, 49,476 bytes.
- `milestone-implement/sub-agents/t3-ddl-runner-index.json`:
  - Many raw model/source reads; the task reached 5,698,478 raw tokens with only one indexed error.

Some broad scans were justified by migration scope. The bloat issue is that tools and prompts did not nudge agents to start with counts/file paths/symbol summaries and expand only selected sections.

### 5. Several failed calls were preventable with deterministic next-action hints

The highest-value failures were not model capability failures; they were workflow sequencing or tool-contract ambiguity.

Evidence:

- `/omr:ms-implement` tried `omr_prepare_wave_dispatch` before opening implementation:
  - Error: `Implementation gate is closed... current phase is milestone_approved`.
  - The agent then called `omr_transition start_implementation` and succeeded.
- After wave 1 review, `/omr:ms-implement` tried `omr_prepare_wave_dispatch` while the persisted active wave was still `wave-1` and complete:
  - Error: `Active wave wave-1 is already complete`.
  - The agent then manually called `update_implementation_progress` to wave 2.
- Closeout flow had three preventable errors:
  - Tried `record_closeout` while still `implementing`; this error did include a useful hint to call `start_reviewing` then `start_closeout`.
  - Tried `complete_milestone` while closeout evidence status was not closed.
  - Tried `complete_milestone` with closeout evidence missing a canonical acceptance criterion text.
- `/omr:ms-plan` in `milestone-plan-1` called `start_milestone_planning` with a partial `milestone` object. Zod validation complained that `verificationCommands`, `acceptanceCriteria`, `tasks`, and `waves` were missing. The operation itself does not need a milestone object; the schema allowed the optional object but did not discriminate by operation.
- `/omr:rm-new` failed once because a milestone id was not a lower-case slug.

These are ideal for tool-returned `next_actions`, operation-specific schemas, and command prompts that mirror the real state machine.

### 6. Path and environment guesses caused avoidable errors

The agents sometimes guessed paths or CLI availability rather than deriving them from repo discovery or tool-provided context.

Evidence:

- `milestone-plan-1/session.json:5152-5166`: `backend-specs/docs` not found; user later clarified the absolute backend-specs path.
- `milestone-plan-2/session.json:9002-9016`: guessed `mdl/core.go` not found.
- `ScoutIndexRuntime.jsonl:54`: guessed `storetest/workflow_test.go` not found.
- `ScoutIndexRuntime.jsonl:108`: guessed `store/qry` not found.
- `ScoutProviderMCP` in both plan sessions guessed `storetest` and got `Path not found`.
- `t5-test-helper-tests.jsonl:40`: `psql` command not found.

The consequence is not just failed calls. The recovery path adds more discovery/search/read calls and pollutes context with irrelevant error payloads.

### 7. TTSR/rule interruptions can be shifted earlier

`wave-2-review` attempted to write a throwaway Go verification program that triggered the `go-rand-v2` rule because it used legacy `math/rand`. The write was aborted, then a system rule was injected.

This prevented a bad write, but it happened after the model spent context constructing a throwaway program. Worker/reviewer prompts should include known project language rules or require checking style/rules before generating ad-hoc verification code.

## Discoveries by session

| Session | Tokens / calls / errors | Discoveries |
| --- | ---: | --- |
| `new-roadmap/session` | 3,840,495 / 72 / 1 | Broad discovery produced large grep/read results before roadmap creation. `grep` outputs for preload associations and store methods were 48KB and 52KB. Roadmap creation failed once on milestone id slug validation, then succeeded. Checker waiting used 5 `job` polls. |
| `new-roadmap/sub-agents/RoadmapMilestoneCheck` | 231,337 / 6 / 0 | The checker used both `omr_search_context` for milestones (62.9KB) and a full roadmap milestone-section read (80.2KB). A dedicated structured milestone-outline scope would likely remove the second read. |
| `milestone-plan-1/session` | 3,911,024 / 72 / 2 | Missing `backend-specs/docs` path caused recovery discovery. `start_milestone_planning` was called with a partial milestone object and failed schema validation. Transition results for create/update/approve/record-check were 62KB-69KB each. Wave-flow checker waiting repeated 12 times across initial and revised checks. |
| `milestone-plan-1/sub-agents/ScoutProviderMCP` | 503,034 / 50 / 1 | Read the full roadmap context (79KB), read large migration/schema/test sections, and guessed missing `storetest`. Similar/duplicated pattern appears in `milestone-plan-2`. |
| `milestone-plan-1/sub-agents/ScoutStoreBoundary` | 1,173,601 / 51 / 0 | Heavy broad grep/read scouting. A 90KB grep result and 46KB grep result dominated. Index shows 13 `grep` calls with missing `intent` values, reducing debuggability. |
| `milestone-plan-1/sub-agents/WaveFlowCheckLeafStores` | 512,059 / 18 / 0 | Wave checker needed large `omr_read_state` and `omr_read_context` payloads for plan validation. The active roadmap state alone was 46KB. |
| `milestone-plan-1/sub-agents/WaveFlowRecheckLeafStores` | 239,985 / 9 / 0 | Recheck was cleaner but still read a 47KB “compact roadmap overview” and a 33KB active roadmap state. |
| `milestone-implement/session` | 7,997,138 / 100 / 6 | Largest main session. Failed first dispatch because implementation was not opened. Failed next-wave dispatch because active wave remained complete. Closeout sequencing caused three more transition errors. 39 `job` calls were used. Transition results around closeout/completion were 87KB-96KB each. |
| `milestone-implement/sub-agents/t1-deps-open` | 1,274,430 / 32 / 0 | Clean run with no indexed errors. Context volume is moderate for a dependency-opening task; no single result crossed the 20KB threshold in the index summary. |
| `milestone-implement/sub-agents/t2-db-tags` | 1,551,682 / 47 / 0 | Clean run but large edit/grep payloads: `edit Add db tags to workflow.go structs` was 42KB; `grep Find json-tagged fields lacking db tag` returned 162 matches in 17 files and 36.7KB. |
| `milestone-implement/sub-agents/t3-ddl-runner` | 5,698,478 / 79 / 1 | Very high volume. Read many raw model files and dependency sources; created multiple temp verification programs; ran full real-Postgres verification three times. One bash search failed with no output. Good candidate for stronger verification scaffolding guidance and search-tool discipline. |
| `milestone-implement/sub-agents/t4-sentinels` | 464,657 / 20 / 0 | Clean, relatively compact worker. No major bloat or failure pattern found from index. |
| `milestone-implement/sub-agents/t5-test-helper-tests` | 3,477,774 / 59 / 4 | Path guess `store/storetest` failed; `psql` was unavailable; test/build commands surfaced compile and FK expectation failures. Large DDL reads occurred. A preflight environment hint and path manifest would have avoided two failures. |
| `milestone-implement/sub-agents/wave-1-review` | 396,458 / 27 / 0 | Clean review. Largest notable result was a 34KB read of `workflow.go` struct bodies. |
| `milestone-implement/sub-agents/wave-2-review` | 1,922,528 / 51 / 1 | Review read the full migration SQL, SQLite dump, and model details. A throwaway Go verification program write was aborted by `go-rand-v2` TTSR. Rule/style guidance should be available before ad-hoc code generation. |
| `milestone-implement/sub-agents/wave-3-review` | 866,386 / 32 / 1 | Bash cross-check returned a non-zero result with useful output; index treated it as an error. Better command design or result interpretation guidance would reduce false failure churn. |
| `milestone-plan-2/session` | 7,613,017 / 110 / 1 | Largest planning session. One guessed file (`mdl/core.go`) failed. Main bloat was `omr_transition` receipts: five plan/check/approval mutation results between 102KB and 108KB each. Waiting for check/recheck used 11 repeated `job` calls. |
| `milestone-plan-2/sub-agents/ScoutIndexRuntime` | 1,316,381 / 62 / 2 | Heavy runtime scout. Failed guessed paths `storetest/workflow_test.go` and `store/qry`. Large broad greps: 160 matches/66.8KB and 123 matches/49.5KB. |
| `milestone-plan-2/sub-agents/ScoutProviderMCP` | 503,034 / 50 / 1 | Same pattern as plan 1: full roadmap context read, large schema/test reads, missing `storetest` guess. |
| `milestone-plan-2/sub-agents/ScoutStoreBoundary` | 1,173,601 / 51 / 0 | Same as plan 1 boundary scout: high-volume broad greps and repeated missing-intent grep calls. |
| `milestone-plan-2/sub-agents/WaveFlowCheckLeafStores` | 512,059 / 18 / 0 | Same as plan 1 checker: large `omr_read_state` and context reads for a checker that mostly needs task/wave/dependency structure. |
| `milestone-plan-2/sub-agents/WaveFlowRecheckLeafStores` | 239,985 / 9 / 0 | Same as plan 1 recheck: cleaner but still oversized compact state. |

## Recommendations

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

### R1. Return compact mutation receipts from `omr_transition`

- **Reason:** `omr_transition` is the largest project-controlled result bloat source after generic file reads. It returned 1.91MB of indexed result bytes across only 29 results. Individual plan/closeout transition receipts exceeded 100KB and repeated full roadmap content that the agent did not need.
- **Impact:** High.
- **Suggested approach:** Add an optional result mode to `omr_transition`, for example `returnScope: "receipt" | "summary" | "state"`, defaulting to `receipt` for command prompts or defaulting to `state` only if backward compatibility is mandatory. Receipt should include: operation, event id, active roadmap/milestone/change ids, phase/status after mutation, progress step, active wave id, closeout status, and `next_actions`. Keep full state available via `omr_read_state` if the agent needs it. Likely files: `packages/extension/src/tools/register/transition-tools.ts`, `packages/core/src/store/events.ts`, `packages/core/src/state-summary.ts`.
- **Breaking change:** No if additive and command prompts pass/use the compact mode. Yes if the default `details` payload changes for all callers.

### R2. Add narrower `omr_read_state` scopes for flow control and checker work

- **Reason:** Current `compact` and scoped reads are still tens of kilobytes. Checkers and orchestrators often need only phase, active ids, progress cursor, current wave, quality-gate status, or milestone outlines.
- **Impact:** High.
- **Suggested approach:** Add scopes such as `phase`, `progress`, `active_wave_header`, `quality_gates`, `milestone_outlines`, and `closeout_requirements`. Keep current scopes intact. Update command prompts and generated checker prompts to use the narrowest scope. In `state-summary.ts`, avoid embedding full `roadmap_milestone_check`, `discovery`, `wave_flow_check.findings`, and full task ownership lists unless the selected scope needs them.
- **Breaking change:** No if scopes are additive and existing scopes remain.

### R3. Add deterministic `next_actions` to tool successes and errors

- **Reason:** Several errors were workflow-order mistakes that the tool could predict and explain as machine-actionable next steps. The closeout phase error already gave a useful prose hint; other errors did not.
- **Impact:** High.
- **Suggested approach:** Return a compact `next_actions` array from `omr_transition`, `omr_prepare_wave_dispatch`, `omr_record_wave_review`, `omr_validate`, and closeout-related failures. Each action should include `label`, `tool`, `input`, and `why`. Examples:
  - If phase is `milestone_approved` and `/omr:ms-implement` calls dispatch, suggest `omr_transition { operation: "start_implementation" }`.
  - If active wave is complete and progress is `ready_for_next_wave`, suggest advancing to the next pending wave or call a new helper to do it.
  - If closeout evidence is recorded but not closed, suggest `record_closeout` with `status: "closed"` before `complete_milestone`.
  - If completion is missing canonical acceptance text, return the exact missing item plus its stable id if available.
- **Breaking change:** No. Additive result fields.

### R4. Fix `/omr:ms-implement` first-step guidance

- **Reason:** The implementation session immediately failed because the orchestrator called `omr_prepare_wave_dispatch` while phase was `milestone_approved`. The prompt says to call `omr_prepare_wave_dispatch` before dispatching, but it does not clearly say to first call `omr_transition start_implementation` when implementation is not legally open.
- **Impact:** High.
- **Suggested approach:** Update command-specific instructions in `packages/extension/src/extension/commands/prompts.ts`:
  - If phase is `milestone_approved`, call `omr_transition { operation: "start_implementation" }` before `omr_prepare_wave_dispatch`.
  - If phase is `implementing` and progress has an active wave, continue with dispatch/review based on progress.
  - If phase is `reviewing`/`closeout`, do not dispatch workers; follow closeout next actions.
- **Breaking change:** No. Prompt-only.

### R5. Make wave advancement explicit and hard to misuse

- **Reason:** After wave 1 review passed, the progress step became `ready_for_next_wave`, but active wave still pointed at completed `wave-1`. The next dispatch failed with `Active wave wave-1 is already complete`, then the agent manually patched progress to wave 2.
- **Impact:** High.
- **Suggested approach:** Choose one low-risk path:
  1. Add `omr_advance_wave` to move from a completed current wave to the next pending wave and return dispatch-ready state.
  2. Let `omr_prepare_wave_dispatch` detect `ready_for_next_wave` + completed active wave and return a `next_actions` hint instead of a bare error.
  3. Let `omr_record_wave_review` automatically set `active_wave_id` to the next pending wave when a review passes, while setting `closeout_ready` if none remain.

  Option 2 is lowest risk; option 3 removes a whole class of orchestration steps but changes state-machine behavior. Likely files: `packages/core/src/wave-orchestration/review.ts`, `dispatch.ts`, `context.ts`, and command prompts.
- **Breaking change:** No for option 2. Potentially yes/behavioral for option 3.

### R6. Provide a closeout preparation tool or item-id based evidence recording

- **Reason:** Closeout failed because the agent had to reproduce canonical acceptance criterion text exactly and manage `open`/`recorded`/`closed` status sequencing. Exact long-text matching is brittle and bloats input/output.
- **Impact:** High.
- **Suggested approach:** Add `omr_prepare_closeout` returning a compact template:
  - canonical acceptance criteria with stable ids,
  - canonical verification commands with stable ids,
  - current closeout status,
  - required next operation,
  - minimal example payload.

  Then allow `record_closeout` to accept `{ itemId, status, reason }` entries, preserving rendered text internally. Keep text-based input accepted for compatibility.
- **Breaking change:** No if item-id input is additive and text matching remains accepted.

### R7. Use operation-specific schemas for `omr_transition`

- **Reason:** A single broad schema allowed `start_milestone_planning` to receive a partial `milestone` object, causing validation errors about fields that the operation does not actually need. The agent then had to retry with a full draft plan.
- **Impact:** Medium-High.
- **Suggested approach:** Replace the current broad object schema with a discriminated union keyed by `operation`, or add pre-validation that rejects irrelevant fields with a focused hint. Examples:
  - `start_milestone_planning`: no `milestone` input; just operation/approval metadata if any.
  - `create_milestone_plan`/`update_milestone_plan`: require full milestone plan input.
  - `record_closeout`: require closeout evidence only in closeout phase.

  If the extension API makes discriminated unions awkward, add runtime validation before Zod detail surfaces to agents.
- **Breaking change:** Possibly yes if callers currently send irrelevant fields. Low risk if implemented as warnings/hints first, then strict later.

### R8. Add path manifests to worker/scout/checker prompts

- **Reason:** Several agents guessed paths (`storetest`, `store/storetest`, `store/qry`, `mdl/core.go`, `backend-specs/docs`) and paid an error/recovery cost.
- **Impact:** Medium.
- **Suggested approach:** Include a compact path manifest in `omr_prepare_wave_dispatch`, `omr_prepare_wave_review`, and checker task prompts:
  - owned files from the plan,
  - discovered existing directories relevant to the task,
  - user-supplied external doc paths,
  - “missing/not in repo” facts discovered earlier.

  Also update prompts: if a path was not supplied by the plan or a prior tool result, use `glob`/`omr_search_context` before `read`.
- **Breaking change:** No.

### R9. Add environment/tool preflight hints for verification tasks

- **Reason:** `t5-test-helper-tests` tried `psql` and failed because the command was unavailable. The project already knew the Postgres test server details; the agent needed a reliable way to verify without assuming client tools.
- **Impact:** Medium.
- **Suggested approach:** For tasks with verification commands or external services, include a preflight section in worker prompts:
  - available DSN/host facts from the plan,
  - known MCP/tool alternatives if CLI clients are absent,
  - preferred verification path for this repo,
  - “do not assume psql exists; use Go/sqlx test helper or configured MCP if available.”

  For this project, implementation agents should prefer repo-native Go test helpers or existing MCP database tools over shelling out to `psql` unless the plan explicitly requires `psql`.
- **Breaking change:** No.

### R10. Reduce broad search result volume with search modes and prompt rules

- **Reason:** Broad grep results repeatedly returned tens of kilobytes and many matches when the agent often needed only file names, counts, or selected definitions.
- **Impact:** Medium-High.
- **Suggested approach:** Add prompt rules and, where project-owned tools are involved, tool options:
  - first pass: file list or count-only,
  - second pass: selected files/line ranges,
  - avoid `:raw` unless exact full file text is needed,
  - for scouts, include a hard cap and require a “why this expansion is needed” note before reading broad result sets.

  If OMP built-in `grep` cannot be changed here, update generated OMR scout/checker/worker prompts to prefer `glob`, `omr_search_context` with `maxResults`/`snippetChars`, and focused `read` ranges before broad grep.
- **Breaking change:** No for prompt changes. Potentially no for additive tool modes.

### R11. Avoid full roadmap reads in checkers by providing structured checker packages

- **Reason:** `RoadmapMilestoneCheck` searched roadmap milestone context and then read a full roadmap milestone section. Wave-flow checkers similarly read large roadmap and milestone state. Checkers need structured criteria, not raw markdown.
- **Impact:** Medium.
- **Suggested approach:** When dispatching checker agents, build a compact package containing exactly:
  - roadmap id/title/phase,
  - milestone outlines or active milestone plan sections needed for the check,
  - dependency graph,
  - task/wave ownership and acceptance/verification summaries,
  - prior checker findings if rechecking.

  Implement as a new context scope or as part of the checker dispatch prompt. Avoid asking checkers to rediscover the same roadmap text.
- **Breaking change:** No.

### R12. Tighten job-wait guidance in implementation and planning prompts

- **Reason:** Repeated `job` polling added many small tool results and extra reasoning turns. The job tool already supports blocking waits and automatic result delivery.
- **Impact:** Medium.
- **Suggested approach:** Update command prompts and implementation-orchestrator skill text:
  - after dispatching checker/worker/reviewer jobs, issue one blocking `job` wait with a meaningful timeout or wait for all running jobs if fully blocked,
  - do not loop short polls unless interrupted or a timeout indicates real liveness risk,
  - use IRC liveness checks only after timeout or when state says a worker should exist but the job handle is absent.
- **Breaking change:** No. Prompt-only.

### R13. Surface project rules before throwaway verification code

- **Reason:** `wave-2-review` generated a throwaway Go verification program that triggered the `go-rand-v2` rule. The rule injection corrected the behavior after an aborted write, but earlier rule access would avoid the failed write and extra context.
- **Impact:** Medium.
- **Suggested approach:** Include a short language-rule/style prelude in reviewer and worker prompts when they are likely to generate code, or instruct them to call the style/rules tool before creating throwaway verification programs. For Go, include `math/rand/v2` rather than legacy `math/rand`.
- **Breaking change:** No.

### R14. Improve bash/search failure classification in prompts

- **Reason:** Some shell commands failed with “no output” or useful non-zero test output. The failure itself can be meaningful, but agents should avoid shell for searches and design verification commands so expected diagnostic output is not treated as an unexplained failure.
- **Impact:** Medium.
- **Suggested approach:** Prompt agents to use dedicated search tools for code discovery, not shell search commands. For verification scripts that intentionally compare expected/actual state, have the command print a structured PASS/FAIL line and exit non-zero only when the agent should revise code. When a non-zero result contains actionable output, the agent should treat it as test feedback, not tool failure.
- **Breaking change:** No.

### R15. Keep duplicate scouting work from recurring across adjacent milestones

- **Reason:** Several plan-1 and plan-2 subagent sessions are identical or near-identical in volume and patterns, especially `ScoutProviderMCP`, `ScoutStoreBoundary`, `WaveFlowCheckLeafStores`, and `WaveFlowRecheckLeafStores`. The second milestone re-scouted broad areas already inspected during the first milestone.
- **Impact:** Medium.
- **Suggested approach:** Persist compact scout findings as reusable context entries tagged by subsystem and milestone relevance. Before dispatching new scouts, command prompts should search existing findings and pass prior summaries to new agents. Use IRC only when a live previous scout/worker is still available; otherwise use persisted notes/context.
- **Breaking change:** No.

## Suggested implementation order

1. **Compact transition receipts (R1).** Highest direct token savings; small surface area.
2. **Next-action hints for sequencing (R3) plus `/omr:ms-implement` prompt fix (R4).** Highest task-success impact; directly addresses observed errors.
3. **Wave advancement helper/hint (R5).** Removes a repeated orchestration pitfall.
4. **Closeout preparation/item ids (R6).** Prevents brittle long-text matching and closeout retries.
5. **Narrow state/checker scopes (R2, R11).** Reduces repeated planning/checker bloat.
6. **Path manifests and preflight hints (R8, R9).** Prevents low-value path/tool errors.
7. **Search/polling/style prompt refinements (R10, R12, R13, R14, R15).** Medium-impact cleanup that compounds across sessions.

## Acceptance criteria for future fixes

Use the same transcript-index method after implementing improvements:

- `omr_transition` result bytes drop by at least 70% in comparable roadmap/milestone flows.
- `/omr:ms-implement` no longer calls `omr_prepare_wave_dispatch` before `start_implementation` from `milestone_approved`.
- After a wave review passes, the next legal action is explicit in the tool result; no `Active wave ... is already complete` dispatch error occurs.
- Closeout can be completed without exact long-text criterion matching by the agent.
- Checker agents can validate milestone/roadmap structure without raw full-roadmap reads.
- Worker/scout sessions show fewer guessed-path errors.
- Repeated job polling loops are replaced by one blocking wait per dispatched batch unless interrupted or timed out.
