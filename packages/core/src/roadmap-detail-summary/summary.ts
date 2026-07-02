import {readRoadmapEvents} from '../events'
import {fileExists} from '../files'
import {milestonePlanPath} from '../paths'
import {nextActionPlan, type NextActionPlan} from '../report/index'
import {listQualityGates, loadMilestonePlan, loadRoadmapBlockers, loadState} from '../store/index'
import type {ChangeRequest, LoadedState, MilestonePlan, Phase, TaskPlan, WavePlan,} from '../types'
import {validateImplementationGate, validateRoadmapState} from '../validation'
import {availableControls} from './controls'
import {
	activeExecutionSummary,
	activeTasksSummary,
	blockerSummary,
	bypassSummary,
	canonicalBlockersSummary,
	checkSummary,
	eventSummary,
	nextCommandSummary,
	qualityGateSummary,
	referenceFromPlan,
	roadmapHealthSummary,
	taskDetail,
	usageSummary,
	wavesSummary,
} from './formatters'
import {
	type ActiveRoadmapDetailSummary,
	NO_ACTIVE_ROADMAP_MESSAGE,
	type RoadmapDetailCheck,
	type RoadmapDetailMilestone,
	type RoadmapDetailSummary,
} from './types'

export type PlanContext = {
	plan: MilestonePlan | ChangeRequest;
	tasks: TaskPlan[];
	waves: WavePlan[];
};

export async function buildRoadmapDetailSummary(cwd: string): Promise<RoadmapDetailSummary> {
	const state = await loadState(cwd)
	if (!state.active || !state.roadmap) {
		return {kind: 'empty', message: NO_ACTIVE_ROADMAP_MESSAGE}
	}

	const validation = await validateRoadmapState(cwd)
	const gate = await validateImplementationGate(cwd)
	const next = await nextActionPlan(cwd)
	const context = activePlanContext(state)
	const canonicalBlockers = await loadRoadmapBlockers(cwd, state.roadmap.roadmap_id)
	const openCanonicalBlockers = canonicalBlockers.filter((blocker) => blocker.status === 'open')
	const qualityGateHistory = (await listQualityGates(cwd, {
		roadmapId: state.roadmap.roadmap_id,
		gate: 'roadmap_milestone_check',
		limit: 3,
	})).history.map(eventSummary).reverse()
	const events = (await readRoadmapEvents(cwd, {
		roadmapId: state.roadmap.roadmap_id,
		limit: 6,
	})).events.map(eventSummary).reverse()
	const qualityGate = qualityGateSummary(state.roadmap, qualityGateHistory)
	const validationSummary = checkSummary(validation, validation.valid ? 'valid' : 'invalid')
	const gateSummary = displayGateSummary(
		checkSummary(gate, gate.valid ? 'open' : 'closed'),
		implementationGateIssuesAreActionable(state, next),
	)
	const waves = wavesSummary(context)
	const activeTasks = activeTasksSummary(context)
	const canonicalBlockerDetails = canonicalBlockersSummary(canonicalBlockers)
	const milestones = await milestoneDetails(cwd, state)

	const summary: ActiveRoadmapDetailSummary = {
		kind: 'active',
		roadmap: {
			id: state.roadmap.roadmap_id,
			title: state.roadmap.title,
			phase: state.roadmap.phase,
			label: `${state.roadmap.roadmap_id} (${state.roadmap.title})`,
		},
		active: {
			milestone: referenceFromPlan(state.active.milestone_id, state.milestone),
			changeRequest: referenceFromPlan(state.active.change_request_id, state.changeRequest),
		},
		bypass: bypassSummary(state),
		qualityGate,
		validation: validationSummary,
		gate: gateSummary,
		roadmapHealth: roadmapHealthSummary(state, qualityGate, validationSummary, gateSummary, openCanonicalBlockers.length),
		nextAction: next,
		nextCommand: nextCommandSummary(next, state),
		waves,
		activeExecution: activeExecutionSummary(context, waves, activeTasks),
		activeTasks,
		milestones,
		blockers: blockerSummary(context, canonicalBlockers),
		canonicalBlockers: canonicalBlockerDetails,
		recentEvents: events,
		availableControls: [],
		usage: usageSummary(state.usage, state.active.milestone_id, state.active.change_request_id),
	}

	summary.availableControls = availableControls(summary)
	return summary
}

function implementationGateIssuesAreActionable(state: LoadedState, next: NextActionPlan): boolean {
	return isImplementationPhase(state.roadmap?.phase) ||
		state.changeRequest?.status === 'implementing' ||
		next.id.startsWith('progress:')
}

function isImplementationPhase(phase: Phase | undefined): boolean {
	return phase === 'implementing' || phase === 'reviewing'
}

function displayGateSummary(gate: RoadmapDetailCheck, actionable: boolean): RoadmapDetailCheck {
	if (actionable) return gate
	return {
		...gate,
		errors: [],
		warnings: [],
		issues: [],
	}
}

function activePlanContext(state: LoadedState): PlanContext | undefined {
	const plan = state.changeRequest ?? state.milestone
	if (!plan) return undefined
	return {plan, tasks: plan.tasks, waves: plan.waves}
}

async function milestoneDetails(cwd: string, state: LoadedState): Promise<RoadmapDetailMilestone[]> {
	const roadmap = state.roadmap
	if (!roadmap) return []

	return await Promise.all(roadmap.milestones.map(async (milestone) => {
		const planPath = milestonePlanPath(cwd, roadmap.roadmap_id, milestone.id)
		if (!(await fileExists(planPath))) {
			return {
				id: milestone.id,
				title: milestone.title,
				status: milestone.status,
				label: `${milestone.id} - ${milestone.title} (${milestone.status})`,
				detail: 'outline' as const,
				waves: [],
			}
		}

		const plan = await loadMilestonePlan(cwd, roadmap.roadmap_id, milestone.id)
		return {
			id: milestone.id,
			title: milestone.title,
			status: plan.status,
			label: `${milestone.id} - ${milestone.title} (${plan.status})`,
			detail: 'plan' as const,
			waves: plan.waves.map((wave) => ({
				id: wave.id,
				status: wave.status,
				goal: wave.goal,
				label: `${wave.id} (${wave.status})`,
				tasks: wave.tasks.map((taskId) => taskDetail(taskId, plan.tasks.find((task) => task.id === taskId))),
			})),
		}
	}))
}
