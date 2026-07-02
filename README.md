# oh-my-roadmap

`oh-my-roadmap` is a local OMP extension for complex feature and refactor work. It forces large work through explicit roadmap, milestone, implementation-wave, review, evidence, and change-request gates.

The canonical workflow config and state live in `.roadmaps`. Direct file-write tools are blocked while an active roadmap is outside an approved implementation state. V1 intentionally does not classify or block mutating shell commands.

The workflow is strict and state-driven:

```text
discovery -> roadmap_draft -> roadmap_approved -> milestone_planning -> milestone_approved -> implementing -> reviewing -> closeout -> complete
```

Milestone and change implementation progress is tracked through explicit task status, wave status, and a persisted implementation progress cursor. Closeout requires structured evidence for every acceptance criterion and verification command; each item must be `passed` or `deferred` with a reason and approver.

Planning and orchestrator prompts require user-facing agents to inspect relevant existing code and documentation, reference useful paths in artifacts, and use OMP's built-in `ask` tool to interview the user until material decisions and gaps are closed. Subagents record blockers in notes and do not request user input directly.

Agents should use compact `omr_read_state` scopes and `omr_search_context` to inspect active-roadmap notes, roadmap sections, plan sections, decisions, risks, issues, and review findings before reading large `.roadmaps` artifacts directly. Search returns compact snippets by default; agents can call `omr_read_context` with selected result IDs when full entry detail is needed.

## Install

This repo publishes two packages to npm:

- **`omr-cli`** — a standalone CLI to scaffold project config and (re)generate agent definitions.
- **`oh-my-roadmap`** — the OMP extension (slash commands + tools).

```sh
# CLI
npm install -g omr-cli        # or: bunx omr-cli init

# Extension (install into a project, then load with OMP)
npm install oh-my-roadmap
omp --extension ./node_modules/oh-my-roadmap
```

## Local Development

This is a Bun workspace monorepo (`packages/core`, `packages/extension`, `packages/cli`).

```sh
bun install
bun run verify          # tsc --noEmit across the workspace + bun test
bun run build           # bundle omr-cli to packages/cli/dist/index.js
omp --extension packages/extension
```

In a normal OMP environment, confirm loading with:

```sh
omp -p '/extensions'
```

## Commands

- `omr-cli init`
- `/omr:rm-new`
- `/omr:rm-resume`
- `/omr:rm-status`
- `/omr:rm-amend`
- `/omr:rm-reopen`
- `/omr:ms-plan`
- `/omr:ms-implement`
- `/omr:ms-status`
- `/omr:ms-close`
- `/omr:byp-request`
- `/omr:byp-clear`
- `/omr:chg-request`
- `/omr:chg-status`
- `/omr:chg-close`
- `/omr:fnd-clear`

Run `/omr:fnd-clear` to dismiss the active findings report tile; it does not change roadmap state.

## Project Init

Run `omr-cli init` once in a project to scaffold oh-my-roadmap project files without starting a roadmap workflow. The command creates `.roadmaps/config.yml` when it is missing and always refreshes the local OMP agent definitions:

```text
.roadmaps/config.yml
.omp/agents/worker-light.md
.omp/agents/worker.md
.omp/agents/worker-heavy.md
.omp/agents/reviewer.md
.omp/agents/wave-flow-checker.md
.omp/agents/roadmap-milestone-checker.md
```

The `.roadmaps/config.yml` file configures the model and thinking level used when OMP dispatches the generated worker, reviewer, wave-flow-checker, and roadmap-milestone-checker agents:

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
  roadmap-milestone-checker:
    model: "provider/checker-model-or-role"
    thinking: "medium"
```

Both `model` and `thinking` are optional. Supported thinking values are `inherit`, `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Re-running `omr-cli init` preserves existing role settings, adds any missing supported roles to `.roadmaps/config.yml`, and overwrites generated `.omp/agents/*.md` files from the extension templates. Legacy `.roadmap/config.yml` files are ignored.

`omr-cli init` does not create or modify active roadmap workflow state.

## Roadmap Approval

`/omr:rm-new` creates draft roadmap state, records discovery, then must finalize the generated roadmap with `omr_update_roadmap` before approval. Approval is blocked unless the roadmap includes concrete goals, success criteria, constraints, non-goals, context, evidence, risks, and at least one roadmap-level milestone outline.

After the generated roadmap is written, roadmap-milestone-checker must pass before roadmap approval; failed findings require revising and regenerating the roadmap, rerunning the checker, and recording the new result.

Roadmap-level milestone outlines are not milestone plans. They describe each milestone's goal, scope, non-goals, evidence, dependencies, risks, acceptance intent, and verification intent. Each outline should group multiple meaningful deliverables or workstreams that belong together; a single small edit or one narrow task should be folded into a neighboring milestone instead of becoming its own roadmap gate. `/omr:ms-plan` later expands one approved roadmap milestone into concrete implementation tasks, dependency analysis, waves, ownership, worker-light/worker/worker-heavy assignments, acceptance criteria, task-level verification, a wave-flow check, and the initial pause/resume progress cursor.

## Pause And Resume

Milestone and change plans persist the current implementation cursor:

- active wave
- orchestration step
- active task IDs
- blocker reason, when blocked

`/omr:rm-resume`, `/omr:rm-status`, `/omr:ms-status`, and `/omr:chg-status` treat this structured cursor as the source of truth. Worker and review notes provide supporting context, but they do not override the persisted cursor.

Store mutations are serialized through `.roadmaps/store.lock` and state files are written with atomic replacement to reduce lost updates from concurrent agents or tool calls.

## Roadmap Reopen

`/omr:rm-reopen` is allowed only while the active roadmap is still in `roadmap_approved`, before milestone planning starts. It records a required reason in `decisions.md`, moves the roadmap back to `roadmap_draft`, marks the generated roadmap as not finalized, and preserves previous approval history. The agent must regenerate the full structured roadmap with `omr_update_roadmap`, validate it, ask for explicit reapproval, and approve it again before milestone planning can continue.

## Verification

```sh
bun run check
bun test
bun run verify
```

In a normal OMP environment, use `omp --extension packages/extension -p '/extensions'` to confirm the extension loads and the `omr_*` tools are registered.
