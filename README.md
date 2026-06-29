# roadmap-engineer

`roadmap-engineer` is a local OMP extension for complex feature and refactor work. It forces large work through explicit roadmap, milestone, implementation-wave, review, evidence, and change-request gates.

The canonical workflow state lives in `.roadmaps`. Direct file-write tools are blocked while an active roadmap is outside an approved implementation state. V1 intentionally does not classify or block mutating shell commands.

The workflow is strict and state-driven:

```text
discovery -> roadmap_draft -> roadmap_approved -> milestone_planning -> milestone_approved -> implementing -> reviewing -> closeout -> complete
```

Milestone and change implementation progress is tracked through explicit task and wave status updates. Closeout requires structured evidence for every acceptance criterion and verification command; each item must be `passed` or `deferred` with a reason and approver.

Planning prompts and role skills require agents to inspect relevant existing code and documentation, reference useful paths in artifacts, and use OMP's built-in `ask` tool to interview the user until material decisions and gaps are closed.

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

## Verification

```sh
bun run check
bun test
bun run verify
```

In a normal OMP environment, use `omp --extension . -p '/extensions'` to confirm the extension loads and the `roadmap_engineer_*` tools are registered.
