import type {AdhocPlan, ChangeRequest, ImplementationProgress, MilestonePlan, TaskPlan, ValidationIssue, WaveFlowCheck, WavePlan,} from './types'
import {IMPLEMENTATION_PROGRESS_STEPS, IMPLEMENTATION_WORKER_NAMES, WAVE_FLOW_CHECK_STATUSES} from './types'

const IMPLEMENTATION_WORKERS = new Set<string>(IMPLEMENTATION_WORKER_NAMES)

export function issue(code: string, message: string, path?: string): ValidationIssue {
	return path ? {code, message, path} : {code, message}
}

function validateTasksAndWaves(
	tasks: TaskPlan[],
	waves: WavePlan[],
	progress: ImplementationProgress,
	errors: ValidationIssue[],
): void {
	const taskIds = new Set<string>()
	const taskById = new Map<string, TaskPlan>()
	for (const task of tasks) {
		if (taskIds.has(task.id)) errors.push(issue('task.duplicate', `Duplicate task id: ${task.id}`))
		taskIds.add(task.id)
		taskById.set(task.id, task)
		if (!task.worker) {
			errors.push(issue('task.worker.missing', `Task ${task.id} must assign a worker`))
		} else if (!IMPLEMENTATION_WORKERS.has(task.worker)) {
			errors.push(
				issue(
					'task.worker.invalid',
					`Task ${task.id} must assign worker-light, worker, or worker-heavy; found ${task.worker}`,
				),
			)
		}
		if (!task.objective?.trim()) errors.push(issue('task.objective.missing', `Task ${task.id} must define an objective`))
		if (task.implementation_notes.length === 0) {
			errors.push(issue('task.implementation.missing', `Task ${task.id} must define implementation notes`))
		}
		if (task.done_criteria.length === 0) {
			errors.push(issue('task.done.missing', `Task ${task.id} must define done criteria`))
		}
		if (task.verification_commands.length === 0) {
			errors.push(issue('task.verify.missing', `Task ${task.id} must define verification commands`))
		}
		if (task.owned_files.length === 0 && task.owned_modules.length === 0) {
			errors.push(issue('task.ownership.missing', `Task ${task.id} must own files or modules`))
		}
		if (task.depends_on.includes(task.id)) {
			errors.push(issue('task.dependency.self', `Task ${task.id} cannot depend on itself`))
		}
		for (const dependency of task.depends_on) {
			if (!taskIds.has(dependency) && !tasks.some((candidate) => candidate.id === dependency)) {
				errors.push(issue('task.dependency.unknown', `Task ${task.id} depends on unknown task ${dependency}`))
			}
		}
	}

	const waveIds = new Set<string>()
	const taskWaveIndex = new Map<string, number>()
	const scheduledTasks = new Set<string>()
	let activeWaveCount = 0

	for (let index = 0; index < waves.length; index += 1) {
		const wave = waves[index]
		if (!wave) continue
		if (waveIds.has(wave.id)) errors.push(issue('wave.duplicate', `Duplicate wave id: ${wave.id}`))
		waveIds.add(wave.id)
		if (!wave.goal?.trim()) errors.push(issue('wave.goal.missing', `Wave ${wave.id} must define a goal`))
		if (wave.exit_criteria.length === 0) {
			errors.push(issue('wave.exit.missing', `Wave ${wave.id} must define exit criteria`))
		}
		if (!wave.review_checkpoint?.trim()) {
			errors.push(issue('wave.review.missing', `Wave ${wave.id} must define a review checkpoint`))
		}
		if (['running', 'reviewing'].includes(wave.status)) activeWaveCount += 1

		const owned = new Map<string, string>()
		for (const taskId of wave.tasks) {
			const task = taskById.get(taskId)
			if (!task) {
				errors.push(issue('wave.task.unknown', `Wave ${wave.id} references unknown task ${taskId}`))
				continue
			}
			if (scheduledTasks.has(taskId)) {
				errors.push(issue('wave.task.duplicate', `Task ${taskId} is scheduled in more than one wave`))
			}
			scheduledTasks.add(taskId)
			taskWaveIndex.set(taskId, index)
			const taskOwners = new Set([...task.owned_files, ...task.owned_modules])
			for (const owner of taskOwners) {
				const previous = owned.get(owner)
				if (previous && previous !== task.id) {
					errors.push(
						issue(
							'wave.ownership.overlap',
							`Wave ${wave.id} has overlapping ownership for ${owner}: ${previous} and ${task.id}`,
						),
					)
				}
				owned.set(owner, task.id)
			}
		}
	}

	if (activeWaveCount > 1) {
		errors.push(issue('wave.active.multiple', 'Only one wave can be running or reviewing at a time'))
	}

	for (const task of tasks) {
		if (!scheduledTasks.has(task.id)) {
			errors.push(issue('wave.task.missing', `Task ${task.id} is not assigned to any wave`))
		}
	}

	for (const task of tasks) {
		const taskIndex = taskWaveIndex.get(task.id)
		if (taskIndex === undefined) continue
		for (const dependency of task.depends_on) {
			const dependencyIndex = taskWaveIndex.get(dependency)
			if (dependencyIndex === undefined) continue
			if (dependencyIndex >= taskIndex) {
				errors.push(
					issue(
						'task.dependency.order',
						`Task ${task.id} depends on ${dependency}, which is not scheduled in an earlier wave`,
					),
				)
			}
		}
	}
	validateDependencyCycles(tasks, errors)
	validateProgress(progress, taskById, waves, errors)

	const firstIncompleteIndex = waves.findIndex((wave) => wave.status !== 'complete')
	if (firstIncompleteIndex !== -1) {
		for (let index = firstIncompleteIndex + 1; index < waves.length; index += 1) {
			const wave = waves[index]
			if (wave && wave.status !== 'pending') {
				errors.push(
					issue(
						'wave.order.blocked',
						`Wave ${wave.id} cannot start before earlier waves are complete`,
					),
				)
			}
		}
	}
}

function validateProgress(
	progress: ImplementationProgress,
	taskById: Map<string, TaskPlan>,
	waves: WavePlan[],
	errors: ValidationIssue[],
): void {
	if (!IMPLEMENTATION_PROGRESS_STEPS.includes(progress.step)) {
		errors.push(issue('progress.step.invalid', `Invalid implementation progress step: ${progress.step}`))
	}
	if (progress.step === 'resolving_blockers' && !progress.blocked_reason?.trim()) {
		errors.push(issue('progress.blocked_reason.missing', 'Blocked progress must include a blocked reason'))
	}

	const activeWave = progress.active_wave_id
		? waves.find((wave) => wave.id === progress.active_wave_id)
		: undefined
	if (progress.active_wave_id && !activeWave) {
		errors.push(issue('progress.wave.unknown', `Progress references unknown active wave ${progress.active_wave_id}`))
	}
	if (!progress.active_wave_id && waves.length > 0 && progress.step !== 'closeout_ready') {
		errors.push(issue('progress.wave.missing', 'Progress must identify an active wave before closeout'))
	}

	const activeWaveTasks = new Set(activeWave?.tasks ?? [])
	for (const taskId of progress.active_task_ids) {
		if (!taskById.has(taskId)) {
			errors.push(issue('progress.task.unknown', `Progress references unknown active task ${taskId}`))
			continue
		}
		if (activeWave && !activeWaveTasks.has(taskId)) {
			errors.push(
				issue(
					'progress.task.outside_wave',
					`Progress active task ${taskId} is not part of active wave ${activeWave.id}`,
				),
			)
		}
	}
}

export interface TaskDependencyGraph {
	taskById: Map<string, TaskPlan>;
	/** Directed edges dependency -> dependent, restricted to tasks present in the plan. */
	edges: Array<{ from: string; to: string }>;
}

export function buildTaskDependencyGraph(tasks: TaskPlan[]): TaskDependencyGraph {
	const taskById = new Map(tasks.map((task) => [task.id, task]))
	const edges: Array<{ from: string; to: string }> = []
	for (const task of tasks) {
		for (const dependency of task.depends_on) {
			if (taskById.has(dependency)) edges.push({from: dependency, to: task.id})
		}
	}
	return {taskById, edges}
}

function escapeMermaidLabel(text: string): string {
	return text.replace(/"/g, '\'').replace(/[\r\n]+/g, ' ').trim()
}

export function renderMilestoneDependencyGraph(tasks: TaskPlan[]): string {
	const {taskById, edges} = buildTaskDependencyGraph(tasks)
	const ids = [...taskById.keys()]
	const nodeName = new Map<string, string>()
	ids.forEach((id, index) => nodeName.set(id, `n${index}`))
	const lines = ['graph TD']
	if (ids.length === 0) {
		lines.push('\tempty["No tasks in active plan"]')
		return lines.join('\n')
	}
	for (const id of ids) {
		const task = taskById.get(id)!
		lines.push(`\t${nodeName.get(id)}["${escapeMermaidLabel(`${id}: ${task.title}`)}"]`)
	}
	for (const edge of edges) {
		lines.push(`\t${nodeName.get(edge.from)} --> ${nodeName.get(edge.to)}`)
	}
	return lines.join('\n')
}

function validateDependencyCycles(tasks: TaskPlan[], errors: ValidationIssue[]): void {
	const {taskById} = buildTaskDependencyGraph(tasks)
	const visiting = new Set<string>()
	const visited = new Set<string>()

	const visit = (taskId: string, path: string[]): void => {
		if (visiting.has(taskId)) {
			errors.push(issue('task.dependency.cycle', `Task dependency cycle detected: ${[...path, taskId].join(' -> ')}`))
			return
		}
		if (visited.has(taskId)) return
		const task = taskById.get(taskId)
		if (!task) return

		visiting.add(taskId)
		for (const dependency of task.depends_on) visit(dependency, [...path, taskId])
		visiting.delete(taskId)
		visited.add(taskId)
	}

	for (const task of tasks) visit(task.id, [])
}

function validateWaveFlowCheck(
	waveFlowCheck: WaveFlowCheck | undefined,
	errors: ValidationIssue[],
	prefix: 'milestone' | 'change' | 'adhoc',
): void {
	if (!waveFlowCheck) {
		errors.push(issue(`${prefix}.wave_flow_check.missing`, 'Plan must include a wave-flow check'))
		return
	}
	if (!WAVE_FLOW_CHECK_STATUSES.includes(waveFlowCheck.status)) {
		errors.push(issue(`${prefix}.wave_flow_check.status.invalid`, `Invalid wave-flow check status: ${waveFlowCheck.status}`))
		return
	}
	if (waveFlowCheck.status !== 'passed') {
		errors.push(issue(`${prefix}.wave_flow_check.not_passed`, 'Plan requires a passed wave-flow check before approval'))
		return
	}
	if (!waveFlowCheck.checked_by.trim()) {
		errors.push(issue(`${prefix}.wave_flow_check.checked_by.missing`, 'Passed wave-flow check must record who checked it'))
	}
	if (!waveFlowCheck.checked_at.trim()) {
		errors.push(issue(`${prefix}.wave_flow_check.checked_at.missing`, 'Passed wave-flow check must record when it ran'))
	}
	if (!waveFlowCheck.summary.trim()) {
		errors.push(issue(`${prefix}.wave_flow_check.summary.missing`, 'Passed wave-flow check must include a summary'))
	}
}

export function validateMilestonePlan(
	plan: MilestonePlan,
	errors: ValidationIssue[],
	prefix: 'milestone' | 'change' | 'adhoc' = 'milestone',
): void {
	if (!plan.milestone_id) errors.push(issue(`${prefix}.id.missing`, 'Milestone ID is required'))
	if (!plan.title) errors.push(issue(`${prefix}.title.missing`, 'Milestone title is required'))
	if (plan.cleanup_policy !== 'approval-gated') {
		errors.push(issue(`${prefix}.cleanup.invalid`, 'Cleanup policy must be approval-gated'))
	}
	if (plan.open_questions.length > 0) {
		errors.push(issue(`${prefix}.questions.open`, 'Plan has open material questions'))
	}
	// Decision-completeness is an approval gate: only enforce it while the milestone plan is
	// still being drafted (not yet approved). Re-validating an already-approved or completed
	// milestone must not retroactively invalidate a roadmap that was planned before this rule
	// existed (that would strand the planner at /roadmap:next and slam the implementation gate).
	if (prefix === 'milestone' && plan.approvals.length === 0) {
		if (plan.decisions.length === 0) {
			errors.push(issue('plan.decisions.missing', 'Milestone plan must record decisions before approval'))
		}
		if (plan.dependency_analysis.length === 0) {
			errors.push(issue('plan.dependency_analysis.missing', 'Milestone plan must record dependency analysis before approval'))
		}
	}
	if (plan.verification_commands.length === 0) {
		errors.push(issue(`${prefix}.verify.missing`, 'Plan must define verification commands'))
	}
	if (plan.acceptance_criteria.length === 0) {
		errors.push(issue(`${prefix}.acceptance.missing`, 'Plan must define acceptance criteria'))
	}
	if (plan.tasks.length === 0) errors.push(issue(`${prefix}.tasks.missing`, 'Plan must define tasks'))
	if (plan.waves.length === 0) errors.push(issue(`${prefix}.waves.missing`, 'Plan must define waves'))
	validateWaveFlowCheck(plan.wave_flow_check, errors, prefix)
	validateTasksAndWaves(plan.tasks, plan.waves, plan.progress, errors)
}

export function validateChangeRequest(change: ChangeRequest, errors: ValidationIssue[]): void {
	if (change.status !== 'draft' && change.approvals.length === 0) {
		errors.push(issue('change.approval.missing', 'Change request implementation requires plan approval'))
	}
	validateMilestonePlan(
		{
			roadmap_id: change.roadmap_id,
			milestone_id: change.milestone_id,
			title: change.title,
			status: 'milestone_approved',
			approvals: change.approvals,
			open_questions: [],
			verification_commands: change.verification_commands,
			acceptance_criteria: change.acceptance_criteria,
			cleanup_policy: 'approval-gated',
			tasks: change.tasks,
			waves: change.waves,
			user_interview: change.user_interview,
			relevant_existing_code: change.relevant_existing_code,
			relevant_documentation: change.relevant_documentation,
			decisions: change.decisions,
			dependency_analysis: change.dependency_analysis,
			progress: change.progress,
			wave_flow_check: change.wave_flow_check,
		},
		errors,
		'change',
	)
}

export function validateAdhocPlan(plan: AdhocPlan, errors: ValidationIssue[]): void {
	if (plan.status !== 'adhoc_draft' && plan.approvals.length === 0) {
		errors.push(issue('adhoc.approval.missing', 'Ad-hoc plan implementation requires plan approval'))
	}
	validateMilestonePlan(
		{
			roadmap_id: '',
			milestone_id: plan.adhoc_id,
			title: plan.title,
			status: 'milestone_approved',
			approvals: plan.approvals,
			open_questions: plan.open_questions,
			verification_commands: plan.verification_commands,
			acceptance_criteria: plan.acceptance_criteria,
			cleanup_policy: plan.cleanup_policy,
			tasks: plan.tasks,
			waves: plan.waves,
			user_interview: plan.user_interview,
			relevant_existing_code: plan.relevant_existing_code,
			relevant_documentation: plan.relevant_documentation,
			decisions: plan.decisions,
			dependency_analysis: plan.dependency_analysis,
			progress: plan.progress,
			wave_flow_check: plan.wave_flow_check,
		},
		errors,
		'adhoc',
	)
}
