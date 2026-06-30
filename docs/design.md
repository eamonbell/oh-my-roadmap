# roadmap-engineer Design

`roadmap-engineer` is a local OMP extension for complex feature and refactor workflows that are too large for one plan-to-implementation pass.

## Workflow Contract

The extension activates only when a roadmap command creates or resumes `.roadmaps/active.yml`. While no active roadmap exists, normal work is not gated.

When a roadmap is active, direct file-write tools are blocked unless the active state validates and the roadmap is in an approved implementation state. Mutating shell commands are not classified or blocked in v1; use them carefully.

The canonical phase sequence is:

```text
discovery -> roadmap_draft -> roadmap_approved -> milestone_planning -> milestone_approved -> implementing -> reviewing -> closeout -> complete
```

## Artifact Root

Config and state are stored under `.roadmaps`:

```text
.roadmaps/
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
- Roadmaps define concrete milestone outlines, not full implementation plans.
- Each roadmap milestone outline must include goal, scope, non-goals, evidence, dependencies, risks, acceptance intent, and verification intent.
- An approved roadmap can be reopened only from `roadmap_approved`, before any milestone or change request is active. Reopening records a required reason, returns to `roadmap_draft`, marks the roadmap not finalized, preserves approval history, and requires regeneration plus explicit reapproval.
- Milestone plans must be decision-complete before implementation starts.
- Milestone plans must include exact verification commands, acceptance criteria, concrete executable tasks, dependency analysis, execution waves, `worker-light`/`worker`/`worker-heavy` assignments, task-level verification, exclusive file/module ownership, and a passed wave-flow check before approval.
- Cleanup is approval-gated.

## Orchestration Rules

- No worktrees or isolated workspaces.
- All agents work on the active branch.
- Same-wave tasks cannot overlap owned files or modules.
- Each task must appear in exactly one wave.
- Task dependencies must reference known tasks in earlier waves and must not form cycles.
- Only one wave may be `running` or `reviewing`; later waves cannot start until earlier waves are complete.
- A worker that needs an unowned file/module must stop and append a blocking note.
- Workers and reviewers do not request user input directly; they append blocking notes for the orchestrator or main agent to resolve.
- Implementation orchestrators dispatch tasks to the exact worker role recorded on each task and do not write code themselves.
- Wave-flow checks run during planning before approval; implementation orchestrators do not perform wave-flow checks.
- Review runs after every wave and at closeout.
- Blocking review findings stop later waves until resolved or explicitly deferred.

Task, wave, and cursor progress is recorded with `roadmap_engineer_transition` operations `update_task_status`, `update_wave_status`, and `update_implementation_progress`. The extension does not schedule workers itself; orchestration remains prompt-guided and state-validated.

Implementation resume is driven by a persisted progress cursor on milestone and change plans. The cursor records the active wave, orchestration step, active task IDs, blocker reason, and timestamp. Status and resume commands treat this structured cursor as authoritative; notes provide context and evidence.

Mutating store operations use `.roadmaps/store.lock` to serialize concurrent writers and write YAML/Markdown state files through atomic replacement. Append-only notes are routed through the same lock so note ordering stays consistent with task, wave, and progress updates.

Large roadmap registers are reviewed through read-only context tools. `roadmap_engineer_read_state` returns compact structured state by default and exposes focused scopes for roadmap, active milestone, active change, and usage orientation. `roadmap_engineer_search_context` searches active-roadmap notes, roadmap sections, plan sections, roadmap-level decisions, and risks, returning snippets and metadata by default. `roadmap_engineer_read_context` expands selected result IDs with capped bodies. Planners, orchestrators, and reviewers should use this search-first workflow before reading full `.roadmaps` markdown files.

## Closeout Evidence

Milestone completion requires structured closeout evidence in `closeout.md`. Every acceptance criterion and verification command must have a result of `passed` or `deferred`. Deferred items require a reason and approver. Closeout must also confirm worker notes were reviewed, include a review summary, and list any unresolved risks with a disposition.

## Change Requests

`/change:request` is allowed after implementation has produced changes, including `reviewing`, `closeout`, or `complete`. A change request uses the original milestone plan, actual implementation notes, evidence, and the user request as planning context. Implementation reopens only after the change plan is approved.

Approved change requests may implement from `reviewing`, `closeout`, or `complete` without restoring a previous phase. Closing a change request records its own structured evidence bundle, marks the change `closed`, clears the active change pointer, and preserves the current roadmap phase. The completed milestone remains active so post-completion changes can still target it.
