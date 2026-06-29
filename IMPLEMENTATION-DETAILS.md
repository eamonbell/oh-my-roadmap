# roadmap-engineer Implementation Details

This file records the completed implementation details needed to plan follow-up work against the `roadmap-engineer` design spec.

## Package And Runtime

- Extension name: `roadmap-engineer`.
- Package type: local OMP extension package.
- OMP entrypoint: `package.json` declares `omp.extensions: ["./src/main.ts"]`.
- Runtime entrypoint: `src/main.ts`.
- Package manager/runtime: Bun.
- Type checking: `tsc --noEmit`.
- Test runner: `bun test`.
- Verify command: `bun run verify`.
- Main runtime dependencies:
  - `@oh-my-pi/pi-coding-agent@16.2.6`
  - `yaml`
  - `zod`

The extension registers tools and slash commands from `src/main.ts`. The direct file-write gate is also bundled as a standalone pre-hook at `hooks/pre/roadmap-gate.ts`.

## Implemented File Map

- `src/main.ts`: OMP extension factory. Sets the extension label, registers roadmap tools, and registers slash commands.
- `src/extension/commands.ts`: Registers all workflow slash commands and turns each invocation into a strict follow-up prompt seeded with `roadmap_engineer_render_report`.
- `src/tools/register.ts`: Registers the nine `roadmap_engineer_*` tools with Zod parameter schemas and OMP approval tiers.
- `src/core/types.ts`: Canonical TypeScript types for roadmap phases, active pointer, roadmap state, milestone plans, change requests, waves, tasks, validation results, and loaded state.
- `src/core/frontmatter.ts`: Markdown + YAML frontmatter parser/serializer and raw YAML parser/serializer.
- `src/core/paths.ts`: All `.roadmaps` path builders.
- `src/core/store.ts`: State persistence and mutation operations.
- `src/core/validation.ts`: Strict artifact, gate, note, ownership, approval, and change-request validation.
- `src/core/gate.ts`: Direct file-write tool gate.
- `src/core/report.ts`: Human-readable status report and next-action calculation.
- `hooks/pre/roadmap-gate.ts`: OMP pre-tool hook that blocks direct file-write tools when implementation gates are closed.
- `skills/*/SKILL.md`: Role playbooks for roadmap planner, milestone planner, implementation orchestrator, worker, and reviewer.
- `commands/prompts/*.md`: Static command prompt references for all v1 commands.
- `prompts/*.md`: Artifact templates for roadmap, milestone plan, worker note, review note, change request, and closeout.
- `docs/design.md`: User-facing design/behavior documentation.
- `test/state.test.ts`: Fixture-style lifecycle, validation, gate, report, ownership, note, and change-request tests.

## Canonical Artifact Layout

The state root is `.roadmaps`.

```text
.roadmaps/
  active.yml
  <roadmap-id>/
    roadmap.md
    state.yml
    decisions.md
    risks.md
    milestones/
      <milestone-id>/
        plan.md
        notes.md
        closeout.md
        changes/
          <change-id>.md
```

`active.yml` stores:

- `roadmap_id`
- optional `milestone_id`
- optional `change_request_id`
- `updated_at`

`state.yml` stores `RoadmapState`, including the active phase, discovery state, approvals, open questions, milestone summaries, optional active milestone/change IDs, and optional bypass state.

Milestone and change artifacts are Markdown files with YAML frontmatter containing the machine-readable plan/change state. Human-facing content follows the frontmatter.

## Phase And State Model

Implemented phase sequence:

```text
discovery -> roadmap_draft -> roadmap_approved -> milestone_planning -> milestone_approved -> implementing -> reviewing -> closeout -> complete
```

Current implementation uses this phase list as the canonical `Phase` union. Transition operations enforce the legal phase sequence before writing state, with an explicit exception for approved change-request implementation from `reviewing`, `closeout`, or `complete`.

Milestone plans contain:

- `roadmap_id`
- `milestone_id`
- `title`
- `status`
- `approvals`
- `open_questions`
- `verification_commands`
- `acceptance_criteria`
- `cleanup_policy: approval-gated`
- `tasks`
- `waves`

Tasks contain:

- `id`
- `title`
- `worker`
- `status`
- `depends_on`
- `owned_files`
- `owned_modules`
- `shared_interfaces`

Waves contain:

- `id`
- `status`
- `tasks`

Closeout evidence contains:

- `status`
- `acceptance_results`
- `verification_results`
- `worker_notes_reviewed`
- `review_summary`
- `unresolved_risks`
- optional closed metadata

Milestone completion requires every acceptance criterion and verification command to be `passed` or `deferred`. Deferred results require a reason and approver.

Change requests contain the milestone linkage, request text, approval list, verification commands, acceptance criteria, tasks, waves, and optional closeout evidence. Only one active change request is allowed.

## Custom Tools

Implemented model-callable tools:

- `roadmap_engineer_init`
  - Creates `.roadmaps`, `active.yml`, roadmap directory, `state.yml`, `roadmap.md`, `decisions.md`, and `risks.md`.
  - Rejects creation if another roadmap is already active.

- `roadmap_engineer_read_state`
  - Reads active pointer, active roadmap state, active milestone plan, and active change request.

- `roadmap_engineer_transition`
  - Supports operations:
    - `record_discovery`
    - `approve_roadmap`
    - `start_milestone_planning`
    - `create_milestone_plan`
    - `approve_milestone`
    - `start_implementation`
    - `start_reviewing`
    - `start_closeout`
    - `complete_milestone`
    - `request_bypass`
    - `clear_bypass`
    - `approve_change`
    - `close_change`
    - `update_task_status`
    - `update_wave_status`
    - `record_closeout`

- `roadmap_engineer_append_note`
  - Appends immutable Markdown note entries to the active milestone `notes.md`.
  - Supported note kinds: `worker`, `review`, `orchestrator`, `decision`, `issue`.
  - Supported statuses: `open`, `resolved`, `deferred`.

- `roadmap_engineer_validate`
  - Runs strict roadmap validation.

- `roadmap_engineer_next_action`
  - Computes the next legal workflow action based on current phase and validation state.

- `roadmap_engineer_amend`
  - Records roadmap or milestone amendments.
  - Material amendments require `approvedBy`.

- `roadmap_engineer_create_change_request`
  - Creates an active post-implementation change-request plan under the current milestone.
  - Allowed only when roadmap phase is `reviewing`, `closeout`, or `complete`.

- `roadmap_engineer_render_report`
  - Renders active roadmap status, validation errors/warnings, implementation gate state, and next action.

Tool registration uses OMP `registerTool` from `@oh-my-pi/pi-coding-agent/extensibility/extensions`. Read-only tools use approval tier `read`; mutating state tools use approval tier `write`.

## Slash Commands

Implemented OMP slash commands:

- `/roadmap:new`
- `/roadmap:resume`
- `/roadmap:status`
- `/roadmap:amend`
- `/milestone:plan`
- `/milestone:implement`
- `/milestone:status`
- `/milestone:close`
- `/bypass:request`
- `/bypass:clear`
- `/change:request`
- `/change:status`
- `/change:close`

Each command:

- Computes the current `roadmap_engineer_render_report`.
- Sends a follow-up prompt through OMP.
- Instructs the agent to use the roadmap tools for all state changes.
- Reminds the agent not to edit files while implementation gates are closed.

Static prompt reference files also exist under `commands/prompts/`, but the executable slash command behavior is implemented in `src/extension/commands.ts`.

## Direct File-Write Gate

Gate implementation:

- Core gate: `src/core/gate.ts`.
- OMP pre-hook: `hooks/pre/roadmap-gate.ts`.

Blocked direct file-write tools:

- `write`
- `edit`
- `ast_edit`
- `resolve`

The gate allows non-write tools and blocks direct write tools unless `validateImplementationGate()` passes.

Implementation gate opens when:

- Active roadmap state validates.
- Active roadmap phase is `implementing` or `reviewing`.
- Active milestone exists and has approval.
- Active change request, if present, is `approved` or `implementing`.
- No open blocking notes exist.
- No validation errors exist.

Bypass behavior:

- `request_bypass` requires a reason and records a bypass object in `state.yml`.
- Active bypass emits a validation warning and allows the implementation gate to pass.
- `clear_bypass` removes the bypass.

Known limitation:

- V1 does not inspect or block mutating shell commands. `bash` is intentionally allowed by `shouldBlockToolCall()`.

## Strict Validation Rules

`validateRoadmapState()` checks:

- Active pointer readability.
- Roadmap existence and required fields.
- Phase membership in the canonical phase list.
- Roadmap open questions are empty before approval.
- Discovery is recorded before approved phases.
- Required external research is recorded before approved phases.
- Roadmap approval exists before approved phases.
- Duplicate roadmap milestone IDs.
- Active milestone existence.
- Milestone required fields.
- Milestone open questions are empty.
- Verification commands are present.
- Acceptance criteria are present.
- Tasks and waves are present.
- Task IDs are unique.
- Each task has a worker.
- Each task owns at least one file or module.
- Wave IDs are unique.
- Waves reference known task IDs.
- Same-wave ownership does not overlap across owned files/modules.
- Milestone approval exists before milestone-approved-or-later phases.
- Active change-request existence.
- Change request is approved before implementation/review states.
- Change request plan has the same required task/wave/verification/acceptance structure.
- Notes with `blocking: true` must have `status: resolved` or `status: deferred`.

`validateImplementationGate()` layers implementation-specific checks on top of strict roadmap validation.

## Store Operations

Important exported operations in `src/core/store.ts`:

- `loadActive`
- `writeActive`
- `loadRoadmapState`
- `writeRoadmapState`
- `loadMilestonePlan`
- `writeMilestonePlan`
- `loadChangeRequest`
- `loadState`
- `initRoadmap`
- `createMilestonePlan`
- `transition`
- `appendNote`
- `amend`
- `createChangeRequest`
- `resetRoadmapStateForTest`

IDs are validated as lower-case slug strings matching:

```text
^[a-z0-9][a-z0-9-]*$
```

## Role Skills

Implemented role playbooks:

- `skills/roadmap-planner/SKILL.md`
  - Repo discovery, no assumptions, roadmap phased intent, research requirements, approval constraints.

- `skills/milestone-planner/SKILL.md`
  - Prior context review, drift detection, decision-complete milestone/change planning, dependency waves, ownership.

- `skills/implementation-orchestrator/SKILL.md`
  - One wave at a time, active branch only, worker dispatch, notes, review, amendment handling.

- `skills/worker/SKILL.md`
  - Assigned scope only, no unowned edits, append scoped worker notes.

- `skills/reviewer/SKILL.md`
  - Wave/closeout review, blocking/nonblocking findings, ownership and verification checks.

## Templates

Implemented templates:

- `prompts/roadmap-template.md`
- `prompts/milestone-plan-template.md`
- `prompts/worker-note-template.md`
- `prompts/review-note-template.md`
- `prompts/change-request-template.md`
- `prompts/closeout-template.md`

These templates are reference artifacts. The core state engine currently writes minimal generated documents directly rather than rendering templates through a template engine.

## Tests And Verification Coverage

Tests are in `test/state.test.ts`.

Covered scenarios:

- Initializes active roadmap state.
- Blocks implementation before approvals.
- Requires discovery before roadmap approval is valid.
- Opens implementation gate only after milestone approval and `start_implementation`.
- Rejects overlapping owned file/module ownership in the same wave.
- Blocks open blocking notes until resolved or deferred.
- Creates and gates approved post-implementation change requests.
- Enforces strict legal and illegal phase transitions.
- Tracks task and wave status updates.
- Rejects duplicate wave membership, unknown dependencies, dependency cycles, same/later-wave dependencies, multiple active waves, and out-of-order waves.
- Requires structured closeout evidence before milestone completion.
- Allows approved closeout deferrals with reason and approver.
- Marks closed change requests as `closed`, clears the active change pointer, and preserves the roadmap phase.
- Proves bypass suppresses only file-write gate errors, not invalid state.
- Renders reports.
- Blocks direct file-write tool calls while allowing `bash`.
- Test reset helper removes `.roadmaps`.

Verification commands used:

```sh
bun run check
bun test
bun run verify
omp --extension . -p '/extensions'
```

Observed verification status at implementation completion:

- `bun run check`: passed.
- `bun test`: passed, 16 tests, 0 failures.
- `bun run verify`: passed.
- `omp --extension . -p '/extensions'`: passed with unsandboxed OMP database access and listed the `roadmap_engineer_*` tools.

## Operational Notes

- `node_modules/` is installed locally and ignored by `.gitignore`.
- `bun.lock` is generated and should be kept with the package.
- The current repo has no commits yet.
- `.idea/` exists locally and is ignored.
- OMP extension loading may require normal user-level write access to OMP's database; sandboxed runs can fail with `SQLiteError: attempt to write a readonly database`.

## Known Gaps And Follow-Up Planning Targets

- Shell mutation enforcement is intentionally out of scope for v1.
- The command prompt files under `commands/prompts/` are documentation/reference; executable commands are registered programmatically.
- Templates are not yet used as render sources by `store.ts`.
- Worker subagent dispatch is guided by prompts/skills and OMP task usage, not implemented as a custom scheduler.
- Role model/thinking configuration was planned but not implemented as a config file or runtime setting.
- There is no dedicated report parser for decisions/risks; they are append/read artifacts for planners.
- There is no marketplace or project-scope installer metadata beyond the local OMP extension package layout.
