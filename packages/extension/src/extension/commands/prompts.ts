function commandSpecificInstructions(name: string, transportResumeAttempts: number): string {
	if (name === 'omr:rm-new') {
		return `
Command-specific workflow for /omr:rm-new:
- After omr_update_roadmap writes the finalized roadmap, dispatch roadmap-milestone-checker before asking for roadmap approval.
- Record the checker result with omr_transition operation record_roadmap_milestone_check.
- If the checker fails, revise the roadmap with omr_update_roadmap, rerun roadmap-milestone-checker, and record the new result.
- Only call omr_validate and ask for roadmap approval after the recorded roadmap-milestone check has passed.`
	}
	if (name === 'omr:ms-plan') {
		return `
Command-specific workflow for /omr:ms-plan:
- If the roadmap phase is roadmap_approved, call omr_transition with operation start_milestone_planning before creating the milestone plan.
- If the roadmap phase is complete and the roadmap has remaining planned or blocked milestone outlines, do not call reopen_roadmap. Call omr_transition with operation start_milestone_planning to advance from the completed milestone into planning for the next milestone.
- If the roadmap phase is complete and there are no remaining planned or blocked milestone outlines, stop and ask whether the user wants a post-implementation change request or a new roadmap (starting a new roadmap archives the completed one).
- Do not pad the milestone plan with filler tasks; every task must directly implement the approved roadmap milestone scope.
- After milestone planning is open, use omr_transition with operation create_milestone_plan for the selected roadmap milestone, then validate before asking for approval.`
	}
	if (name === 'omr:ms-implement') {
		return `
Command-specific workflow for /omr:ms-implement:
- Use the built-in \`ask\` tool from the orchestrator/main-agent role if implementation uncovers missing decisions, ownership gaps, unplanned files, acceptance ambiguity, cleanup scope questions, or approval needs.
- Do not write or modify code yourself.
- Drive the whole milestone/change implementation in this turn: loop dispatch -> collect results -> review -> advance to the next wave, one wave at a time, until no waves remain or the run terminally pauses. Do not end the turn after a single wave when more waves remain.
- Call omr_prepare_wave_dispatch before dispatching implementation work. If it returns active_runs, do not redispatch those tasks.
- For each active run, first check the current session's background jobs and IRC peers for the run's jobId/job_id or agentId/agent_id. If neither background jobs nor IRC peers list that run, call omr_record_worker_abandoned immediately; do not poll, probe, or wait. Only poll or probe runs that exist in the current session.
- Dispatch returned active-wave assignments as background jobs using each assignment's exact worker and prompt.
- Immediately after each spawn, call omr_record_worker_dispatch with the returned agentId and jobId.
- Never redispatch a task until the prior worker run is completed, blocked, failed, cancelled, or abandoned.

IRC recovery/rework pattern (prefer waking the existing worker over spawning a replacement):
- Before recovering or reworking a run, use the built-in \`irc\` tool op:list to get the worker's exact peer id and status (running, idle, parked, or aborted).
- Message the worker directly with op:send to that exact peer id; never broadcast with to:"all" (broadcast skips parked peers and can wake unrelated agents). Do not resend to a worker that is still running.
- Interpret the delivery receipt: injected = the worker is running and will see the message at its next step boundary, so do not resend; woken = it was idle and a real turn started; revived = it was parked and OMP revived it; failed = it could not be delivered.
- Use op:send await:true or op:wait only when you are blocked on the reply; do not treat a wait timeout as failure, because the worker may still be running.
- Spawn a replacement only when the worker is aborted or non-revivable, when op:list does not list it (for example after resuming in a new session where the old subagent no longer exists), or when delivery returns failed. Use history://<agentId> to recover a worker's transcript when deciding whether a replacement is truly needed.

Transient transport failure (bounded resume loop, liveness-gated abandonment):
- If a current-session worker job reports socket-close or another transient transport failure, call omr_record_worker_transport_failed, then run a bounded resume loop: irc op:list to find the worker's peer, op:send it a narrow resume message ("You stopped after a transport error. Resume from your existing transcript, continue from the last completed step, retry only the interrupted operation, do not redo completed work, and report back."), and wait up to 2 minutes for a reply. Re-resume the same worker up to the configured resume cap of ${transportResumeAttempts} attempts (transport_failures is the counter). Never abandon after a single failed resume.
- An acknowledgement is a liveness signal, not a licence to abandon. If the worker acks or resumes it is alive and working; do not then fire a separate op:wait for a final result and treat its timeout as death. A worker-heavy task will not finish inside a 2-minute window, so a 2-minute result silence is not death. If op:send await:true already returned a reply, consume that reply as the liveness signal — do NOT launch a second blocking op:wait for a message that will never come. After acking, keep monitoring with longer waits (op:wait minutes, or op:list activity-age checks), never a fixed short abandon window.
- op:list is the authority for liveness; the job tool is not. The job/job list tool can report a crashed-then-resumed run as terminal failed (exit 1) while op:list shows the peer running, and can return an empty or non-text placeholder. A job "failed"/"exited" status means the spawned process exited — that is NOT the same as the task failing when the underlying agent/IRC peer survives and resumed. Treat an empty or non-text job snapshot as no signal (never as death). Decide liveness from op:list peer status and activity age only; ignore a stale job terminal state after a transport failure, and never abandon on job output alone.
- Only after the resume cap of ${transportResumeAttempts} attempts is hit or the worker is confirmed unreachable: run a fresh irc op:list immediately before omr_record_worker_abandoned — if the peer is running or idle with recent activity, do not abandon. Then stop the peer with TaskStop and confirm it is gone via op:list (do not leave it parked — parked peers linger for minutes and are auto-revived when messaged), call omr_record_worker_abandoned, call omr_prepare_worker_redispatch (it refuses while a run is still running, so a replacement can never collide with a live peer), spawn the replacement with the returned prompt (it carries continuation context, the prior worker's history://<agentId> transcript, and a live-peer coordination warning), then call omr_record_worker_dispatch with the new agentId and jobId and replacesAgentId set to the prior worker's agentId.
- A transport, socket, or provider error is an orchestration interruption, not an implementation blocker. Never call omr_record_wave_result with failed or blocked for a transport error; that path opens a canonical blocking blocker. Route transport errors only through omr_record_worker_transport_failed and then resume-or-abandon. Reserve omr_record_wave_result with failed or blocked for a real implementation failure or blocker the worker itself reports.
- After each worker returns real work, call omr_record_wave_result with completed, failed, or blocked status before taking any next orchestration step.
- Collect the result from state, not from a live IRC reply. A worker writes its structured result to its persisted note before yielding, and may already have terminated ("Unknown or terminated agent") by the time you ask for its report. If the peer is gone, do NOT re-search or reconstruct the summary from scratch: call omr_record_wave_result for the task (omit summary when you have none) — it sources the summary from the worker's resolved note in state. Reserve a search only for extra detail you still need after that.

Wave review and rework:
- When all active-wave workers are completed, call omr_prepare_wave_review and dispatch the returned reviewer package with the built-in task/subagent mechanism.
- When the reviewer returns findings, classify each blocking finding before recording the review: worker-fixable (a concrete code correction that needs no user decision) versus needs-user-decision (ambiguous acceptance, scope or approval, or risk disposition).
- For worker-fixable findings do not open a blocker: op:list and, if the original worker is still a peer, op:send it (replyTo the finding) narrow rework instructions naming the exact file/symbol/test, what must change, what must not change, and the verification to run; wait for its rework note; then re-dispatch reviewer and repeat until the wave is clean. If op:list does not list the original worker (new session or aborted), spawn a fresh worker for that task seeded with the findings and the task's persisted worker notes (and history://<agentId> when reachable), then re-review.
- A rework worker dispatched to fix an open blocker is authorized to edit the files that blocker covers without first resolving it; the write-gate already permits edits for a task with an active worker run. Do NOT call omr_resolve_blocker merely to open the write-gate — resolve a blocker only when its rework is genuinely done.
- Call omr_record_wave_review with passed only when the wave is clean, and with failed only for findings that genuinely need a user decision.
- If workers or reviewers report real blockers, rely on the record tools to update task/wave/progress state and open canonical blockers, cancel sibling active runs, pause, ask the user from the orchestrator/main-agent role when needed, and report /omr:blk-list, /omr:blk-resolve <id> <resolution> or /omr:blk-defer <id> <reason>, then /omr:rm-resume.
- Require worker results whose worker role matches each returned assignment before preparing review.
- Never perform wave reviews yourself and never perform wave-flow checks during implementation.
- Submit omr_submit_findings_report exactly once at the terminal point of this implementation run: when the milestone/change reaches closeout_ready with all waves complete, or when the run terminally pauses on a real blocker, needs-input, or error. Do not submit a findings report after an individual wave when more waves remain; continue to the next wave in this same turn.`
	}
	if (name === 'omr:rm-repair') {
		return `
Command-specific workflow for /omr:rm-repair:
- Run omr_validate and inspect validation errors before changing state.
- Use omr_read_state and omr_search_context to identify whether roadmap_content_hash, roadmap.md, or roadmap_milestone_check drifted after manual state recovery.
- If the roadmap definition changed or the roadmap-milestone check is stale, rerun roadmap-milestone-checker before recording a passed checker result.
- Call omr_repair_roadmap with a concrete reason, and include roadmapMilestoneCheck only when a fresh roadmap-milestone-checker pass is available.
- Validate again after repair.
- Do not call reopen_roadmap, approve_roadmap, update_roadmap, milestone planning, implementation progress tools, or bypass tools unless a separate validation error still requires that workflow.`
	}
	if (name === 'omr:blk-list' || name === 'omr:blk-status') {
		return `
Command-specific workflow for /${name}:
- Call omr_list_blockers with status: 'open' first.
- Report blocker ID, title, severity, status, scope, and concise description.
- Show exact recovery commands:
  - /omr:blk-resolve <id> <resolution>
  - /omr:blk-defer <id> <reason>
  - /omr:rm-resume
- Do not resolve or defer blockers unless the user provided an explicit blocker ID and resolution or defer reason.`
	}
	if (name === 'omr:blk-resolve') {
		return `
Command-specific workflow for /omr:blk-resolve:
- Parse user arguments as <blocker-id> <resolution>.
- If either value is missing, call omr_list_blockers with status: 'open', show available blockers, and ask for the missing blocker ID or resolution.
- When both values are present, call omr_resolve_blocker with the blocker ID and resolution.
- Call omr_validate after resolving the blocker.
- Report the resolved blocker and tell the user to run /omr:rm-resume.`
	}
	if (name === 'omr:blk-defer') {
		return `
Command-specific workflow for /omr:blk-defer:
- Parse user arguments as <blocker-id> <reason>.
- If either value is missing, call omr_list_blockers with status: 'open', show available blockers, and ask for the missing blocker ID or defer reason.
- When both values are present, call omr_defer_blocker with the blocker ID and defer reason.
- Call omr_validate after deferring the blocker.
- Report the deferred blocker and tell the user to run /omr:rm-resume.`
	}
	if (name !== 'omr:rm-reopen') return ''
	return `
Command-specific workflow for /omr:rm-reopen:
- Read state and validate that the active roadmap is exactly in roadmap_approved with no active milestone or change request.
- Inspect the current roadmap, decisions, risks, relevant code, and relevant documentation before proposing changes.
- Use the built-in ask tool until the requested roadmap delta and required reopen reason are explicit.
- Call omr_transition with operation reopen_roadmap and a non-empty reason.
- Call omr_update_roadmap with the full revised structured roadmap.
- After omr_update_roadmap writes the finalized roadmap, dispatch roadmap-milestone-checker before asking for roadmap approval.
- Record the checker result with omr_transition operation record_roadmap_milestone_check.
- If the checker fails, revise the roadmap with omr_update_roadmap, rerun roadmap-milestone-checker, and record the new result.
- Only call omr_validate and ask for roadmap approval after the recorded roadmap-milestone check has passed.
- Call omr_validate, ask for explicit roadmap reapproval, then call omr_transition with operation approve_roadmap.
- Do not create milestone plans, tasks, waves, workers, ownership, change requests, or implementation work during reopening.`
}

function adhocCommandInstructions(name: string): string {
	if (name === 'omr:adhoc-new') {
		return `- Interview the user with the built-in \`ask\` tool until the request, scope, acceptance criteria, verification commands, and any external-dependency docs are clear. Do not guess about SDKs/APIs — ask for documentation.
- Call omr_init_adhoc with concrete executable tasks (objective, implementation notes, done criteria, verification, exclusive ownership, worker assignment) and execution waves.
- Dispatch wave-flow-checker, then record its result with omr_adhoc_transition operation record_wave_flow_check.
- Call omr_validate; when it passes and the wave-flow check passed, ask for approval and call omr_adhoc_transition operation approve.`
	}
	if (name === 'omr:adhoc-plan') {
		return `- Use omr_update_adhoc_plan to revise the active draft plan (allowed only before approval).
- Re-dispatch wave-flow-checker and record it with omr_adhoc_transition record_wave_flow_check, then omr_validate and ask for approval before omr_adhoc_transition approve.`
	}
	if (name === 'omr:adhoc-implement') {
		return `- Call omr_adhoc_transition operation start_implementing.
- Drive the whole plan this turn: loop omr_prepare_wave_dispatch -> dispatch each returned assignment to its exact worker as a background job -> omr_record_worker_dispatch -> collect results with omr_record_wave_result -> omr_prepare_wave_review -> dispatch reviewer -> omr_record_wave_review, one wave at a time until no waves remain.
- Do not write or modify code yourself; dispatch the worker/reviewer agents. The write-gate opens only while the ad-hoc plan is approved and implementing/reviewing.
- When all waves are complete, call omr_adhoc_transition start_reviewing, record closeout evidence with omr_adhoc_transition record_closeout, then omr_adhoc_transition complete.`
	}
	if (name === 'omr:adhoc-status') {
		return `- Report the active ad-hoc plan's status, wave/task progress, wave-flow-check result, and next action. Do not change state.`
	}
	if (name === 'omr:adhoc-close') {
		return `- Ensure every acceptance criterion and verification command has a passed or deferred result, then call omr_adhoc_transition record_closeout with the evidence and omr_adhoc_transition complete.`
	}
	if (name === 'omr:adhoc-cancel') {
		return `- Confirm with the user, then call omr_adhoc_transition operation cancel to clear the active ad-hoc plan. This does not delete recorded files.`
	}
	return ''
}

export function adhocCommandPrompt(name: string, args: string, summary: string): string {
	return `You are operating the oh-my-roadmap ad-hoc command /${name}.

User arguments:
${args || '(none)'}

Active ad-hoc plan:
${summary}

Ad-hoc plans are a roadmap-free lightweight flow that reuse the full task/wave/worker/reviewer/closeout machinery. Only one ad-hoc plan (and no roadmap) may be active at a time.

Follow these rules:
- Interview for intent, not just mechanics, and never guess about external SDKs/APIs — ask the user for documentation links or file paths.
- Use omr_read_state and omr_validate to orient and check the plan before approval or implementation.
- Use the ad-hoc tools (omr_init_adhoc, omr_update_adhoc_plan, omr_adhoc_transition) plus the shared wave tools (omr_prepare_wave_dispatch, omr_record_wave_result, omr_prepare_wave_review, omr_record_wave_review) — the wave tools operate on the active ad-hoc plan.
- Submit omr_submit_findings_report once at the end with title "/${name} result".
${adhocCommandInstructions(name)}`
}

export function learnStylePrompt(args: string): string {
	return `You are running the oh-my-roadmap /omr:learn-style command.

User arguments:
${args || '(none)'}

Goal: learn how this codebase's author writes code and record concise per-language style guidance for future oh-my-roadmap workers.

- Dispatch the built-in task tool with agent "style-scout" and a prompt instructing it to explore this repository and record per-language code style. If the user arguments name specific paths or languages, scope the scout to those.
- The style-scout agent inspects representative real source files and calls omr_set_style once per language it has enough evidence for; it writes nothing else.
- Do not invent style guidance yourself. Rely on the scout's inspection of real files; if it cannot find enough evidence for a language, that language is skipped.
- When the scout returns, report which languages were recorded and a short highlight for each. Do not dump file contents or tool transcripts.`
}

export function commandPrompt(name: string, args: string, report: string, transportResumeAttempts = 3, resumeNote = ''): string {
	return `You are operating the oh-my-roadmap OMP extension command /${name}.

User arguments:
${args || '(none)'}

Current oh-my-roadmap state:
${report}
${resumeNote}
Follow the oh-my-roadmap workflow strictly:
- Do not assume missing planning details.
- Inspect existing code and documentation before planning or changing state.
- Use the built-in ask tool to interview the user whenever additional information, decisions, tradeoffs, gaps, approvals, or unresolved questions remain.
- During planning, interview for intent, not just mechanics: beyond "how would you like to handle X" questions, explore why the work matters and what success looks like, the desired user experience or layout for user-facing work, the preferred package/module/directory structure, and how much room to grow to build in without over-engineering. Treat these as illustrative examples, not a checklist or universally applicable — pursue the ones that fit and any others needed to understand the full picture, and skip the ones that do not apply.
- Never guess about out-of-project resources. When work touches an SDK, dependency, API, CLI, or other external resource, do not assume the shape of a response, the functions or types it exposes, or that an endpoint or option exists. Ask the user for documentation links or file paths and ground decisions in them; record what you consulted and what is still needed under an Assumptions & External Dependencies section. Widely known, stable concepts are exempt. State assumptions and unknowns explicitly.
- Reference relevant existing code and documentation paths in roadmap, milestone, change, review, and closeout artifacts when those references help future agents.
- Use omr_read_state for orientation before changing state when context is unclear, and always pick the narrowest scope that answers your question: roadmap for roadmap work, active_milestone for milestone/implementation planning, active_wave for a single wave's tasks/blockers/worker notes, active_change for change requests, usage for token accounting, and compact only when a broad snapshot is genuinely required.
- Use omr_search_context for roadmap sections, plan sections, decisions, risks, notes, issues, and review findings; use omr_read_context only for selected entries that need full detail. Do not read full roadmap.md or plan.md directly unless the section tools cannot answer the question.
- Use omr_validate before asking for approval or opening implementation.
- Use omr_update_roadmap to finalize a detailed generated roadmap before asking for roadmap approval.
- For roadmap planning, each milestone outline must group multiple meaningful deliverables or workstreams that belong together; do not create a separate milestone for one small edit, isolated cleanup, or one narrow task.
- Use omr_transition, omr_amend, omr_append_note, or omr_create_change_request for state changes.
- Record discovery with omr_transition operation record_discovery before roadmap approval.
- For milestone and change planning, define concrete executable tasks before dependency analysis or wave creation; each task needs objective, implementation notes, done criteria, task verification commands, dependencies, exclusive ownership, shared interfaces, and worker assignment.
- For milestone and change planning, assign each task to exactly one of worker-light, worker, or worker-heavy based on risk and blast radius.
- Before milestone or change approval, dispatch wave-flow-checker, record its result with record_wave_flow_check, and revise draft plans with update_milestone_plan or update_change_request_plan until the check passes.
- For milestone planning, explicitly ask the user what test coverage they want based on the implementation tasks: which areas should create tests, which should run existing tests, what detail those tests should cover, and what coverage is intentionally deferred or not required.
- For implementation progress, prefer omr_prepare_wave_dispatch, omr_record_wave_result, omr_prepare_wave_review, and omr_record_wave_review; use update_task_status, update_wave_status, and update_implementation_progress only for manual recovery.
- For implementation resume, treat the persisted progress cursor as authoritative for active wave, orchestration step, active tasks, and blocker reason.
- Before closing milestones or changes, record structured closeout evidence with record_closeout.
- For milestone and change implementation, do not edit files yourself; call the wave orchestration tools, dispatch each returned task to the exact agent named by assignment.worker, dispatch reviewer for wave reviews, and collect evidence closeout.
- If implementation is not legally open, do not edit files.

Before finishing this slash-command turn:
- Call omr_submit_findings_report exactly once after completing the command task or determining the terminal blocked/error/needs-input state, and before your final response.
- Use title: "/${name} result".
- Use markdown for the durable user-visible command result only: outcome, next commands/actions, and any blocker/error state. Do not include a tool-call audit trail unless it is part of the command result.
${commandSpecificInstructions(name, transportResumeAttempts)}`
}
