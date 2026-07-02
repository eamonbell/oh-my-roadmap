import {applyNextAction, type NextActionPlan} from '../report/index'
import {buildRoadmapDetailSummary} from './summary'
import type {ActiveRoadmapDetailSummary, RoadmapDetailControl, RoadmapDetailControlResult,} from './types'

export async function applyRoadmapDetailControl(cwd: string, key: string): Promise<RoadmapDetailControlResult> {
	const summary = await buildRoadmapDetailSummary(cwd)
	if (summary.kind !== 'active') throw new Error('No active roadmap control is available')
	const control = summary.availableControls.find((candidate) => candidate.key === key)
	if (!control) throw new Error(`Unknown roadmap detail control: ${key}`)
	if (!control.enabled) throw new Error(`Roadmap detail control ${key} is disabled: ${control.reason ?? control.label}`)

	if (control.action === 'apply_next_action') {
		const actionId = typeof control.tool?.input.actionId === 'string' ? control.tool.input.actionId : ''
		const result = await applyNextAction(cwd, actionId)
		return {action: 'applied_next_action', control, result}
	}

	if (!control.prompt) throw new Error(`Roadmap detail control ${key} has no prompt to insert`)
	return {action: 'insert_prompt', control, prompt: control.prompt}
}

export function availableControls(summary: ActiveRoadmapDetailSummary): RoadmapDetailControl[] {
	return [
		safeNextActionControl(summary.nextAction),
		approvalControl(summary.nextAction),
		waveDispatchControl(summary),
		waveReviewControl(summary),
		checkerControl(summary),
		blockerControl(summary),
	]
}

function safeNextActionControl(next: NextActionPlan): RoadmapDetailControl {
	const enabled = next.status === 'ready' && next.safe_to_apply
	return {
		key: 'a',
		label: 'Apply safe next action',
		action: 'apply_next_action',
		enabled,
		...(enabled ? {} : {reason: `Next action is ${next.status} and safe_to_apply=${next.safe_to_apply}`}),
		tool: {
			name: 'omr_apply_next_action',
			input: {actionId: next.id},
		},
		prompt: toolPrompt('omr_apply_next_action', {actionId: next.id}),
	}
}

function approvalControl(next: NextActionPlan): RoadmapDetailControl {
	const enabled = next.status === 'approval_required'
	return {
		key: 'p',
		label: 'Ask for required approval',
		action: 'insert_prompt',
		enabled,
		...(enabled ? {} : {reason: 'Next action does not require approval'}),
		prompt: `Ask the user for explicit approval before changing roadmap state:
${next.description}`,
	}
}

function waveDispatchControl(summary: ActiveRoadmapDetailSummary): RoadmapDetailControl {
	const input = targetInput(summary)
	const enabled = !!summary.activeExecution?.activeWave &&
		summary.activeExecution.progressStep === 'not_started' &&
		summary.gate.status === 'open' &&
		summary.canonicalBlockers.counts.open === 0
	return {
		key: 'd',
		label: 'Prepare wave dispatch',
		action: 'insert_tool_call',
		enabled,
		...(enabled ? {} : {reason: 'No dispatchable active wave'}),
		tool: {name: 'omr_prepare_wave_dispatch', input},
		prompt: `${toolPrompt('omr_prepare_wave_dispatch', input)}

Dispatch only the returned assignments with the built-in task/subagent mechanism. Do not spawn workers directly from the dashboard.`,
	}
}

function waveReviewControl(summary: ActiveRoadmapDetailSummary): RoadmapDetailControl {
	const input = targetInput(summary)
	const enabled = !!summary.activeExecution?.activeWave && summary.activeExecution.progressStep === 'wave_review'
	return {
		key: 'r',
		label: 'Prepare wave review',
		action: 'insert_tool_call',
		enabled,
		...(enabled ? {} : {reason: 'Active progress is not at wave_review'}),
		tool: {name: 'omr_prepare_wave_review', input},
		prompt: `${toolPrompt('omr_prepare_wave_review', input)}

Dispatch only the returned reviewer package with the built-in task/subagent mechanism. Do not perform the review in the dashboard.`,
	}
}

function checkerControl(summary: ActiveRoadmapDetailSummary): RoadmapDetailControl {
	const waveFlowCheck = summary.nextAction.id.includes('wave-flow-check')
	const roadmapCheck = summary.nextAction.id.includes('milestone-check') || summary.qualityGate.status !== 'passed'
	const enabled = waveFlowCheck || roadmapCheck
	const prompt = waveFlowCheck
		? `Dispatch wave-flow-checker for the active plan. After the checker returns, record the result with:
${toolPrompt('omr_transition', {
			operation: 'record_wave_flow_check',
			waveFlowCheck: {
				status: 'passed',
				checkedBy: 'wave-flow-checker',
				summary: '<checker summary>',
				findings: [],
			},
		})}`
		: `Dispatch roadmap-milestone-checker for roadmap ${summary.roadmap.id}. After the checker returns, record the result with:
${toolPrompt('omr_transition', {
			operation: 'record_roadmap_milestone_check',
			roadmapMilestoneCheck: {
				status: 'passed',
				checkedBy: 'roadmap-milestone-checker',
				summary: '<checker summary>',
				findings: [],
			},
		})}`
	return {
		key: 'c',
		label: 'Checker rerun instructions',
		action: 'insert_prompt',
		enabled,
		...(enabled ? {} : {reason: 'No checker rerun is pending'}),
		prompt,
	}
}

function blockerControl(summary: ActiveRoadmapDetailSummary): RoadmapDetailControl {
	const blockers = summary.canonicalBlockers.open
	const enabled = blockers.length > 0
	const prompt = blockers.length === 0
		? 'No open canonical blockers.'
		: blockers.map((blocker) => `For blocker ${blocker.id} (${blocker.title}), use one of:
${toolPrompt('omr_resolve_blocker', {
			roadmapId: blocker.scope.roadmapId,
			blockerId: blocker.id,
			resolution: '<resolution>',
		})}
${toolPrompt('omr_defer_blocker', {
			roadmapId: blocker.scope.roadmapId,
			blockerId: blocker.id,
			deferReason: '<defer reason>',
		})}`).join('\n\n')
	return {
		key: 'b',
		label: 'Blocker resolve/defer templates',
		action: 'insert_prompt',
		enabled,
		...(enabled ? {} : {reason: 'No open canonical blockers'}),
		prompt,
	}
}

function targetInput(summary: ActiveRoadmapDetailSummary): Record<string, unknown> {
	return {
		roadmapId: summary.roadmap.id,
		...(summary.active.milestone?.id ? {milestoneId: summary.active.milestone.id} : {}),
		...(summary.active.changeRequest?.id ? {changeRequestId: summary.active.changeRequest.id} : {}),
	}
}

function toolPrompt(name: string, input: Record<string, unknown>): string {
	return `Call ${name} with input:
${JSON.stringify(input, null, 2)}`
}
