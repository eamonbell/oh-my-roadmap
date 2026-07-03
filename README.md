# oh-my-roadmap

`oh-my-roadmap` is a local OMP extension for complex feature and refactor work. It forces large work through explicit roadmap, milestone, implementation-wave, review, evidence, and change-request gates.

The canonical workflow config and state live in `.omr`. Direct file-write tools are blocked while an active roadmap is outside an approved implementation state. V1 intentionally does not classify or block mutating shell commands.

The workflow is strict and state-driven:

```text
discovery -> roadmap_draft -> roadmap_approved -> milestone_planning -> milestone_approved -> implementing -> reviewing -> closeout -> complete
```

Milestone and change implementation progress is tracked through explicit task status, wave status, and a persisted implementation progress cursor. Closeout requires structured evidence for every acceptance criterion and verification command; each item must be `passed` or `deferred` with a reason and approver.

Planning and orchestrator prompts require user-facing agents to inspect relevant existing code and documentation, reference useful paths in artifacts, and use OMP's built-in `ask` tool to interview the user until material decisions and gaps are closed. Subagents record blockers in notes and do not request user input directly.

Agents should use compact `omr_read_state` scopes and `omr_search_context` to inspect active-roadmap notes, roadmap sections, plan sections, decisions, risks, issues, and review findings before reading large `.omr` artifacts directly. Search returns compact snippets by default; agents can call `omr_read_context` with selected result IDs when full entry detail is needed.

## Install

This repo publishes two user-facing packages to npm, plus `oh-my-roadmap-core` as their shared runtime dependency:

- **`@oh-my-roadmap/cli`** — a standalone CLI to scaffold project config and (re)generate agent definitions.
- **`oh-my-roadmap`** — the OMP extension (slash commands + tools). npm package names cannot be a bare scope such as `@oh-my-roadmap`.

```sh
# CLI
npm install -g @oh-my-roadmap/cli

# Extension — let the CLI install it into OMP's plugin root (auto-discovered, no --extension flag)
omr install --project        # <project>/.omp/plugins
omr install --global         # ~/.omp/agent/plugins

# Keep the CLI + extension current
omr update                   # check npm and update; add --check to only report
```

`omr install` writes `oh-my-roadmap` into the target OMP plugin root's `package.json` and installs it, so OMP discovers the extension automatically. `omr init`/`apply` also print a throttled notice when a newer CLI is available.

## Local Development

This is a Bun workspace monorepo (`packages/core`, `packages/extension`, `packages/cli`).

```sh
bun install
bun run verify          # tsc --noEmit across the workspace + bun test
bun run build           # bundle the omr CLI to packages/cli/dist/index.js
omp --extension packages/extension
```

In a normal OMP environment, confirm loading with:

```sh
omp -p '/extensions'
```

## Commands

- `omr init`
- `/omr:disable`
- `/omr:enable`
- `/omr:learn-style`
- `/omr:adhoc-new`
- `/omr:adhoc-plan`
- `/omr:adhoc-implement`
- `/omr:adhoc-status`
- `/omr:adhoc-close`
- `/omr:adhoc-cancel`
- `/omr:plan-details`
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

## Lockout

Run `/omr:disable` to pause oh-my-roadmap when you want to use plain plan mode or an unrelated agent without omr loading its skills or driving roadmap work. It sets `disabled: true` in the project `.omr/config.yml` and, if a roadmap is active, stamps `paused_at` on `.omr/active.yml`. While paused, the write-gate hook blocks every `omr_*` tool call and any `task` spawn targeting an omr agent, returning a message telling the agent omr is paused.

Run `/omr:enable` to resume: it clears the flag and stamps `resumed_at`. The next `/omr:rm-resume` is instructed to inspect the codebase for changes made while paused and resolve any that affect the active plan with you before continuing, then the pause markers are cleared.

## Ad-hoc Plans

Not every change warrants a full roadmap. `/omr:adhoc-new` starts a **roadmap-free** plan that still runs through the full structured flow — interview, concrete tasks and execution waves, a wave-flow check, approval, wave-orchestrated implementation with the same `worker`/`reviewer` agents, and closeout evidence. Ad-hoc state lives under `.omr/adhoc/<id>/` with its own `.omr/adhoc/active.yml` pointer; a roadmap and an ad-hoc plan cannot both be active.

Lifecycle: `adhoc_draft → adhoc_approved → implementing → reviewing → closeout → complete` (no change requests, reopen, or amendments — use a roadmap for that). The write-gate opens only while the ad-hoc plan is approved and implementing/reviewing, exactly like a milestone.

- `/omr:adhoc-new` — interview + create the plan (`omr_init_adhoc`), run the wave-flow check, and approve.
- `/omr:adhoc-plan` — revise the draft before approval.
- `/omr:adhoc-implement` — run the waves (reuses `omr_prepare_wave_dispatch`, `omr_record_wave_result`, `omr_prepare_wave_review`, `omr_record_wave_review`), then review and close out.
- `/omr:adhoc-status`, `/omr:adhoc-close`, `/omr:adhoc-cancel`.
- `/omr:plan-details` — a details overlay for the active ad-hoc plan, mirroring `/omr:rm-details`.

## Code Style

Run `/omr:learn-style` to teach oh-my-roadmap how your codebase is written. It dispatches a dedicated `style-scout` agent that inspects representative source files and records concise, per-language conventions (naming, formatting, quoting, error handling, and so on) into a `style:` map in `.omr/config.yml` via the `omr_set_style` tool. You can also hand-author `style:` entries in the global config.

Before writing code, worker agents call the `omr_style_guide` tool with the files they will edit; it returns the recorded guidance for those files' languages from the unified config. The guidance is advisory — reviewers do not fail a review solely for a style deviation.

## Project Init

Run `omr init` once to scaffold oh-my-roadmap files without starting a roadmap workflow. When run in a TTY it interactively prompts for a model id and reasoning level per agent role (leave blank to inherit OMP's defaults); non-interactively it scaffolds with inherited defaults.

`init` is scoped:

- `--project` (default) — writes `.omr/config.yml` (with the prompted models) and generates agents at `.omp/agents/`.
- `--global` — writes `~/.omp/oh-my-roadmap/config.yml` and generates user-level agents at `~/.omp/agent/agents/`, and also scaffolds a model-free `.omr/config.yml` in the current folder. Global and project configs are unified at load time, with project values overriding global.

The command creates the config when it is missing and always refreshes the generated OMP agent definitions:

```text
.omr/config.yml
.omp/agents/worker-light.md
.omp/agents/worker.md
.omp/agents/worker-heavy.md
.omp/agents/reviewer.md
.omp/agents/wave-flow-checker.md
.omp/agents/roadmap-milestone-checker.md
```

The `.omr/config.yml` file configures the model and thinking level used when OMP dispatches the generated worker, reviewer, wave-flow-checker, and roadmap-milestone-checker agents:

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

Both `model` and `thinking` are optional. Supported thinking values are `inherit`, `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Re-running `omr init` preserves existing role settings, adds any missing supported roles to `.omr/config.yml`, and overwrites generated `.omp/agents/*.md` files from the extension templates.

`omr init` does not create or modify active roadmap workflow state.

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

Store mutations are serialized through `.omr/store.lock` and state files are written with atomic replacement to reduce lost updates from concurrent agents or tool calls.

## Roadmap Reopen

`/omr:rm-reopen` is allowed only while the active roadmap is still in `roadmap_approved`, before milestone planning starts. It records a required reason in `decisions.md`, moves the roadmap back to `roadmap_draft`, marks the generated roadmap as not finalized, and preserves previous approval history. The agent must regenerate the full structured roadmap with `omr_update_roadmap`, validate it, ask for explicit reapproval, and approve it again before milestone planning can continue.

## Verification

```sh
bun run check
bun test
bun run verify
```

In a normal OMP environment, use `omp --extension packages/extension -p '/extensions'` to confirm the extension loads and the `omr_*` tools are registered.
