import {withDiagnosticTiming} from '../diagnostics'
import {nowIso} from '../store/index'
import type {ImplementationProgressStep, TaskPlan, WorkerRun} from '../types'
import {
	activePlanContext,
	type ActivePlanContext,
	activeWorkerRuns,
	assertDependenciesComplete,
	assertTaskDispatchFields,
	hasOverlap,
	updateTaskStatusLocal,
	writePlanRuntime,
} from './context'
import type {RecordWorkerDispatchInput, RecordWorkerRunResult, RecordWorkerRunStatusInput,} from './types'

export function requireTaskInActiveWave(ctx: ActivePlanContext, taskId: string): TaskPlan {
	const task = ctx.activeTasks.find((candidate) => candidate.id === taskId)
	if (!task) throw new Error(`Task ${taskId} is not in active wave ${ctx.activeWave.id}`)
	return task
}

export function requireActiveWorkerRun(
	ctx: ActivePlanContext,
	input: RecordWorkerRunStatusInput,
): WorkerRun {
	const matches = activeWorkerRuns(ctx.plan).filter((run) =>
		run.task_id === input.taskId &&
		(input.agentId === undefined || run.agent_id === input.agentId) &&
		(input.jobId === undefined || run.job_id === input.jobId)
	)
	if (matches.length === 0) throw new Error(`Task ${input.taskId} has no matching active worker run`)
	if (matches.length > 1) throw new Error(`Task ${input.taskId} has multiple matching active worker runs; include agentId or jobId`)
	const run = matches[0]
	if (!run) throw new Error(`Task ${input.taskId} has no matching active worker run`)
	return run
}

export function replaceWorkerRun(runs: WorkerRun[], replacement: WorkerRun): WorkerRun[] {
	return runs.map((run) =>
		run.task_id === replacement.task_id && run.agent_id === replacement.agent_id && run.job_id === replacement.job_id
			? replacement
			: run
	)
}

export async function writeProgressWithRuns(
	cwd: string,
	ctx: ActivePlanContext,
	workerRuns: WorkerRun[],
	activeTaskIds: string[],
	tasks: TaskPlan[] = ctx.plan.tasks,
	step: ImplementationProgressStep = ctx.plan.progress.step,
): Promise<void> {
	await writePlanRuntime(cwd, {
		...ctx.plan,
		tasks,
		progress: {
			...ctx.plan.progress,
			active_wave_id: ctx.activeWave.id,
			step,
			active_task_ids: activeTaskIds,
			worker_runs: workerRuns,
			updated_at: nowIso(),
		},
	})
}

export function assertNoActiveOwnershipOverlap(ctx: ActivePlanContext, task: TaskPlan): void {
	for (const run of activeWorkerRuns(ctx.plan)) {
		if (run.task_id === task.id) throw new Error(`Task ${task.id} already has an active worker run`)
		if (hasOverlap(task.owned_files, run.owned_files)) {
			throw new Error(`Task ${task.id} overlaps active worker run ${run.task_id} owned files`)
		}
		if (hasOverlap(task.owned_modules, run.owned_modules)) {
			throw new Error(`Task ${task.id} overlaps active worker run ${run.task_id} owned modules`)
		}
	}
}

export async function recordWorkerDispatch(
	cwd: string,
	input: RecordWorkerDispatchInput,
): Promise<RecordWorkerRunResult> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'wave.recordWorkerDispatch',
		cwd,
		slowMs: 250,
		metadata: {task_id: input.taskId, agent_id: input.agentId, job_id: input.jobId},
	}, async () => {
		const ctx = await activePlanContext(cwd, input)
		const task = requireTaskInActiveWave(ctx, input.taskId)
		assertTaskDispatchFields(task)
		assertDependenciesComplete(ctx.plan, task)
		assertNoActiveOwnershipOverlap(ctx, task)

		const now = nowIso()
		const run: WorkerRun = {
			task_id: task.id,
			wave_id: ctx.activeWave.id,
			worker: task.worker,
			agent_id: input.agentId,
			job_id: input.jobId,
			owned_files: task.owned_files,
			owned_modules: task.owned_modules,
			status: 'running',
			started_at: now,
			updated_at: now,
			transport_failures: 0,
			...(input.replacesAgentId ? {replaces_agent_id: input.replacesAgentId} : {}),
		}
		const tasks = updateTaskStatusLocal(ctx.plan.tasks, task.id, 'started')
		const activeTaskIds = Array.from(new Set([...ctx.plan.progress.active_task_ids, task.id]))
		await writeProgressWithRuns(cwd, ctx, [...ctx.plan.progress.worker_runs, run], activeTaskIds, tasks, 'workers_running')
		return {
			task_id: task.id,
			wave_id: ctx.activeWave.id,
			run,
			progress_step: 'workers_running',
		}
	})
}

export async function recordWorkerTransportFailed(
	cwd: string,
	input: RecordWorkerRunStatusInput,
): Promise<RecordWorkerRunResult> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'wave.recordWorkerTransportFailed',
		cwd,
		slowMs: 250,
		metadata: {task_id: input.taskId},
	}, async () => {
		const ctx = await activePlanContext(cwd, input)
		const current = requireActiveWorkerRun(ctx, input)
		const run: WorkerRun = {
			...current,
			status: 'transport_failed',
			updated_at: nowIso(),
			transport_failures: (current.transport_failures ?? 0) + 1,
			...(input.lastError ? {last_error: input.lastError} : {}),
		}
		await writeProgressWithRuns(
			cwd,
			ctx,
			replaceWorkerRun(ctx.plan.progress.worker_runs, run),
			Array.from(new Set([...ctx.plan.progress.active_task_ids, run.task_id])),
			ctx.plan.tasks,
			'workers_running',
		)
		return {
			task_id: run.task_id,
			wave_id: run.wave_id,
			run,
			progress_step: 'workers_running',
		}
	})
}

export async function recordWorkerAbandoned(
	cwd: string,
	input: RecordWorkerRunStatusInput,
): Promise<RecordWorkerRunResult> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'wave.recordWorkerAbandoned',
		cwd,
		slowMs: 250,
		metadata: {task_id: input.taskId},
	}, async () => {
		const ctx = await activePlanContext(cwd, input)
		const current = requireActiveWorkerRun(ctx, input)
		const run: WorkerRun = {
			...current,
			status: 'abandoned',
			updated_at: nowIso(),
			...(input.lastError ? {last_error: input.lastError} : current.last_error ? {last_error: current.last_error} : {}),
		}
		const activeTaskIds = ctx.plan.progress.active_task_ids.filter((taskId) => taskId !== run.task_id)
		await writeProgressWithRuns(
			cwd,
			ctx,
			replaceWorkerRun(ctx.plan.progress.worker_runs, run),
			activeTaskIds,
			ctx.plan.tasks,
			activeTaskIds.length > 0 ? 'workers_running' : 'dispatching',
		)
		return {
			task_id: run.task_id,
			wave_id: run.wave_id,
			run,
			progress_step: activeTaskIds.length > 0 ? 'workers_running' : 'dispatching',
		}
	})
}
