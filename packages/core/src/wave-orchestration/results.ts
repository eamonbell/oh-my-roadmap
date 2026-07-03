import {withDiagnosticTiming} from '../diagnostics'
import {searchContext} from '../context'
import {nowIso, openBlocker, type OpenBlockerInput, reconcileTaskNotes, transition,} from '../store/index'
import type {TaskPlan, WorkerRun, WorkerRunStatus} from '../types'
import {ACTIVE_WORKER_RUN_STATUSES, activePlanContext, type ActivePlanContext, type WaveOrchestrationPlan, writePlanRuntime,} from './context'
import {notesText} from './dispatch'
import type {RecordWaveResultInput, RecordWaveResultResult} from './types'
import {writeProgressWithRuns} from './worker-runs'

function activeIncompleteTaskIds(tasks: TaskPlan[]): string[] {
	return tasks.filter((task) => task.status !== 'done').map((task) => task.id)
}

// Durable result handoff: when the orchestrator cannot get a summary from the worker's
// live IRC reply (a completed worker may have already terminated — "Unknown or terminated
// agent"), source the summary from the worker's own persisted note in state instead of
// forcing the orchestrator to reconstruct it. Returns the most recent worker note body
// for the task, if any.
async function summaryFromWorkerNote(cwd: string, milestoneId: string, taskId: string): Promise<string | undefined> {
	const found = await searchContext(cwd, {
		artifacts: ['notes'],
		kinds: ['worker'],
		milestoneIds: [milestoneId],
		taskId,
		includeBodies: true,
		maxResults: 1,
	})
	const note = found.results[0]
	if (!note) return undefined
	const text = (note.body ?? note.snippet ?? '').trim()
	return text || undefined
}

function blockerInputForTask(
	ctx: ActivePlanContext,
	task: TaskPlan,
	input: RecordWaveResultInput,
	summary: string | undefined,
): OpenBlockerInput {
	const reason =
		input.blocker?.description ?? (notesText(input.notes) || summary || `${task.id} reported ${input.status}`)
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

function closeWorkerRunForTask(plan: WaveOrchestrationPlan, taskId: string, status: WorkerRunStatus): WorkerRun[] {
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

		const summary = input.summary?.trim()
			? input.summary
			: await summaryFromWorkerNote(cwd, ctx.milestoneId, input.taskId)

		if (input.status === 'completed') {
			await transition(cwd, {
				operation: 'update_task_status',
				taskId: task.id,
				taskStatus: 'done',
				...(summary ? {summary} : {}),
			})
			// Retract any superseded issue note left on this now-done task by a stood-down run.
			await reconcileTaskNotes(cwd, ctx.roadmapId, ctx.milestoneId, task.id)
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
					...(summary ? {summary} : {}),
				}
			}
			await writeProgressWithRuns(cwd, updated, workerRuns, remaining, updated.plan.tasks, 'workers_running')
			return {
				task_id: task.id,
				status: 'done',
				wave_id: updated.activeWave.id,
				wave_status: updated.activeWave.status,
				progress_step: 'workers_running',
				...(summary ? {summary} : {}),
			}
		}

		await transition(cwd, {
			operation: 'update_task_status',
			taskId: task.id,
			taskStatus: 'blocked',
			...(summary ? {summary} : {}),
		})
		await transition(cwd, {operation: 'update_wave_status', waveId: ctx.activeWave.id, waveStatus: 'blocked'})
		const blocker = await openBlocker(cwd, blockerInputForTask(ctx, task, input, summary))
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
			...(summary ? {summary} : {}),
			blocker,
		}
	})
}
