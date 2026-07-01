import * as crypto from 'node:crypto'
import {serializeMarkdownDocument} from '../frontmatter'
import type {
	ChangeRequest,
	ImplementationProgress,
	MilestonePlan,
	PlanRuntime,
	RoadmapMilestoneCheck,
	RoadmapMilestoneOutline,
	RoadmapState,
	TaskPlan,
	WaveFlowCheck,
	WaveFlowCheckStatus,
	WavePlan,
	WorkerRun
} from '../types'
import {WORKER_RUN_STATUSES} from '../types'
import type {WaveFlowCheckInput} from './contract'
import {list, nowIso, valueList, valueString} from './shared'

export function pendingWaveFlowCheck(): WaveFlowCheck {
	return {
		status: 'pending',
		checked_by: '',
		checked_at: '',
		summary: '',
		findings: [],
	}
}

export function roadmapContentHash(state: RoadmapState): string {
	return `sha256:${crypto.createHash('sha256').update(renderRoadmapMarkdown(state)).digest('hex')}`
}

export function pendingRoadmapMilestoneCheck(roadmapRevision: number, roadmapContentHash: string): RoadmapMilestoneCheck {
	return {
		...pendingWaveFlowCheck(),
		roadmap_revision: roadmapRevision,
		roadmap_content_hash: roadmapContentHash,
		event_id: '',
	}
}

export function recordedCheck(input: WaveFlowCheckInput, fallbackCheckedBy: string): WaveFlowCheck {
	return {
		status: input.status,
		checked_by: input.checkedBy?.trim() || fallbackCheckedBy,
		checked_at: nowIso(),
		summary: input.summary?.trim() ?? '',
		findings: input.findings ?? [],
	}
}

export function recordedWaveFlowCheck(input: WaveFlowCheckInput): WaveFlowCheck {
	return recordedCheck(input, 'wave-flow-checker')
}

export function recordedRoadmapMilestoneCheck(input: WaveFlowCheckInput, roadmap: RoadmapState): RoadmapMilestoneCheck {
	return {
		...recordedCheck(input, 'roadmap-milestone-checker'),
		roadmap_revision: roadmap.roadmap_revision,
		roadmap_content_hash: roadmap.roadmap_content_hash,
		event_id: '',
	}
}

export function normalizeWaveFlowCheck(value: unknown): WaveFlowCheck {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return pendingWaveFlowCheck()
	const raw = value as Partial<WaveFlowCheck>
	if (!['pending', 'passed', 'failed'].includes(raw.status ?? '')) return pendingWaveFlowCheck()
	return {
		status: raw.status as WaveFlowCheckStatus,
		checked_by: valueString(raw.checked_by),
		checked_at: valueString(raw.checked_at),
		summary: valueString(raw.summary),
		findings: valueList(raw.findings),
	}
}

export function normalizeRoadmapMilestoneCheck(value: unknown, roadmapRevision: number, roadmapContentHash: string): RoadmapMilestoneCheck {
	const check = normalizeWaveFlowCheck(value)
	const raw = value && typeof value === 'object' && !Array.isArray(value)
		? value as Partial<RoadmapMilestoneCheck>
		: {}
	return {
		...check,
		roadmap_revision: Number.isFinite(raw.roadmap_revision) ? Number(raw.roadmap_revision) : roadmapRevision,
		roadmap_content_hash: valueString(raw.roadmap_content_hash) || roadmapContentHash,
		event_id: valueString(raw.event_id),
	}
}

export function normalizeTask(task: TaskPlan): TaskPlan {
	const raw = task as unknown as Record<string, unknown>
	return {
		...task,
		status: (raw.status as TaskPlan['status']) ?? 'assigned',
		objective: valueString(raw.objective),
		implementation_notes: valueList(raw.implementation_notes),
		done_criteria: valueList(raw.done_criteria),
		verification_commands: valueList(raw.verification_commands),
		depends_on: valueList(raw.depends_on),
		owned_files: valueList(raw.owned_files),
		owned_modules: valueList(raw.owned_modules),
		shared_interfaces: valueList(raw.shared_interfaces),
	}
}

export function normalizeWave(wave: WavePlan): WavePlan {
	const raw = wave as unknown as Record<string, unknown>
	return {
		...wave,
		status: (raw.status as WavePlan['status']) ?? 'pending',
		goal: valueString(raw.goal),
		exit_criteria: valueList(raw.exit_criteria),
		review_checkpoint: valueString(raw.review_checkpoint),
		tasks: valueList(raw.tasks),
	}
}

export const WORKER_RUN_STATUS_SET = new Set<string>(WORKER_RUN_STATUSES)

export function normalizeWorkerRun(value: unknown): WorkerRun | undefined {
	const raw = value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: {}
	const taskId = valueString(raw.task_id)
	const waveId = valueString(raw.wave_id)
	const worker = valueString(raw.worker)
	const agentId = valueString(raw.agent_id)
	const jobId = valueString(raw.job_id)
	const status = valueString(raw.status)
	if (!taskId || !waveId || !worker || !agentId || !jobId || !WORKER_RUN_STATUS_SET.has(status)) {
		return undefined
	}
	if (!['worker-light', 'worker', 'worker-heavy'].includes(worker)) return undefined
	return {
		task_id: taskId,
		wave_id: waveId,
		worker: worker as WorkerRun['worker'],
		agent_id: agentId,
		job_id: jobId,
		owned_files: valueList(raw.owned_files),
		owned_modules: valueList(raw.owned_modules),
		status: status as WorkerRun['status'],
		started_at: valueString(raw.started_at) || nowIso(),
		updated_at: valueString(raw.updated_at) || nowIso(),
		...(valueString(raw.last_error) ? {last_error: valueString(raw.last_error)} : {}),
	}
}

export function normalizeWorkerRuns(value: unknown): WorkerRun[] {
	if (!Array.isArray(value)) return []
	return value.flatMap((item) => {
		const run = normalizeWorkerRun(item)
		return run ? [run] : []
	})
}

export function normalizeProgress(value: unknown, waves: WavePlan[]): ImplementationProgress {
	const raw = value && typeof value === 'object' && !Array.isArray(value)
		? value as Partial<ImplementationProgress>
		: {}
	return {
		...(typeof raw.active_wave_id === 'string'
			? {active_wave_id: raw.active_wave_id}
			: waves[0]
				? {active_wave_id: waves[0].id}
				: {}),
		step: raw.step ?? 'not_started',
		active_task_ids: valueList(raw.active_task_ids),
		worker_runs: normalizeWorkerRuns(raw.worker_runs),
		...(typeof raw.blocked_reason === 'string' ? {blocked_reason: raw.blocked_reason} : {}),
		updated_at: raw.updated_at ?? nowIso(),
	}
}

export function normalizeMilestonePlan(plan: MilestonePlan): MilestonePlan {
	const raw = plan as unknown as Record<string, unknown>
	const tasks = Array.isArray(plan.tasks) ? plan.tasks.map(normalizeTask) : []
	const waves = Array.isArray(plan.waves) ? plan.waves.map(normalizeWave) : []
	return {
		...plan,
		open_questions: valueList(raw.open_questions),
		verification_commands: valueList(raw.verification_commands),
		acceptance_criteria: valueList(raw.acceptance_criteria),
		user_interview: valueList(raw.user_interview),
		relevant_existing_code: valueList(raw.relevant_existing_code),
		relevant_documentation: valueList(raw.relevant_documentation),
		decisions: valueList(raw.decisions),
		dependency_analysis: valueList(raw.dependency_analysis),
		tasks,
		waves,
		progress: normalizeProgress(raw.progress, waves),
		wave_flow_check: normalizeWaveFlowCheck(raw.wave_flow_check),
	}
}

export function normalizeChangeRequest(change: ChangeRequest): ChangeRequest {
	const raw = change as unknown as Record<string, unknown>
	const tasks = Array.isArray(change.tasks) ? change.tasks.map(normalizeTask) : []
	const waves = Array.isArray(change.waves) ? change.waves.map(normalizeWave) : []
	return {
		...change,
		verification_commands: valueList(raw.verification_commands),
		acceptance_criteria: valueList(raw.acceptance_criteria),
		user_interview: valueList(raw.user_interview),
		relevant_existing_code: valueList(raw.relevant_existing_code),
		relevant_documentation: valueList(raw.relevant_documentation),
		decisions: valueList(raw.decisions),
		dependency_analysis: valueList(raw.dependency_analysis),
		tasks,
		waves,
		progress: normalizeProgress(raw.progress, waves),
		wave_flow_check: normalizeWaveFlowCheck(raw.wave_flow_check),
	}
}

export function normalizePlanRuntime(value: unknown, plan: MilestonePlan | ChangeRequest): PlanRuntime {
	const raw = value && typeof value === 'object' && !Array.isArray(value)
		? value as Partial<PlanRuntime>
		: {}
	const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : []
	const rawWaves = Array.isArray(raw.waves) ? raw.waves : []
	const taskStatuses = new Map(rawTasks.map((task) => [task.id, task.status]))
	const waveStatuses = new Map(rawWaves.map((wave) => [wave.id, wave.status]))
	return {
		tasks: plan.tasks.map((task) => ({
			id: task.id,
			status: taskStatuses.get(task.id) ?? task.status,
		})),
		waves: plan.waves.map((wave) => ({
			id: wave.id,
			status: waveStatuses.get(wave.id) ?? wave.status,
		})),
		progress: normalizeProgress(raw.progress, plan.waves),
		wave_flow_check: normalizeWaveFlowCheck(raw.wave_flow_check),
	}
}

export function runtimeFromPlan(plan: MilestonePlan | ChangeRequest): PlanRuntime {
	return {
		tasks: plan.tasks.map((task) => ({id: task.id, status: task.status})),
		waves: plan.waves.map((wave) => ({id: wave.id, status: wave.status})),
		progress: plan.progress,
		wave_flow_check: plan.wave_flow_check,
	}
}

export function applyRuntime<T extends MilestonePlan | ChangeRequest>(plan: T, runtime: PlanRuntime): T {
	const taskStatuses = new Map(runtime.tasks.map((task) => [task.id, task.status]))
	const waveStatuses = new Map(runtime.waves.map((wave) => [wave.id, wave.status]))
	return {
		...plan,
		tasks: plan.tasks.map((task) => ({
			...task,
			status: taskStatuses.get(task.id) ?? task.status,
		})),
		waves: plan.waves.map((wave) => ({
			...wave,
			status: waveStatuses.get(wave.id) ?? wave.status,
		})),
		progress: runtime.progress,
		wave_flow_check: runtime.wave_flow_check,
	}
}

export function planDefinitionData(plan: MilestonePlan | ChangeRequest): Record<string, unknown> {
	const {progress, wave_flow_check, tasks, waves, ...definition} = plan
	return {
		...definition,
		tasks: tasks.map(({status, ...task}) => task),
		waves: waves.map(({status, ...wave}) => wave),
	}
}

export function normalizeRoadmapState(state: RoadmapState): RoadmapState {
	const raw = state as unknown as Record<string, unknown>
	const roadmapRevision = Number.isFinite(raw.roadmap_revision) ? Number(raw.roadmap_revision) : 0
	const withoutCheck = {
		...state,
		roadmap_revision: roadmapRevision,
		roadmap_content_hash: valueString(raw.roadmap_content_hash),
	}
	const roadmapContent = withoutCheck.roadmap_content_hash || roadmapContentHash(withoutCheck)
	return {
		...withoutCheck,
		roadmap_content_hash: roadmapContent,
		roadmap_milestone_check: normalizeRoadmapMilestoneCheck(raw.roadmap_milestone_check, roadmapRevision, roadmapContent),
	}
}

export function renderMilestone(milestone: RoadmapMilestoneOutline): string {
	return [
		`### ${milestone.id} - ${milestone.title}`,
		``,
		`Goal: ${milestone.goal}`,
		``,
		`Scope:`,
		list(milestone.scope),
		``,
		`Non-Goals:`,
		list(milestone.non_goals),
		``,
		`Evidence:`,
		list(milestone.evidence),
		``,
		`Dependencies:`,
		list(milestone.dependencies),
		``,
		`Risks:`,
		list(milestone.risks),
		``,
		`Acceptance Intent:`,
		list(milestone.acceptance_intent),
		``,
		`Verification Intent:`,
		list(milestone.verification_intent),
	].join('\n')
}

export function renderRoadmapMarkdown(state: RoadmapState): string {
	const body = [
		`# ${state.title}`,
		``,
		`## Goal`,
		``,
		state.goal || '(not finalized)',
		``,
		`## Success Criteria`,
		``,
		list(state.success_criteria ?? []),
		``,
		`## Constraints`,
		``,
		list(state.constraints ?? []),
		``,
		`## Non-Goals`,
		``,
		list(state.non_goals ?? []),
		``,
		`## Context`,
		``,
		list(state.context ?? []),
		``,
		`## Evidence`,
		``,
		list(state.evidence ?? []),
		``,
		`## Discovery Findings`,
		``,
		list(state.discovery.findings ?? []),
		``,
		`## Milestones`,
		``,
		(state.milestones ?? []).length > 0 ? state.milestones.map(renderMilestone).join('\n\n') : '- (none)',
		``,
		`## Risks`,
		``,
		list(state.risks ?? []),
		``,
		`## Open Questions`,
		``,
		list(state.open_questions ?? []),
	].join('\n')

	return serializeMarkdownDocument(
		{
			roadmap_id: state.roadmap_id,
			title: state.title,
			status: state.roadmap_finalized ? 'finalized' : 'draft',
		},
		body,
	)
}

export function renderPlanSummary(plan: MilestonePlan | ChangeRequest): string {
	const label = 'change_request_id' in plan ? `Change request: ${plan.change_request_id}` : `Milestone: ${plan.milestone_id}`
	return [
		label,
		`Title: ${plan.title}`,
		`Status: ${plan.status}`,
	].join('\n')
}

export function renderTask(task: TaskPlan): string {
	return [
		`### ${task.id} - ${task.title}`,
		``,
		`Worker: ${task.worker}`,
		`Objective: ${task.objective || '(not recorded)'}`,
		``,
		`Implementation Notes:`,
		list(task.implementation_notes),
		``,
		`Done Criteria:`,
		list(task.done_criteria),
		``,
		`Verification Commands:`,
		list(task.verification_commands),
		``,
		`Depends On:`,
		list(task.depends_on),
		``,
		`Owned Files:`,
		list(task.owned_files),
		``,
		`Owned Modules:`,
		list(task.owned_modules),
		``,
		`Shared Interfaces:`,
		list(task.shared_interfaces),
	].join('\n')
}

export function renderWave(wave: WavePlan): string {
	return [
		`### ${wave.id}`,
		``,
		`Goal: ${wave.goal || '(not recorded)'}`,
		`Review Checkpoint: ${wave.review_checkpoint || '(not recorded)'}`,
		``,
		`Tasks:`,
		list(wave.tasks),
		``,
		`Exit Criteria:`,
		list(wave.exit_criteria),
	].join('\n')
}

export function renderImplementationPlanBody(plan: MilestonePlan | ChangeRequest): string {
	const requestedDelta = 'request' in plan ? `\n## Requested Delta\n\n${plan.request}\n` : ''
	return [
		`# ${plan.title}`,
		requestedDelta.trimEnd(),
		`## Summary`,
		``,
		renderPlanSummary(plan),
		``,
		`## User Interview`,
		``,
		list(plan.user_interview),
		``,
		`## Context`,
		``,
		`### Relevant Existing Code`,
		``,
		list(plan.relevant_existing_code),
		``,
		`### Relevant Documentation`,
		``,
		list(plan.relevant_documentation),
		``,
		`### Decisions`,
		``,
		list(plan.decisions),
		``,
		`## Required Work`,
		``,
		plan.tasks.length > 0 ? plan.tasks.map(renderTask).join('\n\n') : '- (none)',
		``,
		`## Dependency Analysis`,
		``,
		list(plan.dependency_analysis),
		``,
		`## Execution Waves`,
		``,
		plan.waves.length > 0 ? plan.waves.map(renderWave).join('\n\n') : '- (none)',
		``,
		`## Verification`,
		``,
		`### Acceptance Criteria`,
		``,
		list(plan.acceptance_criteria),
		``,
		`### Verification Commands`,
		``,
		list(plan.verification_commands),
	].filter((section) => section !== '').join('\n')
}

export function hasContent(value: string | undefined): boolean {
	if (!value || value.trim() === '') return false
	return !/\b(TBD|TODO)\b/i.test(value)
}

export function hasContentItems(items: string[] | undefined): boolean {
	return Array.isArray(items) && items.length > 0 && items.every(hasContent)
}
