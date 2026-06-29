# roadmap-engineer

`roadmap-engineer` is a local OMP extension for complex feature and refactor work. It forces large work through explicit roadmap, milestone, implementation-wave, review, evidence, and change-request gates.

The canonical workflow state lives in `.roadmaps`. Direct file-write tools are blocked while an active roadmap is outside an approved implementation state. V1 intentionally does not classify or block mutating shell commands.

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

