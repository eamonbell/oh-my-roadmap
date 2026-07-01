import type {ExtensionContext, ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {amend, type AmendmentInput, createChangeRequest, type CreateChangeRequestInput,} from '../../core/store/index'
import {applyNextAction, nextActionPlan, renderReport} from '../../core/report/index'
import {validateRoadmapState} from '../../core/validation'
import {textResult, type ToolRegistrationContext} from './shared'

export function registerReportTools(ctx: ToolRegistrationContext): void {
	const {z, register} = ctx
	const {changeRequestInputSchema} = ctx.schemas

	register({
		name: 'roadmap_engineer_validate',
		label: 'Validate Roadmap',
		description: 'Validate roadmap artifacts, approvals, waves, ownership, notes, and gates.',
		approval: 'read',
		parameters: z.object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			const result = await validateRoadmapState(ctx.cwd)
			return textResult(result.valid ? 'Roadmap state is valid.' : 'Roadmap state is invalid.', result)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_next_action',
		label: 'Next Roadmap Action',
		description: 'Compute the next legal action for the active roadmap workflow.',
		approval: 'read',
		parameters: z.object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			const plan = await nextActionPlan(ctx.cwd)
			const action = plan.description
			return textResult(action, {action, plan})
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_apply_next_action',
		label: 'Apply Next Roadmap Action',
		description: 'Apply the current safe, unambiguous next action by id.',
		approval: 'write',
		parameters: z.object({
			actionId: z.string(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await applyNextAction(ctx.cwd, (params as { actionId: string }).actionId)
			return textResult(`Applied next action: ${result.plan.label}.`, result)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_amend',
		label: 'Amend Roadmap',
		description: 'Record approved roadmap amendments or milestone plan amendments.',
		approval: 'write',
		parameters: z.object({
			scope: z.enum(['roadmap', 'milestone']),
			title: z.string(),
			body: z.string(),
			material: z.boolean(),
			approvedBy: z.string().optional(),
			approvalSummary: z.string().optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const filePath = await amend(ctx.cwd, params as AmendmentInput)
			return textResult(`Recorded amendment in ${filePath}.`, {filePath})
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_create_change_request',
		label: 'Create Change Request',
		description: 'Create an active post-implementation change request and change plan.',
		approval: 'write',
		parameters: changeRequestInputSchema,
		async execute(_id, params, _signal, _update, ctx) {
			const change = await createChangeRequest(ctx.cwd, params as CreateChangeRequestInput)
			return textResult(`Created change request ${change.change_request_id}.`, change)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_render_report',
		label: 'Render Roadmap Report',
		description: 'Render active roadmap status, validation, implementation gate, and next action.',
		approval: 'read',
		parameters: z.object({}),
		async execute(_id, _params, _signal, _update, ctx: ExtensionContext) {
			const report = await renderReport(ctx.cwd)
			return textResult(report, {report})
		},
	} as ToolDefinition)
}
