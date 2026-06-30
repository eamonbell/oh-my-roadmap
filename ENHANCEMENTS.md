# roadmap-engineer Enhancement Plan

## Purpose

This document captures product and architecture enhancements for `roadmap-engineer`.

The goal is not documentation cleanup or test coverage. The goal is to make the extension better at what it is meant to do: help agents and users execute large, gated, multi-step roadmap work safely, resumably, and with less operator burden.

## Included approved recommendations

The selected near-term recommendations are:

1. Durable roadmap quality-gate history.
2. Automated wave execution orchestration.
3. Mutable runtime state split from approved plan documents.
4. First-class blocker state and blocker tools.
5. Executable next-action tooling.
6. Operational dashboard controls in `/roadmap:details`.
7. Append-only transition/event ledger.

Deferred recommendations:

- Write-time ownership enforcement.
- Indexed/hybrid context retrieval.
- Cost-aware planning and execution.
- Multi-roadmap registry and switch/archive flows.
- Planning compiler assistance.

The deferred items are still valuable, but they should follow the included work because they depend on clearer runtime state, events, or orchestration primitives.

---

# Enhancement 1: Durable roadmap quality-gate history

## Problem

The uncommitted changes add `roadmap_milestone_check` as a current-state gate. That blocks approval until the checker passes, but it does not preserve enough workflow history.

Current limitations:

- Only the latest checker result is visible in structured state.
- Failed checker findings can be overwritten by a later result.
- The check is not bound to a rendered roadmap revision/hash.
- Status output can say pending/passed/failed, but cannot explain the full rerun/revision sequence.
- Future users cannot easily answer: “What did the checker object to, and how was it resolved?”

## Desired behavior

Roadmap quality gates should behave like durable workflow events:

- Every checker run is recorded.
- Every result is tied to the roadmap version it checked.
- Failed findings remain available after revision.
- Approval requires the latest required gate to pass for the current roadmap revision.
- Status and dashboard surfaces can show the current gate and prior findings.

## Proposed state model

Keep the current fast snapshot on `RoadmapState`:

```ts
roadmap_milestone_check: WaveFlowCheck
```

Add revision/hash fields:

```ts
interface RoadmapState {
  roadmap_revision: number;
  roadmap_content_hash: string;
  roadmap_milestone_check: RoadmapMilestoneCheck;
}

interface RoadmapMilestoneCheck extends WaveFlowCheck {
  roadmap_revision: number;
  roadmap_content_hash: string;
  event_id: string;
}
```

Use the rendered roadmap markdown as the hash source:

```text
hash(renderRoadmapMarkdown(roadmap))
```

Approval gate:

```text
roadmap_milestone_check.status == passed
roadmap_milestone_check.roadmap_revision == roadmap.roadmap_revision
roadmap_milestone_check.roadmap_content_hash == roadmap.roadmap_content_hash
roadmap_milestone_check.checked_by is non-empty
roadmap_milestone_check.checked_at is non-empty
roadmap_milestone_check.summary is non-empty
```

## Durable history

Record every checker run in the event ledger described later:

```json
{
  "id": "evt_20260630_roadmap_check_001",
  "type": "quality_gate.recorded",
  "operation": "record_roadmap_milestone_check",
  "at": "2026-06-30T00:00:00.000Z",
  "actor": "roadmap-milestone-checker",
  "scope": {
    "roadmap_id": "example-roadmap"
  },
  "roadmap_revision": 3,
  "roadmap_content_hash": "sha256:...",
  "status": "failed",
  "summary": "Milestone sequencing conflict found.",
  "findings": [
    "m02-api depends on schema migration assigned to m03-storage."
  ]
}
```

## Tool/API changes

Update existing operation:

```text
roadmap_engineer_transition
  operation: record_roadmap_milestone_check
  roadmapMilestoneCheck: { status, checkedBy, summary, findings }
```

Add read tool:

```text
roadmap_engineer_list_quality_gates
```

Parameters:

```ts
{
  roadmapId?: string;
  gate?: "roadmap_milestone_check" | "wave_flow_check";
  status?: "pending" | "passed" | "failed";
  limit?: number;
}
```

Return:

```ts
{
  current: RoadmapMilestoneCheck;
  history: QualityGateEvent[];
}
```

## Status behavior

When current check is pending:

```text
Roadmap milestone check: pending
Next action: Dispatch roadmap-milestone-checker for roadmap revision 3.
```

When failed:

```text
Roadmap milestone check: failed
Latest finding: m02-api depends on m03-storage.
Next action: Revise roadmap, regenerate roadmap.md, rerun roadmap-milestone-checker.
```

When stale:

```text
Roadmap milestone check: stale
Checked revision: 2
Current revision: 3
Next action: Rerun roadmap-milestone-checker.
```

## Acceptance criteria

- Approval fails if the check is missing, failed, pending, or stale.
- `updateRoadmap`, reopen, and any roadmap content mutation increments revision/hash and makes previous checks stale.
- Every checker result is appended to the event ledger.
- Status/read-state can show current status plus latest failed findings.
- The dashboard can show check history.

---

# Enhancement 2: Mutable runtime state split

## Problem

Milestone and change request plan artifacts currently mix approved plan definition with frequently changing runtime execution state.

Static plan data:

- Acceptance criteria.
- Verification commands.
- User interview.
- Relevant code/docs.
- Decisions.
- Dependency analysis.
- Task definitions.
- Wave definitions.
- Worker assignments.
- Ownership declarations.

Mutable runtime data:

- Task statuses.
- Wave statuses.
- Progress cursor.
- Active task IDs.
- Blocked reason.

Current hot transitions rewrite the full plan artifact:

- `update_task_status`.
- `update_wave_status`.
- `update_implementation_progress`.

This creates avoidable write churn, mixes approved intent with execution state, and makes future orchestration harder.

## Desired behavior

Separate “what was approved” from “what is currently happening.”

```text
plan.md      = approved plan definition and rendered plan body
runtime.yml  = mutable execution state
notes.md     = append-only narrative/context
closeout.md  = structured closeout evidence
```

For change requests:

```text
changes/<change-id>.md           = approved change plan definition
changes/<change-id>.runtime.yml  = mutable change execution state
```

## Proposed files

Milestone runtime:

```text
.roadmaps/<roadmap-id>/milestones/<milestone-id>/runtime.yml
```

Change runtime:

```text
.roadmaps/<roadmap-id>/milestones/<milestone-id>/changes/<change-id>.runtime.yml
```

## Runtime schema

```yaml
schema_version: 1
roadmap_id: example-roadmap
milestone_id: m01-core
change_request_id: null
created_at: "2026-06-30T00:00:00.000Z"
updated_at: "2026-06-30T00:00:00.000Z"
tasks:
  t01-state:
    status: started
    updated_at: "2026-06-30T00:10:00.000Z"
  t02-report:
    status: assigned
    updated_at: "2026-06-30T00:00:00.000Z"
waves:
  w01:
    status: running
    updated_at: "2026-06-30T00:10:00.000Z"
progress:
  active_wave_id: w01
  step: workers_running
  active_task_ids:
    - t01-state
  blocked_reason: null
  updated_at: "2026-06-30T00:10:00.000Z"
```

## Compatibility strategy

Do not break existing roadmap state.

Load behavior:

1. Read `plan.md` as today.
2. If `runtime.yml` exists, overlay runtime statuses/progress onto plan tasks/waves.
3. If `runtime.yml` does not exist, derive runtime from plan frontmatter.
4. On the next runtime mutation, write `runtime.yml`.

Write behavior:

- `create_milestone_plan` writes `plan.md` and initial `runtime.yml`.
- `update_milestone_plan` updates `plan.md` and resets `runtime.yml` only while in planning.
- `approve_milestone` freezes plan definition.
- `update_task_status`, `update_wave_status`, and `update_implementation_progress` write only `runtime.yml`.
- `record_wave_flow_check` remains on plan while the plan is draft/planning state. Once approved, execution changes go to runtime.

## Type model

Add separate internal types:

```ts
interface MilestonePlanDefinition {
  roadmap_id: string;
  milestone_id: string;
  title: string;
  status: Phase;
  approvals: Approval[];
  open_questions: string[];
  verification_commands: string[];
  acceptance_criteria: string[];
  cleanup_policy: "approval-gated";
  user_interview: string[];
  relevant_existing_code: string[];
  relevant_documentation: string[];
  decisions: string[];
  dependency_analysis: string[];
  tasks: TaskPlanDefinition[];
  waves: WavePlanDefinition[];
  wave_flow_check: WaveFlowCheck;
}

interface MilestoneRuntimeState {
  roadmap_id: string;
  milestone_id: string;
  change_request_id?: string;
  tasks: Record<string, TaskRuntime>;
  waves: Record<string, WaveRuntime>;
  progress: ImplementationProgress;
  updated_at: string;
}
```

Keep the public `MilestonePlan` return shape by overlaying definition + runtime.

## Performance benefit

Small runtime mutations become small YAML writes.

Expected improvements:

- Less disk I/O.
- Less generated markdown churn.
- Cleaner diffs.
- Lower conflict risk.
- Faster status/progress updates for large plans.
- Better foundation for automated orchestration.

## Acceptance criteria

- Existing plan files without runtime files still load.
- New runtime mutations do not rewrite `plan.md`.
- `loadState` returns the same effective task/wave/progress shape as before.
- Validation checks the overlayed state.
- Status, read-state, report, and detail UI continue to work from `loadState`.
- Runtime writes are serialized through `.roadmaps/store.lock`.

---

# Enhancement 3: First-class blocker state and tools

## Problem

Blocking notes currently act as hard workflow gates, but they are stored as note entries in `notes.md`.

This makes blockers too indirect for core workflow control.

Users need a precise answer to:

- What is blocking the roadmap?
- Which wave/task/check does it affect?
- Who owns the resolution?
- What decision is needed?
- What unblocks it?
- Was it resolved, deferred, or superseded?
- Which blocker is stopping the next action?

## Desired behavior

Introduce canonical blocker records.

Notes remain useful narrative context, but blockers become structured workflow state.

## Proposed file

```text
.roadmaps/<roadmap-id>/blockers.yml
```

Global roadmap-scoped blocker file keeps all blockers in one place while allowing scoped records.

## Schema

```yaml
schema_version: 1
roadmap_id: example-roadmap
blockers:
  - id: b01-api-contract
    title: API contract unresolved
    status: open
    severity: blocking
    owner: main
    scope:
      type: task
      milestone_id: m01-core
      change_request_id: null
      wave_id: w01
      task_id: t03-api
    source:
      kind: review
      note_id: notes:m01-core:7
      event_id: evt_...
    decision_needed: User approval for response envelope shape.
    unblock_condition: Response envelope selected and task plan amended.
    created_by: reviewer
    created_at: "2026-06-30T00:00:00.000Z"
    updated_at: "2026-06-30T00:00:00.000Z"
    resolved_at: null
    resolution: null
    approver: null
```

## Tools

```text
roadmap_engineer_open_blocker
roadmap_engineer_resolve_blocker
roadmap_engineer_defer_blocker
roadmap_engineer_list_blockers
```

Open blocker input:

```ts
{
  title: string;
  severity: "blocking" | "warning";
  owner: "main" | "user" | "worker" | "reviewer" | "checker";
  scope: {
    type: "roadmap" | "milestone" | "change" | "wave" | "task" | "quality_gate";
    milestoneId?: string;
    changeRequestId?: string;
    waveId?: string;
    taskId?: string;
    gate?: string;
  };
  decisionNeeded?: string;
  unblockCondition: string;
  sourceNoteId?: string;
}
```

Resolve blocker input:

```ts
{
  blockerId: string;
  resolution: string;
  approver?: string;
}
```

Defer blocker input:

```ts
{
  blockerId: string;
  reason: string;
  approver: string;
}
```

## Validation behavior

Implementation gate closes when there is any blocker with:

```text
status = open
severity = blocking
```

Approval/transition gates can check blocker scopes:

- Roadmap approval blocked by open roadmap or quality-gate blockers.
- Wave completion blocked by open task/wave blockers in that wave.
- Milestone closeout blocked by unresolved milestone blockers unless explicitly deferred.

## Interaction with notes

`appendNote` remains available.

When a note is appended with `blocking: true`, options:

1. Automatically create a blocker record from note frontmatter and title.
2. Require the caller to create a blocker explicitly.

Recommended: automatic creation for compatibility, with explicit tools for direct blocker management.

## Acceptance criteria

- Open blocking records close the implementation gate.
- Resolved/deferred blockers no longer close the gate.
- Status/read-state/dashboard show blockers without scanning notes.
- Existing blocking notes still work during migration.
- Blocker changes append event ledger entries.

---

# Enhancement 4: Append-only transition/event ledger

## Problem

Current state is snapshot-oriented. Snapshots are necessary, but they do not answer important long-running workflow questions:

- What changed since the last session?
- Who approved or deferred a blocker?
- Which checker runs failed before the current pass?
- How long was the milestone blocked?
- Which task status changed unexpectedly?
- What state existed before a partial or malformed write?

## Desired behavior

Add a durable append-only event ledger for workflow transitions and important derived events.

## Proposed file

```text
.roadmaps/<roadmap-id>/events.ndjson
```

One JSON object per line.

## Event envelope

```ts
interface RoadmapEvent {
  id: string;
  schema_version: 1;
  at: string;
  actor: string;
  type: string;
  operation?: string;
  scope: {
    roadmap_id: string;
    milestone_id?: string;
    change_request_id?: string;
    wave_id?: string;
    task_id?: string;
    blocker_id?: string;
    gate?: string;
  };
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  details?: Record<string, unknown>;
}
```

## Initial event types

```text
roadmap.initialized
roadmap.updated
roadmap.reopened
roadmap.approved
quality_gate.recorded
milestone.plan_created
milestone.plan_updated
milestone.approved
implementation.started
task.status_changed
wave.status_changed
progress.updated
blocker.opened
blocker.resolved
blocker.deferred
review.started
closeout.recorded
milestone.completed
change.created
change.approved
change.closed
bypass.requested
bypass.cleared
```

## Write behavior

- Event append happens under `.roadmaps/store.lock`.
- Event append occurs in the same locked mutation path as state writes.
- If the state write fails, do not append the event.
- If event append fails, fail the mutating operation rather than silently losing audit history.

## Query tool

```text
roadmap_engineer_read_events
```

Parameters:

```ts
{
  roadmapId?: string;
  milestoneId?: string;
  changeRequestId?: string;
  taskId?: string;
  waveId?: string;
  blockerId?: string;
  type?: string[];
  since?: string;
  limit?: number;
}
```

## Acceptance criteria

- Every mutating transition appends an event.
- Checker runs and blocker lifecycle changes are visible after later state changes.
- Event reads are capped by default.
- Status can show “last changed” and “latest blocking event.”
- Closeout can reference relevant events as evidence.

---

# Enhancement 5: Executable next-action tooling

## Problem

`nextAction` currently returns descriptive text. That is helpful, but it still leaves the operator/model to translate the instruction into the correct tool call or subagent dispatch.

As more gates are added, descriptive strings become less reliable.

## Desired behavior

Represent next actions as structured, optionally executable operations.

## Tools

Keep current read tool:

```text
roadmap_engineer_next_action
```

Change result shape from only text to structured data while preserving text content for compatibility.

Add:

```text
roadmap_engineer_apply_next_action
```

## Next-action schema

```ts
interface NextActionPlan {
  id: string;
  label: string;
  description: string;
  status: "available" | "blocked" | "requires_user_approval" | "requires_agent_run";
  safe_to_apply: boolean;
  operation?: TransitionInput["operation"];
  required_tool?: string;
  required_agent?: string;
  blockers: string[];
  missing_inputs: string[];
  scope: {
    roadmap_id: string;
    milestone_id?: string;
    change_request_id?: string;
    wave_id?: string;
  };
}
```

Examples:

```json
{
  "id": "run-roadmap-milestone-checker",
  "label": "Run roadmap-milestone-checker",
  "status": "requires_agent_run",
  "safe_to_apply": false,
  "required_agent": "roadmap-milestone-checker",
  "missing_inputs": [],
  "blockers": []
}
```

```json
{
  "id": "advance-wave-review",
  "label": "Move active wave to review",
  "status": "available",
  "safe_to_apply": true,
  "operation": "update_wave_status",
  "scope": { "wave_id": "w01" }
}
```

## Safe-to-apply actions

These can be executed by `roadmap_engineer_apply_next_action` when state is valid:

- Mark active wave `reviewing` when all active wave tasks are done.
- Mark progress `closeout_ready` when all waves are complete.
- Clear stale active task IDs when no task is running.
- Move from `ready_for_next_wave` to the next pending wave.
- Record derived event entries.

## Approval-required actions

These must never be applied without explicit user approval:

- `approve_roadmap`.
- `approve_milestone`.
- `approve_change`.
- `complete_milestone` if any evidence is deferred.
- `request_bypass`.
- `defer_blocker`.

## Agent-required actions

These should produce exact dispatch instructions rather than pretending to execute:

- Run roadmap-milestone-checker.
- Run wave-flow-checker.
- Dispatch active-wave workers.
- Dispatch reviewer.

If automated orchestration is implemented, `apply_next_action` can call that orchestrator for agent-required actions.

## Acceptance criteria

- Status/read-state expose structured next action.
- Apply-next-action refuses ambiguous or approval-required actions.
- Failed/pending roadmap milestone checks produce a precise rerun/revise action.
- Runtime progress can advance safely when objective state proves the transition is legal.

---

# Enhancement 6: Automated wave execution orchestration

## Problem

The system already stores enough information to run implementation waves, but execution is prompt-guided.

Current milestone/change plans know:

- Tasks.
- Worker role per task.
- Ownership.
- Dependencies.
- Waves.
- Verification commands.
- Progress cursor.

The command prompt tells the main agent to dispatch workers and reviewers, but this relies on model discipline.

## Desired behavior

Add an orchestrator that can run the active wave consistently.

## Command/tool surface

```text
roadmap_engineer_run_active_wave
```

Optional separate commands:

```text
roadmap_engineer_prepare_wave_dispatch
roadmap_engineer_record_wave_result
roadmap_engineer_run_wave_review
```

## Core flow

1. Load active roadmap state.
2. Validate implementation gate.
3. Select active plan:
   - active change request if present;
   - otherwise active milestone.
4. Select active wave from runtime progress.
5. Ensure all dependencies from prior waves are complete.
6. Ensure same-wave task ownership does not overlap.
7. Build one worker assignment per active-wave task.
8. Mark wave `running`.
9. Mark tasks `started`.
10. Dispatch workers using each task’s recorded worker role.
11. Require worker note/result for each task.
12. Mark successful tasks `done`; blocked tasks `blocked` and open blockers.
13. If all tasks done, mark wave `reviewing`.
14. Dispatch reviewer.
15. If review passes, mark wave `complete` and advance progress.
16. If review fails, open blockers and set progress `resolving_blockers`.

## Worker assignment payload

Each worker receives only the needed scope:

```ts
{
  roadmap_id: string;
  milestone_id: string;
  change_request_id?: string;
  wave: WavePlan;
  task: TaskPlan;
  owned_files: string[];
  owned_modules: string[];
  shared_interfaces: string[];
  verification_commands: string[];
  relevant_plan_sections: ContextEntryResult[];
  relevant_decisions: ContextEntryResult[];
  relevant_risks: ContextEntryResult[];
}
```

## Integration boundary

If the extension API supports direct subagent dispatch, `roadmap_engineer_run_active_wave` should perform dispatch directly.

If direct dispatch is not available, first implementation should still add value by producing a deterministic dispatch package:

```text
roadmap_engineer_prepare_wave_dispatch
```

The command prompt can then dispatch those exact assignments. State updates still happen through structured tools.

## State interactions

Requires the runtime split for clean implementation:

- Task/wave/progress updates write `runtime.yml`.
- Blockers write `blockers.yml`.
- Every transition writes `events.ndjson`.

## Failure handling

Worker failure:

- Mark task `blocked`.
- Open blocker with source `worker`.
- Set progress `resolving_blockers`.
- Append event.

Reviewer failure:

- Keep wave `reviewing` or mark `blocked` depending on severity.
- Open blocker for each review finding.
- Append event.

Partial completion:

- Do not start later waves.
- Keep completed task statuses.
- Resume picks up incomplete active-wave tasks.

## Acceptance criteria

- Active wave can be prepared/dispatched from structured state.
- Task and wave statuses update automatically around execution.
- Worker/reviewer findings become blockers.
- Resume state is correct after partial failure.
- Orchestrator never runs tasks outside the active wave.
- Orchestrator never dispatches a task to a worker role different from the plan.

---

# Enhancement 7: Operational dashboard controls

## Problem

`/roadmap:details` exists as a status UI, but the workflow still requires users to translate state into the next tool calls manually.

As the workflow adds quality gates, blockers, runtime state, and event history, the dashboard should become the primary operating surface.

## Desired behavior

Turn `/roadmap:details` into a controlled workflow dashboard.

## Dashboard sections

1. Roadmap health
   - Phase.
   - Validation status.
   - Implementation gate status.
   - Active milestone/change.
   - Current next action.

2. Quality gates
   - Roadmap milestone check status.
   - Checked revision/hash.
   - Latest findings.
   - History count.
   - Rerun required/stale marker.

3. Active execution
   - Active wave.
   - Wave status counts.
   - Active tasks.
   - Worker roles.
   - Owned files/modules.
   - Verification commands.

4. Blockers
   - Open blocking blockers.
   - Owner.
   - Scope.
   - Unblock condition.
   - Resolve/defer controls.

5. Events
   - Recent transitions.
   - Last mutation time.
   - Recent checker runs.
   - Recent blocker changes.

6. Usage
   - Existing usage totals.
   - Milestone/change usage.
   - Deferred cost controls can come later.

## Dashboard controls

Initial controls:

- Apply safe next action.
- Prepare/run active wave.
- Record checker result or show rerun instructions.
- Resolve blocker.
- Defer blocker with approval.
- Open relevant context entries.
- Copy exact tool call for next action.

## Safety rules

- Approval-required actions must still ask for explicit approval.
- Destructive or ambiguous actions are not one-click.
- Controls call the same structured tools as command flows.
- Dashboard never bypasses validation.

## Acceptance criteria

- User can identify what is blocked and why without reading raw `.roadmaps` files.
- User can trigger safe transitions from the dashboard.
- Dashboard shows roadmap milestone check stale/pending/failed states clearly.
- Dashboard shows active-wave execution data from runtime state.
- Dashboard shows blocker records, not only note-derived snippets.

---

# Suggested implementation sequence

## Milestone 1: State foundations

Implement:

1. Event ledger.
2. Roadmap revision/hash.
3. Durable quality-gate history.
4. Quality-gate list/read tool.

Why first:

- The new roadmap-milestone-checker needs durable history and stale-check protection.
- The ledger gives later features an audit trail.

Key files likely involved:

- `src/core/types.ts`
- `src/core/store.ts`
- `src/core/paths.ts`
- `src/core/files.ts`
- `src/core/validation.ts`
- `src/core/report.ts`
- `src/core/state-summary.ts`
- `src/tools/register.ts`

## Milestone 2: Runtime and blockers

Implement:

1. `runtime.yml` for milestones.
2. `<change-id>.runtime.yml` for change requests.
3. Runtime overlay in `loadState`.
4. Runtime-only task/wave/progress writes.
5. `blockers.yml`.
6. Blocker lifecycle tools.
7. Gate integration for canonical blockers.

Why second:

- Orchestration and executable next action both need clean mutable runtime state.
- Blockers are core to safe pause/resume.

Key files likely involved:

- `src/core/types.ts`
- `src/core/paths.ts`
- `src/core/store.ts`
- `src/core/validation.ts`
- `src/core/report.ts`
- `src/core/roadmap-detail-summary.ts`
- `src/tools/register.ts`

## Milestone 3: Executable next action

Implement:

1. Structured next-action plan.
2. `roadmap_engineer_apply_next_action`.
3. Stale/pending/failed quality-gate next actions.
4. Blocker-aware next actions.
5. Runtime-aware wave progress next actions.

Why third:

- The state model is ready.
- The tool can safely automate low-risk transitions.

Key files likely involved:

- `src/core/report.ts`
- new `src/core/next-action.ts` if `report.ts` becomes too broad
- `src/core/store.ts`
- `src/core/validation.ts`
- `src/tools/register.ts`

## Milestone 4: Wave orchestration

Implement:

1. Dispatch-package generation.
2. Active-wave preparation.
3. Worker assignment payloads.
4. Worker result recording.
5. Review result recording.
6. Runtime/blocker/event integration.
7. Direct subagent dispatch if the extension API supports it.

Why fourth:

- This is the biggest behavior change.
- It needs the previous state and next-action foundations.

Key files likely involved:

- new `src/core/orchestration.ts`
- `src/core/store.ts`
- `src/core/context.ts`
- `src/core/state-summary.ts`
- `src/tools/register.ts`
- `src/extension/commands.ts`

## Milestone 5: Dashboard controls

Implement:

1. Enhanced detail summary model.
2. Quality-gate panel.
3. Blocker panel.
4. Runtime execution panel.
5. Recent events panel.
6. Safe action controls.
7. Prepare/run active wave control.

Why last:

- It becomes much more valuable once state/actions are structured.
- It should consume existing APIs rather than create its own workflow path.

Key files likely involved:

- `src/core/roadmap-detail-summary.ts`
- `src/extension/report-ui.ts`
- `src/extension/commands.ts`
- `src/core/report.ts`

---

# Deferred enhancements

These are intentionally not part of the near-term implementation plan.

## Write-time ownership enforcement

Value:

- Enforces worker file/module ownership during implementation.
- Prevents unowned edits in same-branch multi-agent work.

Reason to defer:

- Needs confirmation that hook event payloads expose target file paths for write tools.
- Runtime/blocker/orchestration state should exist first.

## Indexed/hybrid context retrieval

Value:

- Speeds large roadmap context search.
- Enables better long-running memory.

Reason to defer:

- Current lexical context tools are good enough until large roadmap artifacts become a measured problem.
- Event ledger and quality-gate history should land first so indexing has better source data.

## Cost-aware planning and execution

Value:

- Turns existing usage tracking into budgets, warnings, and cost feedback.

Reason to defer:

- More useful after orchestration can attribute work to waves/tasks consistently.

## Multi-roadmap registry

Value:

- Better management of multiple roadmap directories under `.roadmaps`.

Reason to defer:

- Current workflow centers one active roadmap.
- Registry is valuable after single-roadmap execution UX is stronger.

## Planning compiler assistance

Value:

- Generates/checks candidate task graphs, ownership, waves, dependencies, and verification maps.

Reason to defer:

- The new `roadmap-milestone-checker` already improves roadmap-level planning quality.
- Runtime/orchestration work is a higher-leverage next step.

---

# Product outcome

If the included enhancements are implemented, `roadmap-engineer` moves from a strict state-gated planning extension to a practical execution system:

- Roadmap approval has durable, revision-safe quality gates.
- Approved plans stop absorbing high-frequency runtime churn.
- Blockers become actionable workflow state.
- Next actions become structured and safely executable.
- Active waves can be prepared or run consistently.
- The dashboard becomes an operator surface, not just a report.
- Long-running work gains an audit trail that supports recovery, metrics, and closeout evidence.
