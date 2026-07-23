import type {ExtensionContext, ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {amend, type AmendmentInput, createChangeRequest, type CreateChangeRequestInput,} from '@oh-my-roadmap/core/store/index'
import {applyNextAction, formatValidationIssues, nextActionHint, nextActionPlan, renderReport, type NextActionHint} from '@oh-my-roadmap/core/report/index'
import {validateRoadmapState} from '@oh-my-roadmap/core/validation'
import {receiptResult, textResult, type ToolRegistrationContext} from './shared'

export function registerReportTools(ctx: ToolRegistrationContext): void {
	const {z, register} = ctx
	const {changeRequestInputSchema} = ctx.schemas

	register({
		name: 'omr_validate',
		label: 'Validate Roadmap',
		description: 'Validate roadmap artifacts, approvals, waves, ownership, notes, and gates.',
		approval: 'read',
		parameters: z.object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			const result = await validateRoadmapState(ctx.cwd)
			const summary = result.valid ? 'Roadmap state is valid.' : 'Roadmap state is invalid.'
			const issueLines = formatValidationIssues(result)
			const baseText = issueLines.length > 0 ? `${summary}\n${issueLines.join('\n')}` : summary
			let next_actions: NextActionHint[] = []
			try {
				const next = await nextActionPlan(ctx.cwd)
				next_actions = nextActionHint(next, 'Roadmap validation completed; this is the next executable workflow action.')
			} catch {
				next_actions = []
			}
			const hint = next_actions[0]
			const text = hint ? `${baseText}\nNext action: ${hint.label}.` : baseText
			return textResult(text, {...result, next_actions})
		},
	} as ToolDefinition)

	register({
		name: 'omr_next_action',
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
		name: 'omr_apply_next_action',
		label: 'Apply Next Roadmap Action',
		description: 'Apply the current safe, unambiguous next action by id.',
		approval: 'write',
		parameters: z.object({
			actionId: z.string(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await applyNextAction(ctx.cwd, (params as { actionId: string }).actionId)
			return receiptResult(ctx.cwd, `Applied next action: ${result.plan.label}.`, result)
		},
	} as ToolDefinition)

	register({
		name: 'omr_amend',
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
			return receiptResult(ctx.cwd, `Recorded amendment in ${filePath}.`, {filePath})
		},
	} as ToolDefinition)

	register({
		name: 'omr_create_change_request',
		label: 'Create Change Request',
		description: 'Create an active post-implementation change request and change plan.',
		approval: 'write',
		parameters: changeRequestInputSchema,
		async execute(_id, params, _signal, _update, ctx) {
			const change = await createChangeRequest(ctx.cwd, params as CreateChangeRequestInput)
			return receiptResult(ctx.cwd, `Created change request ${change.change_request_id}.`, change)
		},
	} as ToolDefinition)

	register({
		name: 'omr_render_report',
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
