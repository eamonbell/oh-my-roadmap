import {loadAdhocActive, loadAdhocPlan, loadRoadmapBlockers} from '../store/index'
import type {AdhocPlan, TaskPlan} from '../types'
import {validateImplementationGate, validateRoadmapState} from '../validation'
import type {NextActionPlan} from '../report/index'
import type {PlanContext} from './summary'
import {
	activeExecutionSummary,
	activeTasksSummary,
	canonicalBlockersSummary,
	checkSummary,
	roadmapHealthSummary,
	taskDetail,
	wavesSummary,
} from './formatters'
import type {
	ActiveRoadmapDetailSummary,
	RoadmapDetailQualityGate,
	RoadmapDetailSummary,
} from './types'

// Ad-hoc plans have no roadmap-milestone check; surface the wave-flow check in the same slot.
function qualityGateFor(plan: AdhocPlan): RoadmapDetailQualityGate {
	return {
		gate: 'roadmap_milestone_check',
		status: plan.wave_flow_check.status,
		label: `wave-flow check ${plan.wave_flow_check.status}`,
		roadmapRevision: 0,
		checkedRevision: 0,
		roadmapContentHash: '',
		checkedContentHash: '',
		...(plan.wave_flow_check.findings[0] ? {latestFinding: plan.wave_flow_check.findings[0]} : {}),
		history: [],
	}
}

// Map ad-hoc status to the next command the user should run.
function nextCommandFor(plan: AdhocPlan): {command: string; description: string} {
	switch (plan.status) {
		case 'adhoc_draft':
			return {command: '/omr:adhoc-plan', description: 'Finish planning, pass the wave-flow check, and approve.'}
		case 'adhoc_approved':
			return {command: '/omr:adhoc-implement', description: 'Start implementing the approved ad-hoc plan.'}
		case 'implementing':
			return {command: '/omr:adhoc-implement', description: 'Continue implementing the active waves.'}
		case 'reviewing':
			return {command: '/omr:adhoc-close', description: 'Record closeout evidence and complete the plan.'}
		case 'closeout':
			return {command: '/omr:adhoc-close', description: 'Complete the ad-hoc plan.'}
		default:
			return {command: '/omr:adhoc-status', description: 'Ad-hoc plan is complete.'}
	}
}

function nextActionFor(plan: AdhocPlan): NextActionPlan {
	const next = nextCommandFor(plan)
	return {
		id: `adhoc:${plan.adhoc_id}:${plan.status}`,
		label: next.description,
		description: next.description,
		status: 'agent_required',
		safe_to_apply: false,
		blockers: [],
		missing_inputs: [],
		scope: {roadmap_id: plan.adhoc_id},
	}
}

// Build the details-overlay summary for the active ad-hoc plan (reuses the roadmap view).
export async function buildAdhocDetailSummary(cwd: string): Promise<RoadmapDetailSummary> {
	const pointer = await loadAdhocActive(cwd)
	if (!pointer) {
		return {kind: 'empty', message: 'No active ad-hoc plan. Run /omr:adhoc-new to start one.'}
	}
	const plan = await loadAdhocPlan(cwd, pointer.adhoc_id)
	const context: PlanContext = {plan, tasks: plan.tasks, waves: plan.waves}
	const taskById = new Map<string, TaskPlan>(plan.tasks.map((task) => [task.id, task]))

	const validationResult = await validateRoadmapState(cwd)
	const validation = checkSummary(validationResult, validationResult.valid ? 'valid' : 'invalid')
	const gateResult = await validateImplementationGate(cwd)
	const gate = checkSummary(gateResult, gateResult.valid ? 'open' : 'closed')

	const canonical = await loadRoadmapBlockers(cwd, plan.adhoc_id)
	const openBlockerCount = canonical.filter((blocker) => blocker.status === 'open').length
	const qualityGate = qualityGateFor(plan)
	const waves = wavesSummary(context)
	const activeTasks = activeTasksSummary(context)
	const nextAction = nextActionFor(plan)
	const next = nextCommandFor(plan)

	const summary: ActiveRoadmapDetailSummary = {
		kind: 'active',
		roadmap: {id: plan.adhoc_id, title: plan.title, phase: plan.status, label: `${plan.adhoc_id} (${plan.title})`},
		active: {milestone: null, changeRequest: null},
		bypass: {active: false, label: 'inactive'},
		qualityGate,
		validation,
		gate,
		roadmapHealth: roadmapHealthSummary({adhoc: plan, adhocActive: pointer}, qualityGate, validation, gate, openBlockerCount),
		nextAction,
		nextCommand: {command: next.command, description: next.description, label: `${next.command} - ${next.description}`},
		waves,
		activeExecution: activeExecutionSummary(context, waves, activeTasks),
		activeTasks,
		milestones: [
			{
				id: plan.adhoc_id,
				title: plan.title,
				status: plan.status,
				label: `${plan.adhoc_id} - ${plan.title} (${plan.status})`,
				detail: 'plan',
				waves: plan.waves.map((wave) => ({
					id: wave.id,
					status: wave.status,
					goal: wave.goal,
					label: `${wave.id} (${wave.status})`,
					tasks: wave.tasks.map((taskId) => taskDetail(taskId, taskById.get(taskId))),
				})),
			},
		],
		blockers: [],
		canonicalBlockers: canonicalBlockersSummary(canonical),
		recentEvents: [],
		availableControls: [],
		usage: null,
	}
	return summary
}
