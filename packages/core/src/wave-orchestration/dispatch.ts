import {withDiagnosticTiming} from '../diagnostics'
import {nowIso, transition} from '../store/index'
import type {ImplementationProgressStep, TaskPlan, WorkerRun} from '../types'
import {
	activePlanContext,
	type ActivePlanContext,
	activeWorkerRuns,
	assertDependenciesComplete,
	assertDispatchableWave,
	assertImplementationReady,
	assertTaskDispatchFields,
} from './context'
import type {
	PlanDerivedManifest,
	PrepareWaveDispatchResult,
	PrepareWorkerRedispatchInput,
	PrepareWorkerRedispatchResult,
	VerificationPreflightHint,
	WaveOrchestrationTargetInput,
	WaveWorkerAssignment,
} from './types'
import {replaceWorkerRun, requireTaskInActiveWave, writeProgressWithRuns} from './worker-runs'

export function notesText(notes: string[] | undefined): string {
	return notes && notes.length > 0 ? notes.join('\n') : ''
}

export interface WorkerContinuation {
	priorAgentId: string;
	transportFailures: number;
	lastError?: string;
}

function continuationSection(continuation: WorkerContinuation): string {
	return `

CONTINUATION CONTEXT:
- You are replacing a prior worker (${continuation.priorAgentId}) that hit ${continuation.transportFailures} transport failure(s)${continuation.lastError ? ` (last error: ${continuation.lastError})` : ''} and could not recover in place.
- Read history://${continuation.priorAgentId} FIRST. If the prior attempt had already started editing, its edits are on the active branch (workers run on the active branch with no worktree); if it had not started editing, that transcript is your read/exploration head-start so you need not re-discover the codebase from scratch.
- Do not assume disk edits exist. Inspect the current file state (git status/diff, read your owned files) before editing; do not redo completed work; continue from the last incomplete step.
- The prior owner ${continuation.priorAgentId} may still be live. Before editing any owned file, confirm via irc op:list / op:send that the prior peer is stopped — do not rely on roadmap state saying "abandoned" (state can report abandoned while the peer is demonstrably still editing).`
}

function reservedSiblingScope(ctx: ActivePlanContext, task: TaskPlan): string[] {
	const reserved = new Set<string>()
	for (const sibling of ctx.activeTasks) {
		if (sibling.id === task.id) continue
		for (const owner of [...sibling.owned_files, ...sibling.owned_modules]) reserved.add(owner)
	}
	return [...reserved]
}

// CLIs whose availability we must not assume; commands starting with one of these get a warning.
const CLI_ASSUMPTION_TOOLS = new Set<string>([
	'psql',
	'mysql',
	'redis-cli',
	'docker',
	'kubectl',
	'aws',
	'gcloud',
	'az',
	'curl',
])

const VERIFICATION_PREFLIGHT_GUIDANCE =
	'Run assigned verification when practical. If a verification command depends on an unavailable external CLI or service, stop and append a blocking note with the missing prerequisite instead of inventing a substitute.'

export function manifestForTask(ctx: ActivePlanContext, task: TaskPlan): PlanDerivedManifest {
	return {
		owned_files: task.owned_files,
		owned_modules: task.owned_modules,
		shared_interfaces: task.shared_interfaces,
		dependencies: task.depends_on,
		reserved_sibling_scope: reservedSiblingScope(ctx, task),
		relevant_existing_code: ctx.plan.relevant_existing_code,
		relevant_documentation: ctx.plan.relevant_documentation,
	}
}

export function verificationPreflightFor(commands: string[]): VerificationPreflightHint {
	const cliAssumptionWarnings: string[] = []
	const seen = new Set<string>()
	for (const command of commands) {
		const firstToken = command.trim().split(/\s+/)[0]
		if (firstToken && CLI_ASSUMPTION_TOOLS.has(firstToken) && !seen.has(firstToken)) {
			seen.add(firstToken)
			cliAssumptionWarnings.push(
				`Do not assume ${firstToken} is installed; prefer repo-native helpers or configured MCP/tools unless the plan explicitly requires this CLI.`,
			)
		}
	}
	return {
		commands,
		cli_assumption_warnings: cliAssumptionWarnings,
		guidance: [VERIFICATION_PREFLIGHT_GUIDANCE],
	}
}

function listOrNone(items: string[]): string {
	return items.length > 0 ? items.join(', ') : '(none)'
}

export function manifestPromptSection(manifest: PlanDerivedManifest): string {
	return `Plan-derived manifest:
- Owned files: ${listOrNone(manifest.owned_files)}
- Owned modules: ${listOrNone(manifest.owned_modules)}
- Shared interfaces: ${listOrNone(manifest.shared_interfaces)}
- Dependencies: ${listOrNone(manifest.dependencies)}
- Reserved sibling scope: ${listOrNone(manifest.reserved_sibling_scope)}
- Relevant existing code: ${listOrNone(manifest.relevant_existing_code)}
- Relevant documentation: ${listOrNone(manifest.relevant_documentation)}
This manifest is plan-derived and is NOT proof that any listed path exists. If a path is not in this manifest or prior tool output, use glob or omr_search_context to locate it before you read it.`
}

export function verificationPreflightPromptSection(preflight: VerificationPreflightHint): string {
	const warnings = preflight.cli_assumption_warnings.length > 0
		? preflight.cli_assumption_warnings.map((item) => `- ${item}`).join('\n')
		: '- (none)'
	return `Verification preflight:
Commands:
${preflight.commands.length > 0 ? preflight.commands.map((item) => `- ${item}`).join('\n') : '- (none)'}
CLI assumption warnings:
${warnings}
Guidance:
${preflight.guidance.map((item) => `- ${item}`).join('\n')}
If an external CLI warning appears above, do not shell out to that CLI unless the plan explicitly requires it or a repo-native helper is unavailable and the CLI is confirmed to exist.`
}

function workerPrompt(
	ctx: ActivePlanContext,
	task: TaskPlan,
	continuation?: WorkerContinuation,
): string {
	const reserved = reservedSiblingScope(ctx, task)
	const manifestSection = manifestPromptSection(manifestForTask(ctx, task))
	const preflightSection = verificationPreflightPromptSection(verificationPreflightFor(task.verification_commands))
	const scopeHeader = ctx.isAdhoc
		? `Ad-hoc plan: ${ctx.roadmapId}\n`
		: `Roadmap: ${ctx.roadmapId}\nMilestone: ${ctx.milestoneId}\n${ctx.changeRequestId ? `Change request: ${ctx.changeRequestId}\n` : ''}`
	const base = `You are ${task.worker} for oh-my-roadmap task ${task.id}: ${task.title}.

${scopeHeader}Wave: ${ctx.activeWave.id} - ${ctx.activeWave.goal}

Objective:
${task.objective}

Implementation notes:
${task.implementation_notes.map((item) => `- ${item}`).join('\n')}

Done criteria:
${task.done_criteria.map((item) => `- ${item}`).join('\n')}

Verification commands:
${task.verification_commands.map((item) => `- ${item}`).join('\n')}

Ownership:
- Owned files: ${task.owned_files.length > 0 ? task.owned_files.join(', ') : '(none)'}
- Owned modules: ${task.owned_modules.length > 0 ? task.owned_modules.join(', ') : '(none)'}
- Shared interfaces: ${task.shared_interfaces.length > 0 ? task.shared_interfaces.join(', ') : '(none)'}
- Dependencies: ${task.depends_on.length > 0 ? task.depends_on.join(', ') : '(none)'}

Reserved by concurrent sibling tasks in THIS wave (do not edit): ${reserved.length > 0 ? reserved.join(', ') : '(none)'}

${manifestSection}

${preflightSection}

You own the files and modules listed above. You may also edit files owned by OTHER waves if your task genuinely requires it — waves run strictly sequentially, so those waves are already complete or have not yet started and no concurrent worker holds their files. Do NOT edit the files/modules reserved by concurrent sibling tasks in THIS wave; those workers are running now and editing them would collide. Only append a blocking note if you need something genuinely outside the plan or a required decision is ambiguous. Report completed, failed, or blocked status with a concise summary, verification run, and any blocker details for the orchestrator to record with omr_record_wave_result.`
	return continuation ? `${base}${continuationSection(continuation)}` : base
}

function assignment(ctx: ActivePlanContext, task: TaskPlan, continuation?: WorkerContinuation): WaveWorkerAssignment {
	return {
		task_id: task.id,
		title: task.title,
		worker: task.worker,
		owned_files: task.owned_files,
		owned_modules: task.owned_modules,
		shared_interfaces: task.shared_interfaces,
		dependencies: task.depends_on,
		manifest: manifestForTask(ctx, task),
		verification_preflight: verificationPreflightFor(task.verification_commands),
		prompt: workerPrompt(ctx, task, continuation),
	}
}

export async function setProgress(
	cwd: string,
	ctx: ActivePlanContext,
	step: ImplementationProgressStep,
	activeTaskIds: string[],
	blockedReason?: string,
): Promise<void> {
	await transition(cwd, {
		operation: 'update_implementation_progress',
		progress: {
			activeWaveId: ctx.activeWave.id,
			step,
			activeTaskIds,
			...(blockedReason ? {blockedReason} : {}),
		},
	})
}

export async function prepareWaveDispatch(
	cwd: string,
	input: WaveOrchestrationTargetInput = {},
): Promise<PrepareWaveDispatchResult> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'wave.prepareWaveDispatch',
		cwd,
		slowMs: 250,
	}, async () => {
		await assertImplementationReady(cwd)
		const ctx = await activePlanContext(cwd, input)
		assertDispatchableWave(ctx)

		const incompleteTasks = ctx.activeTasks.filter((task) => task.status !== 'done')
		if (incompleteTasks.length === 0) {
			throw new Error(`Active wave ${ctx.activeWave.id} has no incomplete tasks to dispatch`)
		}
		for (const task of incompleteTasks) {
			assertTaskDispatchFields(task)
			assertDependenciesComplete(ctx.plan, task)
		}
		const activeRuns = activeWorkerRuns(ctx.plan).filter((run) => run.wave_id === ctx.activeWave.id)
		if (activeRuns.length > 0) {
			await setProgress(cwd, ctx, 'workers_running', activeRuns.map((run) => run.task_id))
			return {
				roadmap_id: ctx.roadmapId,
				milestone_id: ctx.milestoneId,
				...(ctx.changeRequestId ? {change_request_id: ctx.changeRequestId} : {}),
				wave_id: ctx.activeWave.id,
				wave_goal: ctx.activeWave.goal,
				progress_step: 'workers_running',
				assignments: [],
				active_runs: activeRuns,
				instructions:
					'Do not redispatch tasks with active worker runs. First check the current session\'s background jobs and IRC peers for each run\'s job_id or agent_id. If neither background jobs nor IRC peers list the run, record it abandoned immediately; do not poll, probe, or wait. Only poll or probe runs that exist in the current session. If an existing current-session run has a transport failure, record transport_failed, then prefer waking the existing worker: irc op:list to find its peer, op:send it a narrow "resume from your existing transcript" message (never broadcast to:"all"), and wait up to 2 minutes for recovery. Re-resume the same worker up to the configured resume cap before abandoning; an ack is a liveness signal, not grounds to abandon, and op:list peer status (not the job tool) is the liveness authority. Do not record a transport failure as a wave result; that opens a blocker. Only after the cap is hit or a fresh op:list confirms the peer is gone, stop the peer and record abandoned, then use omr_prepare_worker_redispatch before redispatching only that task.',
			}
		}

		if (ctx.activeWave.status === 'pending') {
			await transition(cwd, {operation: 'update_wave_status', waveId: ctx.activeWave.id, waveStatus: 'running'})
		}
		await setProgress(cwd, ctx, 'dispatching', incompleteTasks.map((task) => task.id))

		return {
			roadmap_id: ctx.roadmapId,
			milestone_id: ctx.milestoneId,
			...(ctx.changeRequestId ? {change_request_id: ctx.changeRequestId} : {}),
			wave_id: ctx.activeWave.id,
			wave_goal: ctx.activeWave.goal,
			progress_step: 'dispatching',
			assignments: incompleteTasks.map((task) => assignment(ctx, task)),
			active_runs: [],
			instructions:
				'Dispatch each assignment as a background job using the assignment\'s exact worker and prompt. Immediately call omr_record_worker_dispatch with the returned agentId and jobId before polling workers.',
		}
	})
}

export async function prepareWorkerRedispatch(
	cwd: string,
	input: PrepareWorkerRedispatchInput,
): Promise<PrepareWorkerRedispatchResult> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'wave.prepareWorkerRedispatch',
		cwd,
		slowMs: 250,
		metadata: {task_id: input.taskId},
	}, async () => {
		await assertImplementationReady(cwd)
		const ctx = await activePlanContext(cwd, input)
		const task = requireTaskInActiveWave(ctx, input.taskId)

		// Core guard: never redispatch while a run for this task is still running.
		const runningForTask = ctx.plan.progress.worker_runs.filter(
			(run) => run.task_id === task.id && run.status === 'running',
		)
		if (runningForTask.length > 0) {
			throw new Error(`Task ${task.id} still has a running worker; stop and abandon it before redispatch`)
		}

		// Find the prior transport_failed run to replace.
		const failedRuns = ctx.plan.progress.worker_runs.filter((run) =>
			run.task_id === task.id &&
			run.status === 'transport_failed' &&
			(input.agentId === undefined || run.agent_id === input.agentId) &&
			(input.jobId === undefined || run.job_id === input.jobId)
		)
		if (failedRuns.length === 0) {
			throw new Error(`Task ${task.id} has no transport_failed worker run to redispatch`)
		}
		if (failedRuns.length > 1) {
			throw new Error(`Task ${task.id} has multiple transport_failed worker runs; include agentId or jobId`)
		}
		const prior = failedRuns[0]
		if (!prior) throw new Error(`Task ${task.id} has no transport_failed worker run to redispatch`)

		// Atomically flip the prior run to abandoned and drop it from active_task_ids.
		const abandoned: WorkerRun = {
			...prior,
			status: 'abandoned',
			updated_at: nowIso(),
		}
		const activeTaskIds = ctx.plan.progress.active_task_ids.filter((taskId) => taskId !== prior.task_id)
		await writeProgressWithRuns(
			cwd,
			ctx,
			replaceWorkerRun(ctx.plan.progress.worker_runs, abandoned),
			activeTaskIds,
			ctx.plan.tasks,
			activeTaskIds.length > 0 ? 'workers_running' : 'dispatching',
		)

		// Reload context and build the continuation assignment for the replacement worker.
		const reloaded = await activePlanContext(cwd, input)
		const reloadedTask = requireTaskInActiveWave(reloaded, input.taskId)
		const continuation: WorkerContinuation = {
			priorAgentId: prior.agent_id,
			transportFailures: prior.transport_failures ?? 0,
			...(prior.last_error ? {lastError: prior.last_error} : {}),
		}
		return {
			roadmap_id: reloaded.roadmapId,
			milestone_id: reloaded.milestoneId,
			...(reloaded.changeRequestId ? {change_request_id: reloaded.changeRequestId} : {}),
			wave_id: reloaded.activeWave.id,
			assignment: assignment(reloaded, reloadedTask, continuation),
			prior_run: {
				agent_id: prior.agent_id,
				job_id: prior.job_id,
				transport_failures: prior.transport_failures ?? 0,
				...(prior.last_error ? {last_error: prior.last_error} : {}),
			},
			instructions:
				`Spawn the replacement as a background job using the assignment's exact worker and prompt (the prompt carries CONTINUATION CONTEXT, the prior worker's history://${prior.agent_id} transcript pointer, and a live-peer coordination warning). Only spawn after the prior peer is stopped and confirmed gone via irc op:list. Then call omr_record_worker_dispatch with the new agentId and jobId and replacesAgentId set to ${prior.agent_id}.`,
		}
	})
}
