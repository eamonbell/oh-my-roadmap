# roadmap-engineer Extension Design

## Summary

Design a local OMP extension named `roadmap-engineer` under `/Users/eamon/Development/Agents/omp-engineer`, delivered first as a design spec before
implementation. The extension enforces a multi-session, hard-gated workflow for complex features/refactors: roadmap planning, milestone planning,
dependency-based implementation waves, worker note capture, review gates, closeout evidence, and post-implementation change requests.

Canonical project state lives in repo files under `.roadmaps`, using Markdown with YAML frontmatter. The extension provides slash commands, custom
state tools, skills/custom agents, hooks, templates, and typed Bun tests.

## Extension Shape

Use the OMP extension package layout:

- `package.json` with `omp.extensions: ["./src/main.ts"]`.
- `src/main.ts` registers commands, tools, and extension wiring.
- `skills/` contains phase playbooks.
- `commands/` contains slash command prompts.
- `hooks/pre/` contains hard-gate checks for direct file-write tools.
- `tools/` contains typed state tool implementations.
- `prompts/` contains artifact templates.
- `test/fixtures/` contains `.roadmaps` fixture states.

Use a typed package setup with `tsconfig`, Bun test scripts, and a dedicated YAML/frontmatter parser dependency. Role model/thinking configuration
exists, but every role inherits the active OMP session settings by default.

## Workflow

The hard-gated workflow activates only through explicit commands. Normal non-roadmap work is not gated unless a roadmap is active or resumed.

V1 slash commands:

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

Enforce one active roadmap per repo and one active milestone per roadmap. Store the active pointer at `.roadmaps/active.yml`.

Required phase sequence:

`discovery -> roadmap_draft -> roadmap_approved -> milestone_planning -> milestone_approved -> implementing -> reviewing -> closeout -> complete`

Roadmap approval requires a recorded repo discovery pass. External research is required when local discovery identifies external APIs, dependencies,
or current-docs risk. Roadmaps define phased intent: goals, constraints, milestone order, dependencies, risks, and success criteria, not full
implementation details.

Milestone plans must be decision-complete before implementation opens. They must include exact verification commands, acceptance criteria, cleanup
policy, dependency analysis, exclusive file/module ownership, worker assignments, and execution waves such as `Wave 1: T1, T3`, `Wave 2: T2`.

No worktrees or isolated workspaces. All agents operate on the active branch. Same-wave tasks must have non-overlapping owned files/modules and
clearly listed shared interfaces. If a worker discovers it needs unowned files/modules, it must stop and append a blocker note; the orchestrator
replans ownership before edits continue.

## State, Tools, And Gates

Use `.roadmaps/<roadmap-id>/` with:

- `roadmap.md`
- `state.yml`
- `decisions.md`
- `risks.md`
- `milestones/<milestone-id>/plan.md`
- `milestones/<milestone-id>/notes.md`
- `milestones/<milestone-id>/closeout.md`
- `milestones/<milestone-id>/changes/<change-id>.md`

V1 custom tools:

- `roadmap_engineer_init`
- `roadmap_engineer_read_state`
- `roadmap_engineer_transition`
- `roadmap_engineer_append_note`
- `roadmap_engineer_validate`
- `roadmap_engineer_next_action`
- `roadmap_engineer_amend`
- `roadmap_engineer_create_change_request`
- `roadmap_engineer_render_report`

Validation is strict. Missing required fields, duplicate human-readable slugs, invalid transitions, malformed frontmatter, open material questions,
unresolved blocking findings, or unmet approval gates block progress.

Hooks block direct file-write tools before required gates are satisfied. V1 accepts that mutating shell commands are not reliably blocked; this
limitation must be documented.

Approvals are recorded explicitly in artifacts with timestamp, approver label, and approval summary. Roadmap amendments always require approval.
Material milestone amendments require approval when they change scope, acceptance criteria, verification, wave ordering, ownership, or risk.

Bypasses require a recorded reason and are never silent.

## Agents, Notes, Review, And Change Requests

Define custom roles:

- Roadmap planner
- Milestone planner
- Implementation orchestrator
- Worker
- Reviewer

The orchestrator executes one wave at a time, dispatching workers only for tasks that pass dependency and ownership checks. The reviewer runs after
each wave and again at closeout. Blocking findings prevent the next wave until fixed or explicitly deferred with a reason.

Worker notes are mandatory, append-only, and stored per milestone in Markdown entries with structured metadata. Each worker records completed work,
findings, decisions, issues/blockers, touched files, tests run, and residual risk. Notes are scoped by roadmap, milestone, plan, implementation wave,
task, and worker.

Include a decision register and risk register in v1. During later milestone planning, the planner must compare current roadmap intent with prior
decisions, risks, notes, amendments, and closeout evidence. If milestone learnings contradict the roadmap, the next milestone plan is blocked until a
roadmap amendment is approved.

Change requests are first-class. `/change:request` is allowed after implementation has produced changes, including reviewing, closeout, or complete
states. The change planner uses the original milestone plan, actual implementation notes, changed work, evidence bundle, and the user’s requested
delta as context. It creates a decision-complete change plan under the milestone. Edits reopen only after change-plan approval. Approved change
requests are implemented through `/milestone:implement`, use the same wave/ownership/review/evidence model, and append their own evidence bundle. Only
one active change request is allowed per milestone.

## Tests And Verification

The extension implementation plan should include:

- Bun unit tests for state parsing, strict validation, active pointer handling, slug uniqueness, and legal/illegal phase transitions.
- Fixture tests for roadmap approval gates, milestone planning gates, wave dependency validation, ownership overlap rejection, append-only notes,
  amendment approval requirements, bypass state, and change-request lifecycle.
- Hook validation tests or dry-run fixtures showing direct file writes are blocked when gates fail and allowed when gates pass.
- Report rendering tests for roadmap status, milestone health, open decisions, blockers, worker notes, next action, and evidence summaries.
- Local dogfood verification with `omp --extension ./roadmap-engineer` or `omp install ./roadmap-engineer`, then `omp -p '/extensions'` in a normal
  OMP environment.

## Explicit Defaults

No assumptions remain open. Locked defaults:

- First deliverable is a design spec, not implementation.
- Primary audience is you solo.
- Artifact root is `.roadmaps`.
- Artifact format is Markdown plus YAML frontmatter.
- IDs are human-readable slugs.
- Approval gates are roadmap approval and milestone plan approval, with evidence-gated closeout.
- Cleanup is approval-gated.
- Git commits are not required as workflow gates.
- Resume is state-driven: inspect artifacts, summarize current state, and propose the next legal action.
