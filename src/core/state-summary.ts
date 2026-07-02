import type {ChangeRequest, CloseoutEvidence, LoadedState, MilestonePlan, RoadmapBlocker, RoadmapState, TaskPlan, WavePlan,} from './types'
import type {ContextEntryResult} from './context-types'

export type StateReadScope = 'compact' | 'roadmap' | 'active_milestone' | 'active_wave' | 'active_change' | 'usage';

interface SectionReference {
	id: string;
	artifact: string;
	title: string;
	milestoneId?: string;
}

interface StateSummaryContext {
	roadmapSections?: ContextEntryResult[];
	planSections?: ContextEntryResult[];
	noteSections?: ContextEntryResult[];
	blockers?: RoadmapBlocker[];
}

function sectionRefs(entries: ContextEntryResult[] | undefined): SectionReference[] {
	return (entries ?? []).map((entry) => ({
		id: entry.id,
		artifact: entry.artifact,
		title: entry.title,
		...(entry.milestoneId ? {milestoneId: entry.milestoneId} : {}),
	}))
}

function roadmapSummary(roadmap: RoadmapState | undefined): Record<string, unknown> | undefined {
	if (!roadmap) return undefined
	const check = roadmap.roadmap_milestone_check
	const checkStatus = check.status !== 'pending' && (
		check.roadmap_revision !== roadmap.roadmap_revision ||
		check.roadmap_content_hash !== roadmap.roadmap_content_hash
	) ? 'stale' : check.status
	return {
		roadmap_id: roadmap.roadmap_id,
		title: roadmap.title,
		phase: roadmap.phase,
		roadmap_finalized: roadmap.roadmap_finalized,
		roadmap_revision: roadmap.roadmap_revision,
		roadmap_content_hash: roadmap.roadmap_content_hash,
		roadmap_milestone_check_status: checkStatus,
		roadmap_milestone_check: roadmap.roadmap_milestone_check,
		open_questions: roadmap.open_questions,
		active_milestone_id: roadmap.active_milestone_id,
		active_change_request_id: roadmap.active_change_request_id,
		bypass: roadmap.bypass,
		approvals: roadmap.approvals.length,
		discovery: roadmap.discovery,
		milestones: roadmap.milestones.map((milestone) => ({
			id: milestone.id,
			title: milestone.title,
			status: milestone.status,
			dependencies: milestone.dependencies,
			scope_items: milestone.scope.length,
			risks: milestone.risks.length,
			acceptance_items: milestone.acceptance_intent.length,
			verification_items: milestone.verification_intent.length,
		})),
	}
}

function taskSummary(task: TaskPlan): Record<string, unknown> {
	return {
		id: task.id,
		title: task.title,
		worker: task.worker,
		status: task.status,
		depends_on: task.depends_on,
		owned_files: task.owned_files,
		owned_modules: task.owned_modules,
		shared_interfaces: task.shared_interfaces,
		verification_commands: task.verification_commands,
	}
}

function waveSummary(wave: WavePlan): Record<string, unknown> {
	return {
		id: wave.id,
		status: wave.status,
		tasks: wave.tasks,
		exit_criteria: wave.exit_criteria,
		review_checkpoint: wave.review_checkpoint,
	}
}

function planSummary(plan: MilestonePlan | ChangeRequest | undefined): Record<string, unknown> | undefined {
	if (!plan) return undefined
	return {
		roadmap_id: plan.roadmap_id,
		milestone_id: plan.milestone_id,
		...('change_request_id' in plan ? {change_request_id: plan.change_request_id, request: plan.request} : {}),
		title: plan.title,
		status: plan.status,
		open_questions: 'open_questions' in plan ? plan.open_questions : undefined,
		approvals: plan.approvals.length,
		verification_commands: plan.verification_commands,
		acceptance_criteria_count: plan.acceptance_criteria.length,
		user_interview_count: plan.user_interview.length,
		relevant_existing_code: plan.relevant_existing_code,
		relevant_documentation: plan.relevant_documentation,
		decisions_count: plan.decisions.length,
		dependency_analysis_count: plan.dependency_analysis.length,
		tasks: plan.tasks.map(taskSummary),
		waves: plan.waves.map(waveSummary),
		progress: plan.progress,
		wave_flow_check: plan.wave_flow_check,
	}
}

function closeoutSummary(closeout: CloseoutEvidence | undefined): Record<string, unknown> | undefined {
	if (!closeout) return undefined
	return {
		status: closeout.status,
		acceptance_results: closeout.acceptance_results.length,
		verification_results: closeout.verification_results.length,
		worker_notes_reviewed: closeout.worker_notes_reviewed,
		unresolved_risks: closeout.unresolved_risks.length,
		closed_by: closeout.closed_by,
		closed_at: closeout.closed_at,
	}
}

function blockerSummary(blockers: RoadmapBlocker[] | undefined): Record<string, unknown>[] {
	return (blockers ?? []).map((blocker) => ({
		id: blocker.id,
		status: blocker.status,
		severity: blocker.severity,
		title: blocker.title,
		milestone_id: blocker.milestone_id,
		change_request_id: blocker.change_request_id,
		task_id: blocker.task_id,
		wave_id: blocker.wave_id,
		note_path: blocker.note_path,
	}))
}

export function summarizeState(
	state: LoadedState,
	scope: StateReadScope,
	context: StateSummaryContext = {},
): Record<string, unknown> {
	const compact = {
		active: state.active,
		roadmap: roadmapSummary(state.roadmap),
		milestone: planSummary(state.milestone),
		change_request: planSummary(state.changeRequest),
		closeout: closeoutSummary(state.closeout),
		blockers: blockerSummary(context.blockers),
		context_sections: {
			roadmap: sectionRefs(context.roadmapSections),
			plan: sectionRefs(context.planSections),
		},
	}

	switch (scope) {
		case 'compact':
			return compact
		case 'roadmap':
			return {
				active: state.active,
				roadmap: roadmapSummary(state.roadmap),
				blockers: blockerSummary(context.blockers),
				context_sections: {roadmap: sectionRefs(context.roadmapSections)},
			}
		case 'active_milestone':
			return {
				active: state.active,
				milestone: planSummary(state.milestone),
				closeout: closeoutSummary(state.closeout),
				context_sections: {plan: sectionRefs(context.planSections)},
			}
		case 'active_wave': {
			const plan = state.changeRequest ?? state.milestone
			const activeWaveId = plan?.progress.active_wave_id
			const wave = plan?.waves.find((candidate) => candidate.id === activeWaveId)
			const taskById = new Map((plan?.tasks ?? []).map((task) => [task.id, task]))
			const waveTasks = (wave?.tasks ?? [])
			.map((taskId) => taskById.get(taskId))
			.filter((task): task is TaskPlan => task !== undefined)
			.map(taskSummary)
			return {
				active: state.active,
				active_wave: wave
					? {
						id: wave.id,
						status: wave.status,
						exit_criteria: wave.exit_criteria,
						review_checkpoint: wave.review_checkpoint,
						tasks: waveTasks,
					}
					: undefined,
				progress: plan?.progress,
				blockers: blockerSummary((context.blockers ?? []).filter((blocker) => blocker.wave_id === activeWaveId)),
				context_sections: {notes: sectionRefs(context.noteSections)},
			}
		}
		case 'active_change':
			return {
				active: state.active,
				change_request: planSummary(state.changeRequest),
				context_sections: {plan: sectionRefs(context.planSections)},
			}
		case 'usage':
			return {
				active: state.active,
				usage: state.usage,
			}
	}
}
