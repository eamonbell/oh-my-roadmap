# roadmap-engineer

`roadmap-engineer` is a local OMP extension for complex feature and refactor work. It forces large work through explicit roadmap, milestone, implementation-wave, review, evidence, and change-request gates.

The canonical workflow config and state live in `.roadmaps`. Direct file-write tools are blocked while an active roadmap is outside an approved implementation state. V1 intentionally does not classify or block mutating shell commands.

The workflow is strict and state-driven:

```text
discovery -> roadmap_draft -> roadmap_approved -> milestone_planning -> milestone_approved -> implementing -> reviewing -> closeout -> complete
```

Milestone and change implementation progress is tracked through explicit task status, wave status, and a persisted implementation progress cursor. Closeout requires structured evidence for every acceptance criterion and verification command; each item must be `passed` or `deferred` with a reason and approver.

Planning and orchestrator prompts require user-facing agents to inspect relevant existing code and documentation, reference useful paths in artifacts, and use OMP's built-in `ask` tool to interview the user until material decisions and gaps are closed. Subagents record blockers in notes and do not request user input directly.

Agents should use compact `roadmap_engineer_read_state` scopes and `roadmap_engineer_search_context` to inspect active-roadmap notes, roadmap sections, plan sections, decisions, risks, issues, and review findings before reading large `.roadmaps` artifacts directly. Search returns compact snippets by default; agents can call `roadmap_engineer_read_context` with selected result IDs when full entry detail is needed.

## Local Use

```sh
bun install
bun run verify
omp --extension .
```

In a normal OMP environment, confirm loading with:

```sh
omp -p '/extensions'
```

## Commands

- `/roadmap:init`
- `/roadmap:new`
- `/roadmap:resume`
- `/roadmap:status`
- `/roadmap:amend`
- `/roadmap:reopen`
- `/milestone:plan`
- `/milestone:implement`
- `/milestone:status`
- `/milestone:close`
- `/bypass:request`
- `/bypass:clear`
- `/change:request`
- `/change:status`
- `/change:close`

## Project Init

Run `/roadmap:init` once in a project to scaffold roadmap-engineer project files without starting a roadmap workflow. The command creates `.roadmaps/config.yml` when it is missing and always refreshes the local OMP agent definitions:

```text
.roadmaps/config.yml
.omp/agents/worker-light.md
.omp/agents/worker.md
.omp/agents/worker-heavy.md
.omp/agents/reviewer.md
.omp/agents/wave-flow-checker.md
```

The `.roadmaps/config.yml` file configures the model and thinking level used when OMP dispatches the generated worker, reviewer, and wave-flow-checker agents:

```yaml
agents:
  worker-light:
    model: "provider/light-model-or-role"
    thinking: "minimal"
  worker:
    model: "provider/model-or-role"
    thinking: "medium"
  worker-heavy:
    model: "provider/heavy-model-or-role"
    thinking: "high"
  reviewer:
    model: "provider/model-or-role"
    thinking: "high"
  wave-flow-checker:
    model: "provider/checker-model-or-role"
    thinking: "medium"
```

Both `model` and `thinking` are optional. Supported thinking values are `inherit`, `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Re-running `/roadmap:init` preserves existing role settings, adds any missing supported roles to `.roadmaps/config.yml`, and overwrites generated `.omp/agents/*.md` files from the extension templates. Legacy `.roadmap/config.yml` files are ignored.

`/roadmap:init` does not create or modify active roadmap workflow state.

## Roadmap Approval

`/roadmap:new` creates draft roadmap state, records discovery, then must finalize the generated roadmap with `roadmap_engineer_update_roadmap` before approval. Approval is blocked unless the roadmap includes concrete goals, success criteria, constraints, non-goals, context, evidence, risks, and at least one roadmap-level milestone outline.

Roadmap-level milestone outlines are not milestone plans. They describe each milestone's goal, scope, non-goals, evidence, dependencies, risks, acceptance intent, and verification intent. `/milestone:plan` later expands one approved roadmap milestone into concrete implementation tasks, dependency analysis, waves, ownership, worker-light/worker/worker-heavy assignments, acceptance criteria, task-level verification, a wave-flow check, and the initial pause/resume progress cursor.

## Pause And Resume

Milestone and change plans persist the current implementation cursor:

- active wave
- orchestration step
- active task IDs
- blocker reason, when blocked

`/roadmap:resume`, `/roadmap:status`, `/milestone:status`, and `/change:status` treat this structured cursor as the source of truth. Worker and review notes provide supporting context, but they do not override the persisted cursor.

Store mutations are serialized through `.roadmaps/store.lock` and state files are written with atomic replacement to reduce lost updates from concurrent agents or tool calls.

## Roadmap Reopen

`/roadmap:reopen` is allowed only while the active roadmap is still in `roadmap_approved`, before milestone planning starts. It records a required reason in `decisions.md`, moves the roadmap back to `roadmap_draft`, marks the generated roadmap as not finalized, and preserves previous approval history. The agent must regenerate the full structured roadmap with `roadmap_engineer_update_roadmap`, validate it, ask for explicit reapproval, and approve it again before milestone planning can continue.

## Verification

```sh
bun run check
bun test
bun run verify
```

In a normal OMP environment, use `omp --extension . -p '/extensions'` to confirm the extension loads and the `roadmap_engineer_*` tools are registered.
