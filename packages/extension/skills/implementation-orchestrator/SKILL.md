---
name: implementation-orchestrator
description: Use when executing an approved oh-my-roadmap milestone or approved change request.
---

# Implementation Orchestrator

Run implementation one approved wave at a time on the active branch. Treat the persisted implementation progress cursor as the source of truth for
pause/resume.

Prefer waking the existing worker over spawning a replacement. When a worker hits a transient failure or its work needs rework, the original worker
already holds the transcript, the files it touched, and the design context. Coordinate with the built-in `irc` tool (`op: list/send/wait/inbox`); the
recovery and rework rules below spell out the peer statuses, receipts, and message wording to use.

Required process:

- Call `omr_read_state` and `omr_validate` before edits. Pick the narrowest scope: `active_wave` when working a single wave's tasks/blockers/worker
  notes, `active_milestone` for broader implementation state — avoid the full compact dump when a focused scope answers the question.
- Use `omr_search_context` to inspect relevant decisions, risks, issues, and prior notes; expand only relevant entries with `omr_read_context`.
- Inspect the approved plan, referenced code, and referenced documentation before dispatching work.
- Use the built-in `ask` tool before continuing if implementation exposes missing decisions, ownership gaps, unplanned files/modules, acceptance
  ambiguity, cleanup scope questions, or approval needs.
- Never write or modify code yourself.
- You may inspect files, dispatch workers and reviewers, update roadmap state, append orchestrator notes, and ask the user.
- Do not use worktrees or isolated workspaces.
- Resume from `progress.active_wave_id`, `progress.step`, `progress.active_task_ids`, and `progress.blocked_reason`; do not infer a different current
  wave from notes.
- Before dispatch, call `omr_prepare_wave_dispatch`.
- If dispatch preparation returns `active_runs`, do not redispatch those tasks.
- For each active run, first check the current session's background jobs and IRC peers for the run's `job_id`/`jobId` or `agent_id`/`agentId`.
- If neither background jobs nor IRC peers list an active run, call `omr_record_worker_abandoned` immediately for that run. Do not poll, probe, or
  wait for runs that do not exist in the current session.
- Only poll or probe active runs that exist in the current session.
- Dispatch only returned assignments whose tasks are in the active wave.
- Dispatch each task as a background job using the exact agent named in the task's `worker` field: `worker-light`, `worker`, or `worker-heavy`.
- Immediately after each spawn, call `omr_record_worker_dispatch` with the task ID, returned `agentId`, and returned `jobId`.
- Never redispatch a task until its prior worker run is terminal: `abandoned`, `completed`, `blocked`, `failed`, or `cancelled`.
- After dispatching all worker or reviewer jobs for the current wave and recording their job ids, if you are blocked waiting for those jobs, issue one
  blocking `job` wait for the relevant job ids or for all running jobs with a meaningful timeout. Do not loop short job polls; retry only after an
  interrupt, timeout, or new liveness evidence. Use IRC liveness checks only after a timeout/interruption or when state says a worker should exist but
  the job handle is absent.
- To recover or rework a run, prefer waking the existing worker. Use `irc` `op:list` to get its exact peer id and status (`running`/`idle`/`parked`/
  `aborted`), then `op:send` directly to that peer id — never broadcast with `to:"all"` (it skips `parked` peers and can wake unrelated agents). Do
  not resend to a worker that is still `running`.
- Interpret the delivery receipt: `injected` (running; will see it at the next step boundary — do not resend), `woken` (was idle; a real turn
  started), `revived` (was parked; OMP revived it), `failed` (could not deliver). Use `op:send await:true` or `op:wait` only when blocked on the
  reply, and do not treat a wait timeout as failure.
- Spawn a replacement only when the worker is `aborted`/non-revivable, when `op:list` does not list it (e.g. after resuming in a new session where the
  old subagent no longer exists), or when delivery returns `failed`. Use `history://<agentId>` to recover a worker's transcript when deciding whether
  a replacement is truly needed.
- If a current-session worker job reports socket-close or another transient transport failure, call `omr_record_worker_transport_failed`, then run a *
  *bounded resume loop**: `irc op:list` to find the worker's peer, `op:send` it a narrow resume message ("resume from your existing transcript,
  continue from the last completed step, retry only the interrupted operation, do not redo completed work, report back"), and wait up to 2 minutes for
  a reply. Re-resume the same worker up to the configured resume cap (default 3); `transport_failures` is the counter. Never abandon after a single
  failed resume.
- An acknowledgement is a **liveness signal, not a licence to abandon**. If the worker acks or resumes it is alive and working; do not then fire a
  separate `op:wait` for a final result and treat its timeout as death. A `worker-heavy` task will not finish inside a 2-minute window, so a 2-minute
  *result* silence is not death. If `op:send await:true` already returned a reply, consume that reply as the liveness signal — do NOT launch a second
  blocking `op:wait` for a message that will never come. After acking, keep monitoring with longer waits (`op:wait` minutes, or `op:list` activity-age
  checks), never a fixed short abandon window.
- `op:list` is the authority for liveness; the `job` tool is not. The `job`/`job list` tool can report a crashed-then-resumed run as terminal
  `failed (exit 1)` while `op:list` shows the peer `running`, and can return an empty/non-text placeholder. A job `failed`/`exited` status means the
  spawned process exited — that is not the same as the task failing when the underlying agent/IRC peer survives and resumed. Treat an empty or
  non-text job snapshot as no signal (never as death). Decide liveness from `op:list` peer status and activity age only; ignore a stale `job` terminal
  state after a transport failure, and never abandon on `job` output alone.
- Only after the configured resume cap (default 3) is hit or the worker is confirmed unreachable: run a fresh `irc op:list` immediately before
  `omr_record_worker_abandoned` — if the peer is `running`/`idle` with recent activity, do not abandon. Then stop the peer (`TaskStop`) and confirm it
  is gone via `op:list` (do not leave it `parked` — parked peers linger for minutes and are auto-revived when messaged), call
  `omr_record_worker_abandoned`, call `omr_prepare_worker_redispatch` (it refuses while a run is still `running`, so a replacement can never collide
  with a live peer), spawn the replacement with the returned prompt (it carries continuation context, the prior worker's `history://<agentId>`
  transcript, and a live-peer coordination warning), then call `omr_record_worker_dispatch` with the new `agentId`/`jobId` and `replacesAgentId` set
  to the prior worker's `agentId`.
- A transport/socket/provider error is an orchestration interruption, not an implementation blocker. Never call `omr_record_wave_result` with
  `failed`/`blocked` for a transport error — that path opens a canonical blocking blocker. Route transport errors only through
  `omr_record_worker_transport_failed` and then resume-or-abandon. Reserve `omr_record_wave_result` `failed`/`blocked` for a real implementation
  failure or blocker the worker itself reports.
- Stop a worker if it needs unowned files/modules.
- Require every worker to append a scoped note before yielding.
- If a worker or reviewer appends a blocking note that needs a user decision, use the built-in `ask` tool from the orchestrator/main-agent role;
  subagents do not ask the user directly.
- When worker or reviewer notes are blocked, use `omr_record_wave_result` or `omr_record_wave_review` to update task, wave, progress, worker-run, and
  blocker state before asking or replanning.
- Collect wave results from state, not from a live IRC reply. A worker persists its structured result to its note before yielding and may already have
  terminated when you ask for its report. If the peer is gone, call `omr_record_wave_result` (omit `summary` when you have none) — it sources the
  summary from the worker's resolved note. Do not reconstruct a completion by re-searching context.
- On the first real blocker, record it, cancel sibling active runs, pause implementation, and report `/omr:blk-list`,
  `/omr:blk-resolve <id> <resolution>` or `/omr:blk-defer <id> <reason>`, then `/omr:rm-resume`.
- After the user resolves a blocker, redispatch the task or record material replanning with `omr_amend`.
- Before wave review, confirm each active task has a worker note whose `workerId` matches that task's `worker` value.
- After matching worker notes are present, call `omr_prepare_wave_review`, then dispatch `reviewer` for the active wave.
- When the reviewer returns findings, classify each blocking finding before recording the review: worker-fixable (a concrete code correction needing
  no user decision) versus needs-user-decision (ambiguous acceptance, scope/approval, or risk disposition).
- For worker-fixable findings do not open a blocker: `op:list` and, if the original worker is still a peer, `op:send` it (`replyTo` the finding)
  narrow rework instructions naming the exact file/symbol/test, what must change, what must not change, and the verification to run; wait for its
  rework note; then re-dispatch `reviewer` and repeat until the wave is clean. If `op:list` does not list the original worker (new session or
  aborted), spawn a fresh worker for that task seeded with the findings and the task's persisted worker notes (and `history://<agentId>` when
  reachable), then re-review.
- A rework worker dispatched to fix an open blocker is authorized to edit that blocker's files without first resolving it; the write-gate permits
  edits for any task with an active worker run. Do not call `omr_resolve_blocker` merely to open the write-gate — resolve a blocker only when its
  rework is genuinely complete.
- Call `omr_record_wave_review` with `passed` only when the wave is clean, and with `failed` only for findings that genuinely need a user decision.
- Never perform wave reviews yourself.
- Never dispatch or perform `wave-flow-checker` during implementation; wave-flow checks are planner-only pre-approval checks.
- Do not start a dependent wave while blocking review findings remain open.
- If blockers exist, call `update_implementation_progress` with step `resolving_blockers` and a concrete blocked reason.
- When a wave passes review, mark the wave complete, then call `update_implementation_progress` with step `ready_for_next_wave` and advance to the
  next pending wave; if no waves remain, set step `closeout_ready`.
- Drive the whole run in one turn: loop dispatch -> results -> review -> advance across waves; do not stop after a single wave when more waves remain.
- Submit `omr_submit_findings_report` exactly once at the terminal point of the whole implementation run — when the run reaches `closeout_ready` (all
  waves complete) or terminally pauses on a real blocker, needs-input, or error. Do not submit a findings report after an individual wave that is
  followed by more waves.
- Record material replanning with `omr_amend`.
