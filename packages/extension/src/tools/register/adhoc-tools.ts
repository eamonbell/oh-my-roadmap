import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {
	adhocTransition,
	type AdhocTransitionInput,
	createAdhocPlan,
	type CreateAdhocPlanInput,
	updateAdhocPlan,
} from 'oh-my-roadmap-core/store/index'
import {textResult, type ToolRegistrationContext} from './shared'

export function registerAdhocTools(ctx: ToolRegistrationContext): void {
	const {z, register, schemas} = ctx

	const planParameters = z.object({
		adhocId: z.string(),
		title: z.string(),
		request: z.string(),
		verificationCommands: z.array(z.string()),
		acceptanceCriteria: z.array(z.string()),
		openQuestions: z.array(z.string()).optional(),
		userInterview: z.array(z.string()).default([]),
		relevantExistingCode: z.array(z.string()).default([]),
		relevantDocumentation: z.array(z.string()).default([]),
		decisions: z.array(z.string()).default([]),
		dependencyAnalysis: z.array(z.string()).default([]),
		tasks: z.array(schemas.taskSchema),
		waves: z.array(schemas.waveSchema),
	})

	register({
		name: 'omr_init_adhoc',
		label: 'Init Ad-hoc Plan',
		description: 'Create a new ad-hoc plan (roadmap-free) and set it active. Refused while a roadmap or another ad-hoc plan is active.',
		approval: 'write',
		parameters: planParameters,
		async execute(_id, params, _signal, _update, ctx) {
			const plan = await createAdhocPlan(ctx.cwd, params as CreateAdhocPlanInput)
			return textResult(`Created ad-hoc plan ${plan.adhoc_id}.`, plan)
		},
	} as ToolDefinition)

	register({
		name: 'omr_update_adhoc_plan',
		label: 'Update Ad-hoc Plan',
		description: 'Replace the active ad-hoc plan definition while it is still a draft (before approval).',
		approval: 'write',
		parameters: planParameters,
		async execute(_id, params, _signal, _update, ctx) {
			const plan = await updateAdhocPlan(ctx.cwd, params as CreateAdhocPlanInput)
			return textResult(`Updated ad-hoc plan ${plan.adhoc_id}.`, plan)
		},
	} as ToolDefinition)

	register({
		name: 'omr_adhoc_transition',
		label: 'Ad-hoc Transition',
		description: 'Advance the active ad-hoc plan lifecycle: record_wave_flow_check, approve, start_implementing, start_reviewing, record_closeout, complete, cancel.',
		approval: 'write',
		parameters: z.object({
			operation: z.enum([
				'record_wave_flow_check',
				'approve',
				'start_implementing',
				'start_reviewing',
				'record_closeout',
				'complete',
				'cancel',
			]),
			approver: z.string().optional(),
			summary: z.string().optional(),
			waveFlowCheck: schemas.waveFlowCheckInputSchema.optional(),
			closeout: schemas.closeoutSchema.optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const plan = await adhocTransition(ctx.cwd, params as AdhocTransitionInput)
			return textResult(plan ? `Ad-hoc plan ${plan.adhoc_id} is now ${plan.status}.` : 'Ad-hoc plan cancelled.', plan ?? null)
		},
	} as ToolDefinition)
}
