import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {transition, type TransitionInput} from '@oh-my-roadmap/core/store/index'
import {nextActionHint, nextActionPlan, type NextActionHint} from '@oh-my-roadmap/core/report/index'
import {textResult, type ToolRegistrationContext} from './shared'

export function registerTransitionTools(ctx: ToolRegistrationContext): void {
	const {z, register} = ctx
	const {
		approvalSchema,
		milestoneInputSchema,
		changeRequestInputSchema,
		implementationProgressInputSchema,
		closeoutSchema,
		waveFlowCheckInputSchema
	} = ctx.schemas

	register({
		name: 'omr_transition',
		label: 'Transition Roadmap',
		description: 'Apply a legal roadmap, milestone, bypass, or change-request state transition.',
		approval: 'write',
		parameters: z.object({
			operation: z.enum([
				'record_discovery',
				'approve_roadmap',
				'reopen_roadmap',
				'start_milestone_planning',
				'create_milestone_plan',
				'approve_milestone',
				'update_milestone_plan',
				'start_implementation',
				'start_reviewing',
				'start_closeout',
				'complete_milestone',
				'request_bypass',
				'clear_bypass',
				'approve_change',
				'update_change_request_plan',
				'close_change',
				'update_task_status',
				'update_wave_status',
				'update_implementation_progress',
				'record_closeout',
				'record_wave_flow_check',
				'record_roadmap_milestone_check',
			]),
			...approvalSchema.shape,
			reason: z.string().optional(),
			discovery: z
			.object({
				recorded: z.boolean().optional(),
				external_research_required: z.boolean().optional(),
				external_research_recorded: z.boolean().optional(),
				findings: z.array(z.string()).optional(),
			})
			.optional(),
			milestone: milestoneInputSchema.optional(),
			changeRequest: changeRequestInputSchema.optional(),
			taskId: z.string().optional(),
			taskStatus: z.enum(['assigned', 'started', 'done', 'blocked']).optional(),
			waveId: z.string().optional(),
			waveStatus: z.enum(['pending', 'running', 'reviewing', 'blocked', 'complete']).optional(),
			progress: implementationProgressInputSchema.optional(),
			closeout: closeoutSchema.optional(),
			waveFlowCheck: waveFlowCheckInputSchema.optional(),
			roadmapMilestoneCheck: waveFlowCheckInputSchema.optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const input = params as TransitionInput
			const state = await transition(ctx.cwd, input)
			let next_actions: NextActionHint[] = []
			try {
				const next = await nextActionPlan(ctx.cwd)
				next_actions = nextActionHint(next, 'Transition applied; this is the next executable workflow action.')
			} catch {
				next_actions = []
			}
			const hint = next_actions[0]
			const text = hint
				? `Transition applied: ${input.operation}. Next action: ${hint.label}.`
				: `Transition applied: ${input.operation}.`
			return textResult(text, {...state, next_actions})
		},
	} as ToolDefinition)
}
