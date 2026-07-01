import {withDiagnosticTiming} from '../../diagnostics'
import {nowIso, openBlocker, type OpenBlockerInput, transition,} from '../store/index'
import type {ChangeRequest, MilestonePlan, TaskPlan, WorkerRun, WorkerRunStatus} from '../types'
import {ACTIVE_WORKER_RUN_STATUSES, activePlanContext, type ActivePlanContext, writePlanRuntime,} from './context'
import {notesText} from './dispatch'
import type {RecordWaveResultInput, RecordWaveResultResult} from './types'
import {writeProgressWithRuns} from './worker-runs'

function activeIncompleteTaskIds(tasks: TaskPlan[]): string[] {
	return tasks.filter((task) => task.status !== 'done').map((task) => task.id)
}

function blockerInputForTask(
	ctx: ActivePlanContext,
	task: TaskPlan,
	input: RecordWaveResultInput,
): OpenBlockerInput {
	const reason =
		input.blocker?.description ?? (notesText(input.notes) || input.summary || `${task.id} reported ${input.status}`)
	return {
		roadmapId: ctx.roadmapId,
		milestoneId: ctx.milestoneId,
		...(ctx.changeRequestId ? {changeRequestId: ctx.changeRequestId} : {}),
		taskId: task.id,
		waveId: ctx.activeWave.id,
		severity: 'blocking',
		title: input.blocker?.title ?? `Task ${task.id} ${input.status}`,
		description: reason,
		createdBy: task.worker,
	}
}

function closeWorkerRunForTask(plan: MilestonePlan | ChangeRequest, taskId: string, status: WorkerRunStatus): WorkerRun[] {
	const now = nowIso()
	let closed = false
	return plan.progress.worker_runs.map((run) => {
		if (closed || run.task_id !== taskId || !ACTIVE_WORKER_RUN_STATUSES.has(run.status)) return run
		closed = true
		return {
			...run,
			status,
			updated_at: now,
		}
	})
}

export async function recordWaveResult(
	cwd: string,
	input: RecordWaveResultInput,
): Promise<RecordWaveResultResult> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'wave.recordWaveResult',
		cwd,
		slowMs: 250,
		metadata: {task_id: input.taskId, status: input.status},
	}, async () => {
		const ctx = await activePlanContext(cwd, input)
		const task = ctx.activeTasks.find((candidate) => candidate.id === input.taskId)
		if (!task) throw new Error(`Task ${input.taskId} is not in active wave ${ctx.activeWave.id}`)
		if (ctx.activeWave.status === 'complete') throw new Error(`Active wave ${ctx.activeWave.id} is already complete`)

		if (input.status === 'completed') {
			await transition(cwd, {
				operation: 'update_task_status',
				taskId: task.id,
				taskStatus: 'done',
				...(input.summary ? {summary: input.summary} : {}),
			})
			const updated = await activePlanContext(cwd, input)
			const remaining = activeIncompleteTaskIds(updated.activeTasks)
			const workerRuns = closeWorkerRunForTask(updated.plan, task.id, 'completed')
			if (remaining.length === 0) {
				await writeProgressWithRuns(cwd, updated, workerRuns, [], updated.plan.tasks, 'wave_review')
				return {
					task_id: task.id,
					status: 'done',
					wave_id: updated.activeWave.id,
					wave_status: updated.activeWave.status,
					progress_step: 'wave_review',
				}
			}
			await writeProgressWithRuns(cwd, updated, workerRuns, remaining, updated.plan.tasks, 'workers_running')
			return {
				task_id: task.id,
				status: 'done',
				wave_id: updated.activeWave.id,
				wave_status: updated.activeWave.status,
				progress_step: 'workers_running',
			}
		}

		await transition(cwd, {
			operation: 'update_task_status',
			taskId: task.id,
			taskStatus: 'blocked',
			...(input.summary ? {summary: input.summary} : {}),
		})
		await transition(cwd, {operation: 'update_wave_status', waveId: ctx.activeWave.id, waveStatus: 'blocked'})
		const blocker = await openBlocker(cwd, blockerInputForTask(ctx, task, input))
		const updated = await activePlanContext(cwd, input)
		const workerRuns = closeWorkerRunForTask(updated.plan, task.id, input.status === 'failed' ? 'failed' : 'blocked')
		await writePlanRuntime(cwd, {
			...updated.plan,
			progress: {
				...updated.plan.progress,
				active_wave_id: updated.activeWave.id,
				step: 'resolving_blockers',
				active_task_ids: [task.id],
				worker_runs: workerRuns,
				blocked_reason: blocker.title,
				updated_at: nowIso(),
			},
		})
		return {
			task_id: task.id,
			status: 'blocked',
			wave_id: ctx.activeWave.id,
			wave_status: 'blocked',
			progress_step: 'resolving_blockers',
			blocker,
		}
	})
}
