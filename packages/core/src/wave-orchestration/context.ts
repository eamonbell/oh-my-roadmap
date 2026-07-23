import { loadState, writeAdhocRuntime, writeChangeRequestRuntime, writeMilestoneRuntime, } from '../store/index'
import { validateImplementationGate } from '../validation'
import type { AdhocPlan, ChangeRequest, LoadedState, MilestonePlan, TaskPlan, WavePlan, WorkerRun, WorkerRunStatus, } from '../types'
import { IMPLEMENTATION_WORKER_NAMES } from '../types'
import type { WaveOrchestrationTargetInput } from './types'

// Any plan the wave machinery can drive. Ad-hoc plans reuse the same tasks/waves/progress shape.
export type WaveOrchestrationPlan = MilestonePlan | ChangeRequest | AdhocPlan;

export interface ActivePlanContext {
	loaded: LoadedState;
	roadmapId: string;
	milestoneId: string;
	changeRequestId?: string;
	isAdhoc: boolean;
	plan: WaveOrchestrationPlan;
	activeWave: WavePlan;
	activeTasks: TaskPlan[];
}

export const WORKERS = new Set<string>(IMPLEMENTATION_WORKER_NAMES)
export const ACTIVE_WORKER_RUN_STATUSES = new Set<WorkerRunStatus>(['running', 'transport_failed'])

export function activeWorkerRuns(plan: WaveOrchestrationPlan): WorkerRun[] {
	return plan.progress.worker_runs.filter((run) => ACTIVE_WORKER_RUN_STATUSES.has(run.status))
}

export function hasOverlap(left: string[], right: string[]): boolean {
	const rightSet = new Set(right)
	return left.some((item) => rightSet.has(item))
}

export function updateTaskStatusLocal(tasks: TaskPlan[], taskId: string, status: TaskPlan['status']): TaskPlan[] {
	let found = false
	const updated = tasks.map((task) => {
		if (task.id !== taskId) return task
		found = true
		return { ...task, status }
	})
	if (!found) throw new Error(`Unknown task: ${taskId}`)
	return updated
}

export async function writePlanRuntime(cwd: string, plan: WaveOrchestrationPlan): Promise<void> {
	if ('adhoc_id' in plan) {
		await writeAdhocRuntime(cwd, plan)
		return
	}
	if ('change_request_id' in plan) {
		await writeChangeRequestRuntime(cwd, plan)
		return
	}
	await writeMilestoneRuntime(cwd, plan)
}

export async function assertImplementationReady(cwd: string): Promise<void> {
	const gate = await validateImplementationGate(cwd)
	if (!gate.valid) {
		const messages = gate.errors.map((error) => `${error.code}: ${error.message}`).join('; ')
		throw new Error(`Implementation gate is closed: ${messages}`)
	}
}

export function requireMatchingTarget(
	loaded: LoadedState,
	input: WaveOrchestrationTargetInput,
): { roadmapId: string; milestoneId: string; changeRequestId?: string; isAdhoc: boolean } {
	// Ad-hoc plans have no roadmap; scope every roadmap-keyed operation by the ad-hoc id.
	if (!loaded.active && loaded.adhoc) {
		const adhocId = loaded.adhoc.adhoc_id
		if (input.roadmapId && input.roadmapId !== adhocId) throw new Error(`Requested roadmap ${input.roadmapId} is not active`)
		if (input.milestoneId && input.milestoneId !== adhocId) throw new Error(`Requested milestone ${input.milestoneId} is not active`)
		return { roadmapId: adhocId, milestoneId: adhocId, isAdhoc: true }
	}

	const roadmapId = loaded.active?.roadmap_id
	const milestoneId = loaded.active?.milestone_id
	const changeRequestId = loaded.active?.change_request_id
	if (!roadmapId || !milestoneId) throw new Error('Wave orchestration requires an active roadmap and milestone')
	if (input.roadmapId && input.roadmapId !== roadmapId) {
		throw new Error(`Requested roadmap ${input.roadmapId} is not active`)
	}
	if (input.milestoneId && input.milestoneId !== milestoneId) {
		throw new Error(`Requested milestone ${input.milestoneId} is not active`)
	}
	if (input.changeRequestId && input.changeRequestId !== changeRequestId) {
		throw new Error(`Requested change request ${input.changeRequestId} is not active`)
	}
	return { roadmapId, milestoneId, ...(changeRequestId ? { changeRequestId } : {}), isAdhoc: false }
}

export function requireActiveWave(plan: WaveOrchestrationPlan): WavePlan {
	const activeWaveId = plan.progress.active_wave_id
	if (!activeWaveId) throw new Error('Implementation progress has no active wave')
	const wave = plan.waves.find((candidate) => candidate.id === activeWaveId)
	if (!wave) throw new Error(`Active wave ${activeWaveId} is missing from the plan`)
	return wave
}

export async function activePlanContext(
	cwd: string,
	input: WaveOrchestrationTargetInput,
): Promise<ActivePlanContext> {
	const loaded = await loadState(cwd)
	const target = requireMatchingTarget(loaded, input)
	const plan = loaded.changeRequest ?? loaded.milestone ?? loaded.adhoc
	if (!plan) throw new Error('Wave orchestration requires an active milestone, change, or ad-hoc plan')
	const activeWave = requireActiveWave(plan)
	const taskById = new Map(plan.tasks.map((task) => [task.id, task]))
	const activeTasks = activeWave.tasks.map((taskId) => {
		const task = taskById.get(taskId)
		if (!task) throw new Error(`Active wave ${activeWave.id} references unknown task ${taskId}`)
		return task
	})
	return { loaded, ...target, plan, activeWave, activeTasks }
}

export function assertDispatchableWave(ctx: ActivePlanContext): void {
	if (ctx.plan.progress.step === 'resolving_blockers') {
		throw new Error(`Active wave ${ctx.activeWave.id} is resolving blockers`)
	}
	if (ctx.activeWave.status === 'complete') throw new Error(`Active wave ${ctx.activeWave.id} is already complete`)
	if (ctx.activeWave.status === 'blocked') throw new Error(`Active wave ${ctx.activeWave.id} is blocked`)
	if (ctx.activeWave.status === 'reviewing') throw new Error(`Active wave ${ctx.activeWave.id} is already in review`)
}

export function assertTaskDispatchFields(task: TaskPlan): void {
	const raw = task as unknown as Record<string, unknown>
	if (!Array.isArray(raw.relevant_existing_code) || !Array.isArray(raw.shared_interface_contracts)) {
		throw new Error(`Task ${task.id} uses the pre-Wave-3 context schema; re-plan with the current task context schema.`)
	}
	if (!WORKERS.has(task.worker)) {
		throw new Error(`Task ${task.id} must assign worker-light, worker, or worker-heavy`)
	}
	if (task.owned_files.length === 0 && task.owned_modules.length === 0) {
		throw new Error(`Task ${task.id} must own files or modules`)
	}
}

export function assertDependenciesComplete(plan: WaveOrchestrationPlan, task: TaskPlan): void {
	for (const dependency of task.depends_on) {
		const dependencyTask = plan.tasks.find((candidate) => candidate.id === dependency)
		if (!dependencyTask) throw new Error(`Task ${task.id} depends on unknown task ${dependency}`)
		if (dependencyTask.status !== 'done') {
			throw new Error(`Task ${task.id} depends on incomplete task ${dependency}`)
		}
	}
}
