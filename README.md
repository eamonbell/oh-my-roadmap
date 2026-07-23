# oh-my-roadmap

`oh-my-roadmap` is a local OMP extension for complex feature and refactor work. It forces large work through explicit roadmap, milestone, implementation-wave, review, evidence, and change-request gates.

The canonical workflow config and state live in `.omr`. Direct file-write tools are blocked while an active roadmap is outside an approved implementation state. V1 intentionally does not classify or block mutating shell commands.

The workflow is strict and state-driven:

```text
discovery -> roadmap_draft -> roadmap_approved -> milestone_planning -> milestone_approved -> implementing -> reviewing -> closeout -> complete
```

Milestone and change implementation progress is tracked through explicit task status, wave status, and a persisted implementation progress cursor. Closeout requires structured evidence for every acceptance criterion and verification command; each item must be `passed` or `deferred` with a reason and approver.

Planning and orchestrator prompts require user-facing agents to inspect relevant existing code and documentation, reference useful paths in artifacts, and use OMP's built-in `ask` tool to interview the user until material decisions and gaps are closed. Subagents record blockers in notes and do not request user input directly. Not every blocking finding needs a user: reviewers submit severity-tagged findings, and only ones that genuinely need a user decision open a canonical blocker — a finding a worker can just fix instead becomes a rework-queue item that gets dispatched back to a worker and re-reviewed.

Workers always run LSP diagnostics on every file they touch before yielding, and — in a single-worker wave or a genuine rework — may also run their own task's verification commands against their owned files, recording the exact commands as receipts in their note. An implementation orchestrator records a verification baseline once at the start of implementation (`omr_record_verification_baseline`) so reviewers judge each wave against it (no new failures) rather than an absolute full-suite-green bar.

Agents should use compact `omr_read_state` scopes and `omr_search_context` to inspect active-roadmap notes, roadmap sections, plan sections, decisions, risks, issues, and review findings before reading large `.omr` artifacts directly. Search returns compact snippets by default; agents can call `omr_read_context` with selected result IDs when full entry detail is needed.

## Repository and Task Context

OMR maintains a project-wide repository primer at `.omr/repo-primer.yml`. Roadmap initialization creates or refreshes this bounded, fingerprinted inventory of detected manifests and package managers, workspace members, test and module roots, runnable test/build/typecheck commands, and repository guidance. Planner, dispatch, and review paths lazily refresh it when needed; an unchanged fingerprint preserves the existing artifact and timestamp.

Every milestone, change-request, and ad-hoc task also carries required `relevant_existing_code` and `shared_interface_contracts` arrays. Planning validates repository-relative paths and existing signatures. A planned interface must name the strictly earlier task that owns its future source through `planned_by_task_id`.

`omr_prepare_wave_dispatch` places verified task references, resolved interface contracts, matching scout findings, style guidance, and the compact primer in each assignment's `seeded_context`. `omr_prepare_wave_review` supplies the same categories as one bounded, deduplicated active-wave package, plus an informational `remaining_waves` map. Live repository code remains authoritative: stale, missing, mismatched, outside-repository, unavailable, or truncated context is omitted or identified by a typed warning. These context warnings do not block planning, dispatch, or review; workers and reviewers inspect live sources when a warning or uncovered gap requires it.

If primer refresh fails, OMR delivers the last good primer with a `primer_refresh_failed` warning when one exists; otherwise it omits the primer with `primer_unavailable`. A changed relevant-code mtime yields `stale_source`, while a live interface whose normalized signature no longer matches yields `signature_mismatch`. None of these warnings changes the workflow gate.

## Install

This repo publishes two user-facing packages to npm, plus `oh-my-roadmap-core` as their shared runtime dependency:

- **`@oh-my-roadmap/cli`** — a standalone CLI to scaffold project config and (re)generate agent definitions.
- **`oh-my-roadmap`** — the OMP extension (slash commands + tools). npm package names cannot be a bare scope such as `@oh-my-roadmap`.

> **Requires OMP 17.0.0 or newer.** The extension's `omr_*` tools ride OMP's `xd://` discoverable-tool transport, and worker coordination uses the
> unified `hub` tool — both introduced in OMP 17.0.0.

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

Workers and reviewers receive the applicable recorded conventions in `seeded_context.style_guidance`; an explicit “No recorded code-style guidance for these files.” is authoritative, so they do not repeat a style lookup. The guidance is advisory — reviewers do not fail a review solely for a style deviation.

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

The `.omr/config.yml` file configures the model, thinking level, and optional prewalk hand-off used when OMP dispatches the generated worker, reviewer, wave-flow-checker, and roadmap-milestone-checker agents:

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
    prewalk: true                     # optional: plan on the resolved model, then hand off at first edit
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

`model`, `thinking`, and `prewalk` are all optional. Supported thinking values are `inherit`, `auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` (`auto` lets OMP classify per turn). `prewalk` (default off) opts a role into OMP's prewalk hand-off — `true` starts the agent on its resolved model to plan and begins implementing, then hands off to the default prewalk target at its first edit/write; a string sets a custom target model pattern. Re-running `omr init` preserves existing role settings, adds any missing supported roles to `.omr/config.yml`, and overwrites generated `.omp/agents/*.md` files from the extension templates.

`omr init` does not create or modify active roadmap workflow state.

## Moshi notifications

oh-my-roadmap can drive a **live activity** in a local [Moshi](https://github.com/rjyo/homebrew-moshi) daemon so you can watch each workflow progress from Moshi's inbox. It is opt-in and off by default: with no `moshi` config present, the extension has zero notification behavior.

The integration talks to Moshi's documented local-socket `session.update` protocol over a Unix socket. It does **not** require Moshi API tokens, host secrets, or host ids in OMR config, and it never falls back to any HTTP endpoint. A "live activity" in Moshi is the single inbox row per session that updates in place; OMR walks that row through each workflow's phases, sharing the OMP session's id, so it **enriches** the same row Moshi's built-in OMP hook maintains rather than creating a duplicate.

**Coverage.** OMR emits phase-level updates for all three workflows plus the existing wave/worker detail during implementation:

- **New roadmap** — created → discovery recorded → finalized → gate passed/failed → approved → milestone planning.
- **Milestone plan + implement** — plan created/revised → wave-flow gate → approved → implementing → per-wave dispatch/worker/review → reviewing → closeout → milestone complete.
- **Ad-hoc plan + implement** — created → gate → approved → implementing → (shared wave detail) → reviewing → closeout → complete/cancelled.

See [docs/moshi-live-activity.md](docs/moshi-live-activity.md) for the full flow diagrams.

**Progress in the title.** The row title carries live progress so you can follow the flow: `planning N/6` through the six planning stages (start, explore, interview, plan, checker, approval — the counter advances at the plan/checker/approval checkpoints), then `implementing NN%` where the percentage covers `start + every worker task + every wave review + closeout`.

**Quiet vs. push.** Routine progress (starts, phase moves, dispatch) updates the row quietly. Only **needs-input** (asks, blockers, failed gates, bypass requests) and **completions** (milestone/ad-hoc complete, wave review passed) are high-priority pushes to your device.

**Terminal binding & context gauge.** Frames carry tmux/herdr/zellij correlation fields (resolved once, best-effort) so the activity attaches to the right pane, plus a `contextRemaining` gauge — matching Moshi's own client.

**Debugging.** Set `moshi.trace: true` (or `OMR_MOSHI_TRACE=1`) to append a per-project decision trace to `.omr/logs/moshi.ndjson` — one JSON record per line for each considered/mapped/suppressed/sending/sent/failed step. Off by default; hand that file over when a notification misbehaves.

Prerequisites:

- Install, pair, and run Moshi's daemon: `moshi-hook pair --token <pairing-token>` then `moshi-hook serve` (or `brew services start moshi-hook`).
- When using OMP profiles, install OMR into the desired profile: `omr install --global --profile <name>`.
- Enable it per project or per profile with `moshi.enabled: true` in `.omr/config.yml` or `<ompRoot>/profiles/<profile>/oh-my-roadmap/config.yml`.

Enable for a profile (profile-global config):

```yaml
moshi:
  enabled: true
```

Enable or override for a project (applies to every profile that runs in that project):

```yaml
moshi:
  enabled: true
  socket_path: "/Users/eamon/Library/Application Support/Moshi/moshi-hook.sock"
```

Disable a profile-global opt-in for a specific project:

```yaml
moshi:
  enabled: false
```

`socket_path` is optional; when omitted the platform default Moshi socket is used, and `MOSHI_SOCKET_PATH` in the environment can override it. Config is merged global-then-project, so a project can enable, adjust the socket, or disable a profile-global opt-in.

Notes:

- Approval/question notifications are **notify-only**: they tell you to return to OMP and cannot approve, deny, or answer from Moshi.
- OMR sends only its own OMR-specific updates and does not duplicate Moshi's generated generic OMP lifecycle hook — that hook says a turn ended; OMR's updates say what each workflow is doing and needs next. Because both write to the same session row, Moshi's built-in `AgentEnd` hook may occasionally overwrite the OMR title at turn end.

## Roadmap Approval

`/omr:rm-new` creates draft roadmap state, records discovery, then must finalize the generated roadmap with `omr_update_roadmap` before approval. Approval is blocked unless the roadmap includes concrete goals, success criteria, constraints, non-goals, context, evidence, risks, and at least one roadmap-level milestone outline.

After the generated roadmap is written, roadmap-milestone-checker must pass before roadmap approval; failed findings require revising and regenerating the roadmap, rerunning the checker, and recording the new result.

Roadmap-level milestone outlines are not milestone plans. They describe each milestone's goal, scope, non-goals, evidence, dependencies, risks, acceptance intent, and verification intent. Each outline should group multiple meaningful deliverables or workstreams that belong together; a single small edit or one narrow task should be folded into a neighboring milestone instead of becoming its own roadmap gate. Symmetrically, prefer the smallest number of milestones that still keeps each one independently plannable and reviewable — merge any milestone likely to yield fewer than about 3 waves or 5 tasks with its neighbor; a single-milestone roadmap is legitimate when the work is one coherent body of change. The roadmap-milestone-checker flags likely over-fragmentation as an advisory finding, not a hard failure. `/omr:ms-plan` later expands one approved roadmap milestone into concrete implementation tasks, dependency analysis, waves, ownership, worker-light/worker/worker-heavy assignments, acceptance criteria, task-level verification, a wave-flow check, and the initial pause/resume progress cursor.

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
