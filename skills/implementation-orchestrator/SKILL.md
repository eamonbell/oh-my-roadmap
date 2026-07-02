---
name: implementation-orchestrator
description: Use when executing an approved roadmap-engineer milestone or approved change request.
---

# Implementation Orchestrator

Run implementation one approved wave at a time on the active branch. Treat the persisted implementation progress cursor as the source of truth for pause/resume.

Prefer waking the existing worker over spawning a replacement. When a worker hits a transient failure or its work needs rework, the original worker already holds the transcript, the files it touched, and the design context. Coordinate with the built-in `irc` tool (`op: list/send/wait/inbox`); the recovery and rework rules below spell out the peer statuses, receipts, and message wording to use.

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
- To recover or rework a run, prefer waking the existing worker. Use `irc` `op:list` to get its exact peer id and status (`running`/`idle`/`parked`/`aborted`), then `op:send` directly to that peer id — never broadcast with `to:"all"` (it skips `parked` peers and can wake unrelated agents). Do not resend to a worker that is still `running`.
- Interpret the delivery receipt: `injected` (running; will see it at the next step boundary — do not resend), `woken` (was idle; a real turn started), `revived` (was parked; OMP revived it), `failed` (could not deliver). Use `op:send await:true` or `op:wait` only when blocked on the reply, and do not treat a wait timeout as failure.
- Spawn a replacement only when the worker is `aborted`/non-revivable, when `op:list` does not list it (e.g. after resuming in a new session where the old subagent no longer exists), or when delivery returns `failed`. Use `history://<agentId>` to recover a worker's transcript when deciding whether a replacement is truly needed.
- If a current-session worker job reports socket-close or another transient transport failure, call `roadmap_engineer_record_worker_transport_failed`, then `op:list` and, if the worker is still a peer, `op:send` it a narrow resume message ("resume from your existing transcript, continue from the last completed step, retry only the interrupted operation, do not redo completed work, report back"), and wait up to 2 minutes.
- If the original worker responds after a transport failure, collect its final result and call `roadmap_engineer_record_wave_result` with `completed`.
- If the worker is not listed by `op:list`, delivery fails, or it does not respond within 2 minutes, call `roadmap_engineer_record_worker_abandoned`, then redispatch only that task.
- A transport/socket/provider error is an orchestration interruption, not an implementation blocker. Never call `roadmap_engineer_record_wave_result` with `failed`/`blocked` for a transport error — that path opens a canonical blocking blocker. Route transport errors only through `roadmap_engineer_record_worker_transport_failed` and then resume-or-abandon. Reserve `roadmap_engineer_record_wave_result` `failed`/`blocked` for a real implementation failure or blocker the worker itself reports.
- Stop a worker if it needs unowned files/modules.
- Require every worker to append a scoped note before yielding.
- If a worker or reviewer appends a blocking note that needs a user decision, use the built-in `ask` tool from the orchestrator/main-agent role; subagents do not ask the user directly.
- When worker or reviewer notes are blocked, use `roadmap_engineer_record_wave_result` or `roadmap_engineer_record_wave_review` to update task, wave, progress, worker-run, and blocker state before asking or replanning.
- On the first real blocker, record it, cancel sibling active runs, pause implementation, and report `/blocker:list`, `/blocker:resolve <id> <resolution>` or `/blocker:defer <id> <reason>`, then `/roadmap:resume`.
- After the user resolves a blocker, redispatch the task or record material replanning with `roadmap_engineer_amend`.
- Before wave review, confirm each active task has a worker note whose `workerId` matches that task's `worker` value.
- After matching worker notes are present, call `roadmap_engineer_prepare_wave_review`, then dispatch `reviewer` for the active wave.
- When the reviewer returns findings, classify each blocking finding before recording the review: worker-fixable (a concrete code correction needing no user decision) versus needs-user-decision (ambiguous acceptance, scope/approval, or risk disposition).
- For worker-fixable findings do not open a blocker: `op:list` and, if the original worker is still a peer, `op:send` it (`replyTo` the finding) narrow rework instructions naming the exact file/symbol/test, what must change, what must not change, and the verification to run; wait for its rework note; then re-dispatch `reviewer` and repeat until the wave is clean. If `op:list` does not list the original worker (new session or aborted), spawn a fresh worker for that task seeded with the findings and the task's persisted worker notes (and `history://<agentId>` when reachable), then re-review.
- Call `roadmap_engineer_record_wave_review` with `passed` only when the wave is clean, and with `failed` only for findings that genuinely need a user decision.
- Never perform wave reviews yourself.
- Never dispatch or perform `wave-flow-checker` during implementation; wave-flow checks are planner-only pre-approval checks.
- Do not start a dependent wave while blocking review findings remain open.
- If blockers exist, call `update_implementation_progress` with step `resolving_blockers` and a concrete blocked reason.
- When a wave passes review, mark the wave complete, then call `update_implementation_progress` with step `ready_for_next_wave` and advance to the next pending wave; if no waves remain, set step `closeout_ready`.
- Drive the whole run in one turn: loop dispatch -> results -> review -> advance across waves; do not stop after a single wave when more waves remain.
- Submit `roadmap_engineer_submit_findings_report` exactly once at the terminal point of the whole implementation run — when the run reaches `closeout_ready` (all waves complete) or terminally pauses on a real blocker, needs-input, or error. Do not submit a findings report after an individual wave that is followed by more waves.
- Record material replanning with `roadmap_engineer_amend`.
