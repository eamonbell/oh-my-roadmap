import { REPO_PRIMER_USE_RULE, REVIEWER_REWORK_RULE, SCOUT_RECORDING_RULE, workerReworkRule } from './rule-text'

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
- If the current roadmap phase is milestone_approved, first call omr_transition with operation start_implementation; do not call omr_prepare_wave_dispatch until implementation is legally open.
- If the active change request status is approved, first call omr_transition with operation start_implementation before dispatching change-request workers.
- At implementation start, before the first wave dispatch, run the plan's verification commands once and record the results with omr_record_verification_baseline (including any pre-existing failing tests/counts), so later wave reviews can judge results relative to this baseline (no new failures, no lost passes) instead of an absolute bar.
- If the current phase is reviewing or closeout, do not dispatch workers; follow omr_next_action and closeout next actions instead.
- Call omr_prepare_wave_dispatch before dispatching implementation work. If it returns active_runs, do not redispatch those tasks.
- For each active run, first check the current session's hub job snapshot (op:jobs) and peer roster (op:list) for the run's jobId/job_id or agentId/agent_id. If neither the hub op:jobs snapshot nor the op:list peer roster lists that run, call omr_record_worker_abandoned immediately; do not poll, probe, or wait. Only poll or probe runs that exist in the current session.
- Dispatch returned active-wave assignments as background subagents (the task tool, run in the background) using each assignment's exact worker and prompt.
- Immediately after each spawn, call omr_record_worker_dispatch with the returned agentId and jobId.
- Never redispatch a task until the prior worker run is completed, blocked, failed, cancelled, or abandoned.
- After dispatching all worker or reviewer subagents for the current wave and recording their job ids, if you are blocked waiting for them, issue one blocking hub op:wait for the relevant ids (or bare, for all running jobs) with a meaningful timeout. Do not loop short hub op:jobs polls; retry only after an interrupt, timeout, or new liveness evidence.
- Use hub op:list liveness checks only after a timeout/interruption or when state says a worker should exist but the job handle is absent.

${workerReworkRule(transportResumeAttempts)}
- After each worker returns real work, call omr_record_wave_result with completed, failed, or blocked status before taking any next orchestration step.
- Collect the result from state, not from a live hub reply. A worker writes its structured result to its persisted note before yielding, and may already have terminated ("Unknown or terminated agent") by the time you ask for its report. If the peer is gone, do NOT re-search or reconstruct the summary from scratch: call omr_record_wave_result for the task (omit summary when you have none) — it sources the summary from the worker's resolved note in state. Reserve a search only for extra detail you still need after that.

${REVIEWER_REWORK_RULE}
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
- When both values are present, call omr_resolve_blocker with the blocker ID and resolution. omr_resolve_blocker accepts a deferred blocker directly (deferred -> resolved), not only an open one; do not reopen a deferred blocker first when it is now genuinely fixed.
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
- Drive the whole plan this turn: loop omr_prepare_wave_dispatch -> dispatch each returned assignment to its exact worker as a background subagent (the task tool, run in the background) -> omr_record_worker_dispatch -> collect results with omr_record_wave_result -> omr_prepare_wave_review -> dispatch reviewer -> omr_record_wave_review, one wave at a time until no waves remain.
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

${REPO_PRIMER_USE_RULE}
- Use the ad-hoc tools (omr_init_adhoc, omr_update_adhoc_plan, omr_adhoc_transition) plus the shared wave tools (omr_prepare_wave_dispatch, omr_record_wave_result, omr_prepare_wave_review, omr_record_wave_review) — the wave tools operate on the active ad-hoc plan.
- For every task in an ad-hoc plan, provide a required \`relevant_existing_code\` array of exact \`{ path, line?, symbol?, note }\` pointers and a required \`shared_interface_contracts\` array of exact \`{ name, signature, source_path, line?, planned, planned_by_task_id? }\` contracts. For every \`planned: true\` contract, provide \`planned_by_task_id\` naming an owning producer task in a strictly earlier wave.
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
- Prefer the narrow flow scopes over broad reads: use omr_read_state scope phase for flow-control decisions, scope progress for implementation cursor checks, scope quality_gates before approvals, and scope closeout_requirements before closeout.
- Use omr_search_context for roadmap sections, plan sections, decisions, risks, notes, issues, and review findings; use omr_read_context only for selected entries that need full detail. Do not read full roadmap.md or plan.md directly unless the section tools cannot answer the question.
- For broad context discovery, start with omr_search_context mode: 'count' or mode: 'ids' to scope the result set, then expand to mode: 'snippets' or omr_read_context only for the selected IDs.
- Use omr_validate before asking for approval or opening implementation.
- Use omr_update_roadmap to finalize a detailed generated roadmap before asking for roadmap approval.
- For roadmap planning, each milestone outline must group multiple meaningful deliverables or workstreams that belong together; do not create a separate milestone for one small edit, isolated cleanup, or one narrow task.
- ${SCOUT_RECORDING_RULE}
${REPO_PRIMER_USE_RULE}
- Use omr_transition, omr_amend, omr_append_note, or omr_create_change_request for state changes.
- omr_* write tools ride the xd:// transport: emit exactly one JSON args object per call (e.g. write xd://omr_transition {"operation":"record_discovery","discovery":{"recorded":true}}) — no markdown code fences, comments, or trailing prose around the JSON.
- Record discovery with omr_transition operation record_discovery before roadmap approval.
- For milestone and change planning, define concrete executable tasks before dependency analysis or wave creation; each task needs objective, implementation notes, done criteria, task verification commands, dependencies, exclusive ownership, shared interfaces, worker assignment, a required \`relevant_existing_code\` array of exact \`{ path, line?, symbol?, note }\` pointers, and a required \`shared_interface_contracts\` array of exact \`{ name, signature, source_path, line?, planned, planned_by_task_id? }\` contracts. For every \`planned: true\` contract, provide \`planned_by_task_id\` naming an owning producer task in a strictly earlier wave.
- For milestone and change planning, assign each task to exactly one of worker-light, worker, or worker-heavy based on risk and blast radius.
- Before milestone or change approval, dispatch wave-flow-checker, record its result with record_wave_flow_check, and revise draft plans with update_milestone_plan or update_change_request_plan until the check passes.
- For milestone planning, explicitly ask the user what test coverage they want based on the implementation tasks: which areas should create tests, which should run existing tests, what detail those tests should cover, and what coverage is intentionally deferred or not required.
- For implementation progress, prefer omr_prepare_wave_dispatch, omr_record_wave_result, omr_prepare_wave_review, and omr_record_wave_review; use update_task_status, update_wave_status, and update_implementation_progress only for manual recovery.
- For implementation resume, treat the persisted progress cursor as authoritative for active wave, orchestration step, active tasks, and blocker reason.
- Before closing milestones or changes, call omr_prepare_closeout to get ordinal item IDs and an example_closeout template, fill the example_closeout with actual statuses and reasons, then call omr_transition operation record_closeout with that evidence.
- Workers self-verify before yielding: they always run LSP diagnostics on the files they touch, and may additionally run their task's own verification commands against their OWNED files only when their dispatch grants it (a single-worker wave, or a genuine rework) — never the full test suite, a whole-project build, or files they do not own while siblings are still running. Workers record command receipts (a Commands run: section and/or VERIFIED: lines) in their note. The reviewer verifies those receipts and re-runs the plan's milestone-level verification commands once, for the whole-wave integration pass.
- If a reviewer writes a temporary verification script or comparison command, make it print a clear PASS: or FAIL: line and exit non-zero only when the code must be revised; treat non-zero output with actionable diagnostics as test feedback, not an unexplained tool failure.
- For milestone and change implementation, do not edit files yourself; call the wave orchestration tools, dispatch each returned task to the exact agent named by assignment.worker, dispatch reviewer for wave reviews, and collect evidence closeout.
- If implementation is not legally open, do not edit files.

Before finishing this slash-command turn:
- Call omr_submit_findings_report exactly once after completing the command task or determining the terminal blocked/error/needs-input state, and before your final response.
- Use title: "/${name} result".
- Use markdown for the durable user-visible command result only: outcome, next commands/actions, and any blocker/error state. Do not include a tool-call audit trail unless it is part of the command result.
${commandSpecificInstructions(name, transportResumeAttempts)}`
}
