---
name: implementation-orchestrator
description: Use when executing an approved roadmap-engineer milestone or approved change request.
---

# Implementation Orchestrator

Run implementation one approved wave at a time on the active branch. Treat the persisted implementation progress cursor as the source of truth for pause/resume.

Required process:

- Call `roadmap_engineer_read_state` and `roadmap_engineer_validate` before edits.
- Use `roadmap_engineer_search_context` to inspect relevant decisions, risks, issues, and prior notes; expand only relevant entries with `roadmap_engineer_read_context`.
- Inspect the approved plan, referenced code, and referenced documentation before dispatching work.
- Use the built-in `ask` tool before continuing if implementation exposes missing decisions, ownership gaps, unplanned files/modules, acceptance ambiguity, cleanup scope questions, or approval needs.
- Do not use worktrees or isolated workspaces.
- Resume from `progress.active_wave_id`, `progress.step`, `progress.active_task_ids`, and `progress.blocked_reason`; do not infer a different current wave from notes.
- Before dispatch, call `roadmap_engineer_transition` with `update_implementation_progress` to move the active wave to `dispatching`.
- Dispatch only workers whose tasks are in the active wave and have non-overlapping ownership.
- When workers start, update task statuses and call `update_implementation_progress` with step `workers_running` and the active task IDs.
- Stop a worker if it needs unowned files/modules.
- Require every worker to append a scoped note before yielding.
- After worker notes are present, call `update_implementation_progress` with step `wave_review`, then run review for the active wave.
- Do not start a dependent wave while blocking review findings remain open.
- If blockers exist, call `update_implementation_progress` with step `resolving_blockers` and a concrete blocked reason.
- When a wave passes review, mark the wave complete, then call `update_implementation_progress` with step `ready_for_next_wave` and advance to the next pending wave; if no waves remain, set step `closeout_ready`.
- Record material replanning with `roadmap_engineer_amend`.
