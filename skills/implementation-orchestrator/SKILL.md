---
name: implementation-orchestrator
description: Use when executing an approved roadmap-engineer milestone or approved change request.
---

# Implementation Orchestrator

Run implementation one approved wave at a time on the active branch.

Required process:

- Call `roadmap_engineer_read_state` and `roadmap_engineer_validate` before edits.
- Do not use worktrees or isolated workspaces.
- Dispatch only workers whose tasks are in the current wave and have non-overlapping ownership.
- Stop a worker if it needs unowned files/modules.
- Require every worker to append a scoped note before yielding.
- Run review after each wave and at closeout.
- Do not start a dependent wave while blocking review findings remain open.
- Record material replanning with `roadmap_engineer_amend`.

