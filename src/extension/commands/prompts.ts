function commandSpecificInstructions(name: string): string {
	if (name === 'roadmap:new') {
		return `
Command-specific workflow for /roadmap:new:
- After roadmap_engineer_update_roadmap writes the finalized roadmap, dispatch roadmap-milestone-checker before asking for roadmap approval.
- Record the checker result with roadmap_engineer_transition operation record_roadmap_milestone_check.
- If the checker fails, revise the roadmap with roadmap_engineer_update_roadmap, rerun roadmap-milestone-checker, and record the new result.
- Only call roadmap_engineer_validate and ask for roadmap approval after the recorded roadmap-milestone check has passed.`
	}
	if (name === 'milestone:plan') {
		return `
Command-specific workflow for /milestone:plan:
- If the roadmap phase is roadmap_approved, call roadmap_engineer_transition with operation start_milestone_planning before creating the milestone plan.
- If the roadmap phase is complete and the roadmap has remaining planned or blocked milestone outlines, do not call reopen_roadmap. Call roadmap_engineer_transition with operation start_milestone_planning to advance from the completed milestone into planning for the next milestone.
- If the roadmap phase is complete and there are no remaining planned or blocked milestone outlines, stop and ask whether the user wants a post-implementation change request or a new roadmap.
- Do not pad the milestone plan with filler tasks; every task must directly implement the approved roadmap milestone scope.
- After milestone planning is open, use roadmap_engineer_transition with operation create_milestone_plan for the selected roadmap milestone, then validate before asking for approval.`
	}
	if (name === 'milestone:implement') {
		return `
Command-specific workflow for /milestone:implement:
- Use the built-in \`ask\` tool from the orchestrator/main-agent role if implementation uncovers missing decisions, ownership gaps, unplanned files, acceptance ambiguity, cleanup scope questions, or approval needs.
- Do not write or modify code yourself.
- Drive the whole milestone/change implementation in this turn: loop dispatch -> collect results -> review -> advance to the next wave, one wave at a time, until no waves remain or the run terminally pauses. Do not end the turn after a single wave when more waves remain.
- Call roadmap_engineer_prepare_wave_dispatch before dispatching implementation work. If it returns active_runs, do not redispatch those tasks.
- For each active run, first check the current session's background jobs and IRC peers for the run's jobId/job_id or agentId/agent_id. If neither background jobs nor IRC peers list that run, call roadmap_engineer_record_worker_abandoned immediately; do not poll, probe, or wait. Only poll or probe runs that exist in the current session.
- Dispatch returned active-wave assignments as background jobs using each assignment's exact worker and prompt.
- Immediately after each spawn, call roadmap_engineer_record_worker_dispatch with the returned agentId and jobId.
- Never redispatch a task until the prior worker run is completed, blocked, failed, cancelled, or abandoned.

IRC recovery/rework pattern (prefer waking the existing worker over spawning a replacement):
- Before recovering or reworking a run, use the built-in \`irc\` tool op:list to get the worker's exact peer id and status (running, idle, parked, or aborted).
- Message the worker directly with op:send to that exact peer id; never broadcast with to:"all" (broadcast skips parked peers and can wake unrelated agents). Do not resend to a worker that is still running.
- Interpret the delivery receipt: injected = the worker is running and will see the message at its next step boundary, so do not resend; woken = it was idle and a real turn started; revived = it was parked and OMP revived it; failed = it could not be delivered.
- Use op:send await:true or op:wait only when you are blocked on the reply; do not treat a wait timeout as failure, because the worker may still be running.
- Spawn a replacement only when the worker is aborted or non-revivable, when op:list does not list it (for example after resuming in a new session where the old subagent no longer exists), or when delivery returns failed. Use history://<agentId> to recover a worker's transcript when deciding whether a replacement is truly needed.

Transient transport failure:
- If a current-session worker job reports socket-close or another transient transport failure, call roadmap_engineer_record_worker_transport_failed, then op:list and, if the worker is still a peer, op:send it a narrow resume message: "You stopped after a transport error. Resume from your existing transcript, continue from the last completed step, retry only the interrupted operation, do not redo completed work, and report back." Then wait up to 2 minutes for a reply. If the original worker responds, collect its final result and call roadmap_engineer_record_wave_result with completed. If op:list does not list it, delivery fails, or it does not respond within 2 minutes, call roadmap_engineer_record_worker_abandoned, then redispatch only that task.
- A transport, socket, or provider error is an orchestration interruption, not an implementation blocker. Never call roadmap_engineer_record_wave_result with failed or blocked for a transport error; that path opens a canonical blocking blocker. Route transport errors only through roadmap_engineer_record_worker_transport_failed and then resume-or-abandon. Reserve roadmap_engineer_record_wave_result with failed or blocked for a real implementation failure or blocker the worker itself reports.
- After each worker returns real work, call roadmap_engineer_record_wave_result with completed, failed, or blocked status before taking any next orchestration step.

Wave review and rework:
- When all active-wave workers are completed, call roadmap_engineer_prepare_wave_review and dispatch the returned reviewer package with the built-in task/subagent mechanism.
- When the reviewer returns findings, classify each blocking finding before recording the review: worker-fixable (a concrete code correction that needs no user decision) versus needs-user-decision (ambiguous acceptance, scope or approval, or risk disposition).
- For worker-fixable findings do not open a blocker: op:list and, if the original worker is still a peer, op:send it (replyTo the finding) narrow rework instructions naming the exact file/symbol/test, what must change, what must not change, and the verification to run; wait for its rework note; then re-dispatch reviewer and repeat until the wave is clean. If op:list does not list the original worker (new session or aborted), spawn a fresh worker for that task seeded with the findings and the task's persisted worker notes (and history://<agentId> when reachable), then re-review.
- Call roadmap_engineer_record_wave_review with passed only when the wave is clean, and with failed only for findings that genuinely need a user decision.
- If workers or reviewers report real blockers, rely on the record tools to update task/wave/progress state and open canonical blockers, cancel sibling active runs, pause, ask the user from the orchestrator/main-agent role when needed, and report /blocker:list, /blocker:resolve <id> <resolution> or /blocker:defer <id> <reason>, then /roadmap:resume.
- Require worker results whose worker role matches each returned assignment before preparing review.
- Never perform wave reviews yourself and never perform wave-flow checks during implementation.
- Submit roadmap_engineer_submit_findings_report exactly once at the terminal point of this implementation run: when the milestone/change reaches closeout_ready with all waves complete, or when the run terminally pauses on a real blocker, needs-input, or error. Do not submit a findings report after an individual wave when more waves remain; continue to the next wave in this same turn.`
	}
	if (name === 'roadmap:repair') {
		return `
Command-specific workflow for /roadmap:repair:
- Run roadmap_engineer_validate and inspect validation errors before changing state.
- Use roadmap_engineer_read_state and roadmap_engineer_search_context to identify whether roadmap_content_hash, roadmap.md, or roadmap_milestone_check drifted after manual state recovery.
- If the roadmap definition changed or the roadmap-milestone check is stale, rerun roadmap-milestone-checker before recording a passed checker result.
- Call roadmap_engineer_repair_roadmap with a concrete reason, and include roadmapMilestoneCheck only when a fresh roadmap-milestone-checker pass is available.
- Validate again after repair.
- Do not call reopen_roadmap, approve_roadmap, update_roadmap, milestone planning, implementation progress tools, or bypass tools unless a separate validation error still requires that workflow.`
	}
	if (name === 'blocker:list' || name === 'blocker:status') {
		return `
Command-specific workflow for /${name}:
- Call roadmap_engineer_list_blockers with status: 'open' first.
- Report blocker ID, title, severity, status, scope, and concise description.
- Show exact recovery commands:
  - /blocker:resolve <id> <resolution>
  - /blocker:defer <id> <reason>
  - /roadmap:resume
- Do not resolve or defer blockers unless the user provided an explicit blocker ID and resolution or defer reason.`
	}
	if (name === 'blocker:resolve') {
		return `
Command-specific workflow for /blocker:resolve:
- Parse user arguments as <blocker-id> <resolution>.
- If either value is missing, call roadmap_engineer_list_blockers with status: 'open', show available blockers, and ask for the missing blocker ID or resolution.
- When both values are present, call roadmap_engineer_resolve_blocker with the blocker ID and resolution.
- Call roadmap_engineer_validate after resolving the blocker.
- Report the resolved blocker and tell the user to run /roadmap:resume.`
	}
	if (name === 'blocker:defer') {
		return `
Command-specific workflow for /blocker:defer:
- Parse user arguments as <blocker-id> <reason>.
- If either value is missing, call roadmap_engineer_list_blockers with status: 'open', show available blockers, and ask for the missing blocker ID or defer reason.
- When both values are present, call roadmap_engineer_defer_blocker with the blocker ID and defer reason.
- Call roadmap_engineer_validate after deferring the blocker.
- Report the deferred blocker and tell the user to run /roadmap:resume.`
	}
	if (name !== 'roadmap:reopen') return ''
	return `
Command-specific workflow for /roadmap:reopen:
- Read state and validate that the active roadmap is exactly in roadmap_approved with no active milestone or change request.
- Inspect the current roadmap, decisions, risks, relevant code, and relevant documentation before proposing changes.
- Use the built-in ask tool until the requested roadmap delta and required reopen reason are explicit.
- Call roadmap_engineer_transition with operation reopen_roadmap and a non-empty reason.
- Call roadmap_engineer_update_roadmap with the full revised structured roadmap.
- After roadmap_engineer_update_roadmap writes the finalized roadmap, dispatch roadmap-milestone-checker before asking for roadmap approval.
- Record the checker result with roadmap_engineer_transition operation record_roadmap_milestone_check.
- If the checker fails, revise the roadmap with roadmap_engineer_update_roadmap, rerun roadmap-milestone-checker, and record the new result.
- Only call roadmap_engineer_validate and ask for roadmap approval after the recorded roadmap-milestone check has passed.
- Call roadmap_engineer_validate, ask for explicit roadmap reapproval, then call roadmap_engineer_transition with operation approve_roadmap.
- Do not create milestone plans, tasks, waves, workers, ownership, change requests, or implementation work during reopening.`
}

export function commandPrompt(name: string, args: string, report: string): string {
	return `You are operating the roadmap-engineer OMP extension command /${name}.

User arguments:
${args || '(none)'}

Current roadmap-engineer state:
${report}

Follow the roadmap-engineer workflow strictly:
- Do not assume missing planning details.
- Inspect existing code and documentation before planning or changing state.
- Use the built-in ask tool to interview the user whenever additional information, decisions, tradeoffs, gaps, approvals, or unresolved questions remain.
- Reference relevant existing code and documentation paths in roadmap, milestone, change, review, and closeout artifacts when those references help future agents.
- Use roadmap_engineer_read_state for compact orientation before changing state when context is unclear; request a focused scope when only roadmap, active milestone, active change, or usage context is needed.
- Use roadmap_engineer_search_context for roadmap sections, plan sections, decisions, risks, notes, issues, and review findings; use roadmap_engineer_read_context only for selected entries that need full detail. Do not read full roadmap.md or plan.md directly unless the section tools cannot answer the question.
- Use roadmap_engineer_validate before asking for approval or opening implementation.
- Use roadmap_engineer_update_roadmap to finalize a detailed generated roadmap before asking for roadmap approval.
- For roadmap planning, each milestone outline must group multiple meaningful deliverables or workstreams that belong together; do not create a separate milestone for one small edit, isolated cleanup, or one narrow task.
- Use roadmap_engineer_transition, roadmap_engineer_amend, roadmap_engineer_append_note, or roadmap_engineer_create_change_request for state changes.
- Record discovery with roadmap_engineer_transition operation record_discovery before roadmap approval.
- For milestone and change planning, define concrete executable tasks before dependency analysis or wave creation; each task needs objective, implementation notes, done criteria, task verification commands, dependencies, exclusive ownership, shared interfaces, and worker assignment.
- For milestone and change planning, assign each task to exactly one of worker-light, worker, or worker-heavy based on risk and blast radius.
- Before milestone or change approval, dispatch wave-flow-checker, record its result with record_wave_flow_check, and revise draft plans with update_milestone_plan or update_change_request_plan until the check passes.
- For milestone planning, explicitly ask the user what test coverage they want based on the implementation tasks: which areas should create tests, which should run existing tests, what detail those tests should cover, and what coverage is intentionally deferred or not required.
- For implementation progress, prefer roadmap_engineer_prepare_wave_dispatch, roadmap_engineer_record_wave_result, roadmap_engineer_prepare_wave_review, and roadmap_engineer_record_wave_review; use update_task_status, update_wave_status, and update_implementation_progress only for manual recovery.
- For implementation resume, treat the persisted progress cursor as authoritative for active wave, orchestration step, active tasks, and blocker reason.
- Before closing milestones or changes, record structured closeout evidence with record_closeout.
- For milestone and change implementation, do not edit files yourself; call the wave orchestration tools, dispatch each returned task to the exact agent named by assignment.worker, dispatch reviewer for wave reviews, and collect evidence closeout.
- If implementation is not legally open, do not edit files.

Before finishing this slash-command turn:
- Call roadmap_engineer_submit_findings_report exactly once after completing the command task or determining the terminal blocked/error/needs-input state, and before your final response.
- Use title: "/${name} result".
- Use markdown for the durable user-visible command result only: outcome, next commands/actions, and any blocker/error state. Do not include a tool-call audit trail unless it is part of the command result.
${commandSpecificInstructions(name)}`
}
