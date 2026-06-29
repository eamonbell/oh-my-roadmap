# roadmap-engineer Design

`roadmap-engineer` is a local OMP extension for complex feature and refactor workflows that are too large for one plan-to-implementation pass.

## Workflow Contract

The extension activates only when a roadmap command creates or resumes `.roadmaps/active.yml`. While no active roadmap exists, normal work is not gated.

When a roadmap is active, direct file-write tools are blocked unless the active state validates and the roadmap is in `implementing` or `reviewing`. Mutating shell commands are not classified or blocked in v1; use them carefully.

The canonical phase sequence is:

```text
discovery -> roadmap_draft -> roadmap_approved -> milestone_planning -> milestone_approved -> implementing -> reviewing -> closeout -> complete
```

## Artifact Root

State is stored under `.roadmaps`:

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

## Planning Rules

- Roadmap approval requires recorded repo discovery.
- External research must be recorded when discovery identifies current-docs or external-API risk.
- Roadmaps define phased intent, not full implementation details.
- Milestone plans must be decision-complete before implementation starts.
- Milestone plans must include exact verification commands, acceptance criteria, dependency analysis, execution waves, worker assignments, and exclusive file/module ownership.
- Cleanup is approval-gated.

## Orchestration Rules

- No worktrees or isolated workspaces.
- All agents work on the active branch.
- Same-wave tasks cannot overlap owned files or modules.
- A worker that needs an unowned file/module must stop and append a blocking note.
- Review runs after every wave and at closeout.
- Blocking review findings stop later waves until resolved or explicitly deferred.

## Change Requests

`/change:request` is allowed after implementation has produced changes, including `reviewing`, `closeout`, or `complete`. A change request uses the original milestone plan, actual implementation notes, evidence, and the user request as planning context. Implementation reopens only after the change plan is approved.

