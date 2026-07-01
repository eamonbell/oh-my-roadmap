import {withDiagnosticTiming} from '../../diagnostics'
import {transition, type TransitionInput} from '../store/index'
import {nextActionPlan} from './next-action'
import type {ApplyNextActionResult} from './types'

export async function applyNextAction(cwd: string, actionId: string): Promise<ApplyNextActionResult> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'report.applyNextAction',
		cwd,
		slowMs: 250,
		metadata: {action_id: actionId},
	}, async () => {
		const requestedId = actionId.trim()
		if (!requestedId) throw new Error('apply_next_action requires actionId')
		const current = await nextActionPlan(cwd)
		if (current.id !== requestedId) {
			throw new Error(`Refusing to apply action ${requestedId}: current next action is ${current.id}.`)
		}
		if (current.status !== 'ready') {
			throw new Error(`Refusing to apply ${current.id}: action status is ${current.status}. ${current.description}`)
		}
		if (!current.safe_to_apply) {
			throw new Error(`Refusing to apply ${current.id}: action is not marked safe to apply. ${current.description}`)
		}
		if (!current.tool || current.tool.name !== 'roadmap_engineer_transition') {
			throw new Error(`Refusing to apply ${current.id}: action has no executable transition.`)
		}
		const state = await transition(cwd, current.tool.input as unknown as TransitionInput)
		return {action: current.description, plan: current, state}
	})
}
