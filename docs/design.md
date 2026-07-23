# oh-my-roadmap Design

`oh-my-roadmap` is a local OMP extension for complex feature and refactor workflows that are too large for one plan-to-implementation pass.

## Workflow Contract

The extension activates only when a roadmap command creates or resumes `.omr/active.yml`. While no active roadmap exists, normal work is not gated.

When a roadmap is active, direct file-write tools are blocked unless the active state validates and the roadmap is in an approved implementation state. Mutating shell commands are not classified or blocked in v1; use them carefully.

The canonical phase sequence is:

```text
discovery -> roadmap_draft -> roadmap_approved -> milestone_planning -> milestone_approved -> implementing -> reviewing -> closeout -> complete
```

## Artifact Root

Config and state are stored under `.omr`:

```text
.omr/
  config.yml
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

## Planning Rules

- Roadmap approval requires recorded repo discovery.
- External research must be recorded when discovery identifies current-docs or external-API risk.
- Phase transitions are strict; agents must record discovery, approve the roadmap, plan and approve a milestone, implement, review, close out, then complete in order.
- Planning agents must use the built-in `ask` tool to interview the user until material decisions, tradeoffs, approvals, gaps, and open questions are closed.
- Roadmap, milestone, change, review, and closeout artifacts should reference relevant existing code and documentation paths when those references help future agents understand the plan.
- Roadmap approval requires a finalized generated `roadmap.md` from structured state.
- Roadmap approval also requires a passed roadmap-milestone-checker result recorded after the latest generated roadmap; failed checks require roadmap revision and rerun before approval.
- Roadmaps define concrete milestone outlines, not full implementation plans.
- Each roadmap milestone outline must include goal, scope, non-goals, evidence, dependencies, risks, acceptance intent, and verification intent.
- Each roadmap milestone must contain multiple meaningful deliverables or workstreams that belong together; do not create a milestone for a single small edit, isolated cleanup, or one narrow task that should be folded into another milestone.
- An approved roadmap can be reopened only from `roadmap_approved`, before any milestone or change request is active. Reopening records a required reason, returns to `roadmap_draft`, marks the roadmap not finalized, preserves approval history, and requires regeneration plus explicit reapproval.
- Milestone plans must be decision-complete before implementation starts.
- Milestone plans must include exact verification commands, acceptance criteria, concrete executable tasks, dependency analysis, execution waves, `worker-light`/`worker`/`worker-heavy` assignments, task-level verification, exclusive file/module ownership, and a passed wave-flow check before approval.
- Cleanup is approval-gated.

## Orchestration Rules

- No worktrees or isolated workspaces.
- All agents work on the active branch.
- Ownership is exclusive only within a wave: concurrent same-wave tasks cannot overlap owned files or modules.
- Cross-wave file edits are permitted. Because only one wave runs at a time (waves run strictly sequentially), a task may edit files owned by another wave when its work requires it — those waves are already complete or not yet started, so no concurrent worker holds their files. This is a normal staged-refactor pattern.
- Each task must appear in exactly one wave.
- Task dependencies must reference known tasks in earlier waves and must not form cycles.
- Only one wave may be `running` or `reviewing`; later waves cannot start until earlier waves are complete.
- A worker only stops and appends a blocking note for something genuinely outside the plan or an ambiguous required decision — not merely because a file belongs to another wave.
- Workers and reviewers do not request user input directly; they append blocking notes for the orchestrator or main agent to resolve.
- Implementation orchestrators dispatch tasks to the exact worker role recorded on each task and do not write code themselves.
- Wave-flow checks run during planning before approval; implementation orchestrators do not perform wave-flow checks.
- Review runs after every wave and at closeout.
- Blocking review findings stop later waves until resolved or explicitly deferred.
- Recovery and rework are hub-first: the orchestrator prefers waking the existing worker (which still holds its transcript and context) over spawning a replacement, coordinating through OMP's unified `hub` tool (peer messaging + job control; `hub op:list`/`op:send`/`op:wait`). On a transient/transport failure it resumes the worker in place; for review findings the original worker can fix, it wakes the worker to rework in-context and re-reviews, reserving canonical blockers for findings that need a user decision. It spawns a replacement only when the worker is aborted/non-revivable, is no longer a live peer (e.g. a resumed session), or delivery fails. Transport/socket errors are recorded as `transport_failed`, never as blockers. See [`irc.md`](./irc.md) for the full coordination playbook.

Task, wave, and cursor progress is recorded with `omr_transition` operations `update_task_status`, `update_wave_status`, and `update_implementation_progress`. The extension does not schedule workers itself; orchestration remains prompt-guided and state-validated.

Implementation resume is driven by a persisted progress cursor on milestone and change plans. The cursor records the active wave, orchestration step, active task IDs, blocker reason, and timestamp. Status and resume commands treat this structured cursor as authoritative; notes provide context and evidence.

Mutating store operations use `.omr/store.lock` to serialize concurrent writers and write YAML/Markdown state files through atomic replacement. Append-only notes are routed through the same lock so note ordering stays consistent with task, wave, and progress updates.

Large roadmap registers are reviewed through read-only context tools. `omr_read_state` returns compact structured state by default and exposes focused scopes for roadmap, active milestone, active change, and usage orientation. `omr_search_context` searches active-roadmap notes, roadmap sections, plan sections, roadmap-level decisions, and risks, returning snippets and metadata by default. `omr_read_context` expands selected result IDs with capped bodies. Planners, orchestrators, and reviewers should use this search-first workflow before reading full `.omr` markdown files.

## Closeout Evidence

Milestone completion requires structured closeout evidence in `closeout.md`. Every acceptance criterion and verification command must have a result of `passed` or `deferred`. Deferred items require a reason and approver. Closeout must also confirm worker notes were reviewed, include a review summary, and list any unresolved risks with a disposition.

## Change Requests

`/omr:chg-request` is allowed after implementation has produced changes, including `reviewing`, `closeout`, or `complete`. A change request uses the original milestone plan, actual implementation notes, evidence, and the user request as planning context. Implementation reopens only after the change plan is approved.

Approved change requests may implement from `reviewing`, `closeout`, or `complete` without restoring a previous phase. Closing a change request records its own structured evidence bundle, marks the change `closed`, clears the active change pointer, and preserves the current roadmap phase. The completed milestone remains active so post-completion changes can still target it.

## Ad-hoc Plans

Ad-hoc plans are a roadmap-free, lightweight path for changes that benefit from structured plan → implement → review → closeout but do not warrant a roadmap. They are a separate entity, not a roadmap flavor, but reuse the full implementation machinery.

- State lives under `.omr/adhoc/<id>/` (`plan.md` definition + `runtime.yml` task/wave/progress cursor), with a dedicated `.omr/adhoc/active.yml` pointer. The roadmap `active.yml` is untouched.
- A roadmap and an ad-hoc plan cannot both be active; `createAdhocPlan` refuses when either is active, and validation raises `adhoc.conflict` if both pointers exist.
- Lifecycle: `adhoc_draft → adhoc_approved → implementing → reviewing → closeout → complete`. No change requests, reopen, or amendments — those remain roadmap-only.
- Quality gates match milestones: a wave-flow check must pass before approval, and closeout requires structured evidence for every acceptance criterion and verification command.
- The write-gate opens only while the ad-hoc plan is approved and in `implementing`/`reviewing`, using the same `DIRECT_FILE_WRITE_TOOLS` gate as roadmaps.
- Wave orchestration is shared: every wave tool resolves the active plan through `activePlanContext`, which returns the ad-hoc plan (scoped by its id) when no roadmap is active. The same `worker`/`reviewer` agents are dispatched; no new agent roles exist. Status updates route through `transition` to the ad-hoc runtime, and blockers/notes are scoped by the ad-hoc id.
- `/omr:plan-details` renders the active ad-hoc plan through the same details overlay as `/omr:rm-details`.

## Execution Budgets

Execution budgets are optional, active-scope ceilings for `tokens`, `cost`, and `time`. The roadmap ceiling is stored in `.omr/<roadmap-id>/budget.yml`; the active milestone ceiling is stored in `.omr/<roadmap-id>/milestones/<milestone-id>/budget.yml`. Each file contains ceilings, an append-only override audit trail, and time tracking. A missing file or a file with no ceilings and no overrides has no enforcement or report effect.

Budget mutations resolve the active roadmap or milestone and perform the complete read-modify-write sequence under `.omr/store.lock`; the underlying YAML replacement is atomic. A normal set can create, lower, repeat, or clear a ceiling, but it cannot raise an existing finite ceiling. An audited raise records the prior and new ceiling, actor, reason, and timestamp. A one-shot continue records its actor, reason, timestamp, and later consumption state.

Thresholds are project configuration, not budget ceilings:

```yaml
budgets:
  thresholds:
    warn: 75
    soft: 90
    hard: 100
```

Thresholds are percentages of consumed budget. If omitted, warn is 75, soft is disabled, and hard is 100. An unlimited dimension never breaches. Warn is surfaced in reports and next-action text. Soft pauses new-wave dispatch at the boundary; hard refuses it. Raising the ceiling can clear either condition. A one-shot can resume a soft pause without being consumed; at a hard breach it allows exactly one new-wave dispatch and is then consumed.

The extension registers `/omr:budget-show`, `/omr:budget-set`, and `/omr:budget-override` as native command handlers. They parse and mutate state directly, then deliver a custom command-result message; they do not ask the model to execute a budget operation. Their summaries use `Budget roadmap <dimension>` or `Budget milestone <id> <dimension>` labels and include spent, ceiling, remaining, percentage, and threshold level. When one or more request costs are unavailable, a cost summary deliberately reports its remaining amount, percentage, and level as `unknown`.

When a terminal findings report is rendered in a UI, it automatically appends a `## Budget` section if any active budget ceiling or override is reportable. Existing findings text is unchanged when no budgets are configured. If no UI is available, the report tile is not rendered.
