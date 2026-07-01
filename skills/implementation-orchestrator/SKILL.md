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
- Never write or modify code yourself.
- You may inspect files, dispatch workers and reviewers, update roadmap state, append orchestrator notes, and ask the user.
- Do not use worktrees or isolated workspaces.
- Resume from `progress.active_wave_id`, `progress.step`, `progress.active_task_ids`, and `progress.blocked_reason`; do not infer a different current wave from notes.
- Before dispatch, call `roadmap_engineer_prepare_wave_dispatch`.
- If dispatch preparation returns `active_runs`, do not redispatch those tasks.
- For each active run, first check the current session's background jobs and IRC peers for the run's `job_id`/`jobId` or `agent_id`/`agentId`.
- If neither background jobs nor IRC peers list an active run, call `roadmap_engineer_record_worker_abandoned` immediately for that run. Do not poll, probe, or wait for runs that do not exist in the current session.
- Only poll or probe active runs that exist in the current session.
- Dispatch only returned assignments whose tasks are in the active wave.
- Dispatch each task as a background job using the exact agent named in the task's `worker` field: `worker-light`, `worker`, or `worker-heavy`.
- Immediately after each spawn, call `roadmap_engineer_record_worker_dispatch` with the task ID, returned `agentId`, and returned `jobId`.
- Never redispatch a task until its prior worker run is terminal: `abandoned`, `completed`, `blocked`, `failed`, or `cancelled`.
- If a current-session worker job reports socket-close or another transient transport failure, call `roadmap_engineer_record_worker_transport_failed`, probe the original worker via job/IRC, and wait up to 5 minutes.
- If the original worker responds after a transport failure, collect its final result and call `roadmap_engineer_record_wave_result`.
- If the original current-session worker does not respond after 5 minutes, call `roadmap_engineer_record_worker_abandoned`, then redispatch only that task.
- Transport failures do not create canonical blockers unless the worker reports a real implementation blocker.
- Stop a worker if it needs unowned files/modules.
- Require every worker to append a scoped note before yielding.
- If a worker or reviewer appends a blocking note that needs a user decision, use the built-in `ask` tool from the orchestrator/main-agent role; subagents do not ask the user directly.
- When worker or reviewer notes are blocked, use `roadmap_engineer_record_wave_result` or `roadmap_engineer_record_wave_review` to update task, wave, progress, worker-run, and blocker state before asking or replanning.
- On the first real blocker, record it, cancel sibling active runs, pause implementation, and report `/blocker:list`, `/blocker:resolve <id> <resolution>` or `/blocker:defer <id> <reason>`, then `/roadmap:resume`.
- After the user resolves a blocker, redispatch the task or record material replanning with `roadmap_engineer_amend`.
- Before wave review, confirm each active task has a worker note whose `workerId` matches that task's `worker` value.
- After matching worker notes are present, call `roadmap_engineer_prepare_wave_review`, then dispatch `reviewer` for the active wave.
- Never perform wave reviews yourself.
- Never dispatch or perform `wave-flow-checker` during implementation; wave-flow checks are planner-only pre-approval checks.
- Do not start a dependent wave while blocking review findings remain open.
- If blockers exist, call `update_implementation_progress` with step `resolving_blockers` and a concrete blocked reason.
- When a wave passes review, mark the wave complete, then call `update_implementation_progress` with step `ready_for_next_wave` and advance to the next pending wave; if no waves remain, set step `closeout_ready`.
- Record material replanning with `roadmap_engineer_amend`.
