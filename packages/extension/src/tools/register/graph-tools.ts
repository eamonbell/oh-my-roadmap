import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {renderMilestoneDependencyGraph} from 'oh-my-roadmap-core/plan-validation'
import {loadState} from 'oh-my-roadmap-core/store/index'
import {textResult, type ToolRegistrationContext} from './shared'

export function registerGraphTools(ctx: ToolRegistrationContext): void {
	const {z, register} = ctx

	register({
		name: 'omr_render_dependency_graph',
		label: 'Render Dependency Graph',
		description: 'Render a Mermaid graph of the active milestone (or change) task dependency DAG: one node per task, edges for depends_on.',
		approval: 'read',
		parameters: z.object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			const state = await loadState(ctx.cwd)
			const plan = state.changeRequest ?? state.milestone
			if (!plan) {
				const result = {milestone_id: null, task_count: 0, mermaid: ''}
				return textResult('No active milestone or change plan to graph.', result)
			}
			const mermaid = renderMilestoneDependencyGraph(plan.tasks)
			// Label with the graphed plan's own id: a change request's milestone_id is its PARENT
			// milestone, which would mis-attribute the change-request DAG.
			const planId = state.changeRequest?.change_request_id ?? plan.milestone_id
			const result = {plan_id: planId, milestone_id: plan.milestone_id, task_count: plan.tasks.length, mermaid}
			return textResult(mermaid, result)
		},
	} as ToolDefinition)
}
