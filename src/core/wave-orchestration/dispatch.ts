import {withDiagnosticTiming} from '../../diagnostics'
import {transition} from '../store/index'
import type {ImplementationProgressStep, TaskPlan} from '../types'
import {
	activePlanContext,
	type ActivePlanContext,
	activeWorkerRuns,
	assertDependenciesComplete,
	assertDispatchableWave,
	assertImplementationReady,
	assertTaskDispatchFields,
} from './context'
import type {PrepareWaveDispatchResult, WaveOrchestrationTargetInput, WaveWorkerAssignment,} from './types'

export function notesText(notes: string[] | undefined): string {
	return notes && notes.length > 0 ? notes.join('\n') : ''
}

function workerPrompt(
	ctx: ActivePlanContext,
	task: TaskPlan,
): string {
	return `You are ${task.worker} for roadmap-engineer task ${task.id}: ${task.title}.

Roadmap: ${ctx.roadmapId}
Milestone: ${ctx.milestoneId}
${ctx.changeRequestId ? `Change request: ${ctx.changeRequestId}\n` : ''}Wave: ${ctx.activeWave.id} - ${ctx.activeWave.goal}

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

Work only on this task's scope. Report completed, failed, or blocked status with a concise summary, verification run, and any blocker details for the orchestrator to record with roadmap_engineer_record_wave_result.`
}

function assignment(ctx: ActivePlanContext, task: TaskPlan): WaveWorkerAssignment {
	return {
		task_id: task.id,
		title: task.title,
		worker: task.worker,
		owned_files: task.owned_files,
		owned_modules: task.owned_modules,
		shared_interfaces: task.shared_interfaces,
		dependencies: task.depends_on,
		prompt: workerPrompt(ctx, task),
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
					'Do not redispatch tasks with active worker runs. First check the current session\'s background jobs and IRC peers for each run\'s job_id or agent_id. If neither background jobs nor IRC peers list the run, record it abandoned immediately; do not poll, probe, or wait. Only poll or probe runs that exist in the current session. If an existing current-session run has a transport failure, record transport_failed, wait up to 2 minutes for recovery, then record abandoned before redispatching only that task.',
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
				'Dispatch each assignment as a background job using the assignment\'s exact worker and prompt. Immediately call roadmap_engineer_record_worker_dispatch with the returned agentId and jobId before polling workers.',
		}
	})
}
