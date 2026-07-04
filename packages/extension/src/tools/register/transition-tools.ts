import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {loadState, transitionWithReceipt, type TransitionInput, type TransitionReturnScope} from '@oh-my-roadmap/core/store/index'
import {closeoutRequirements} from '@oh-my-roadmap/core/closeout'
import {nextActionHint, nextActionPlan, type NextActionHint} from '@oh-my-roadmap/core/report/index'
import {textResult, type ToolRegistrationContext} from './shared'

// Fields each operation accepts beyond `operation` and `returnScope`. Any other
// declared top-level field is an irrelevant payload for that operation and is
// rejected before the core state machine runs (strict operation-specific input).
const OPERATION_FIELDS: Record<TransitionInput['operation'], readonly string[]> = {
	record_discovery: ['discovery'],
	approve_roadmap: ['approver', 'summary'],
	reopen_roadmap: ['reason'],
	record_roadmap_milestone_check: ['roadmapMilestoneCheck'],
	start_milestone_planning: [],
	create_milestone_plan: ['milestone'],
	approve_milestone: ['approver', 'summary'],
	update_milestone_plan: ['milestone'],
	start_implementation: [],
	start_reviewing: [],
	start_closeout: [],
	complete_milestone: [],
	request_bypass: ['reason', 'approver'],
	clear_bypass: [],
	approve_change: ['approver', 'summary'],
	update_change_request_plan: ['changeRequest'],
	close_change: [],
	update_task_status: ['taskId', 'taskStatus'],
	update_wave_status: ['waveId', 'waveStatus'],
	update_implementation_progress: ['progress'],
	record_closeout: ['closeout'],
	record_wave_flow_check: ['waveFlowCheck'],
}

function assertStrictTransitionInput(params: Record<string, unknown>): void {
	const operation = params.operation as TransitionInput['operation']
	const allowed = OPERATION_FIELDS[operation] ?? []
	for (const key of Object.keys(params)) {
		if (key === 'operation' || key === 'returnScope') continue
		if (params[key] === undefined) continue
		if (!allowed.includes(key)) {
			throw new Error(`Operation ${operation} does not accept field ${key}.`)
		}
	}
}

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
		description: 'Apply a legal roadmap, milestone, bypass, or change-request state transition. Returns a compact receipt by default; pass returnScope: "state" for the full loaded state.',
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
			returnScope: z.enum(['receipt', 'state']).optional(),
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
			const raw = params as Record<string, unknown>
			assertStrictTransitionInput(raw)
			const input = raw as unknown as TransitionInput
			const {state, receipt} = await transitionWithReceipt(ctx.cwd, input)
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
			const returnScope = (raw.returnScope as TransitionReturnScope | undefined) ?? 'receipt'
			if (returnScope === 'state') {
				return textResult(text, {...state, next_actions})
			}
			return textResult(text, {...receipt, next_actions})
		},
	} as ToolDefinition)

	register({
		name: 'omr_prepare_closeout',
		label: 'Prepare Closeout',
		description: 'Read ordinal closeout item IDs and an example record_closeout payload for the active milestone or change request.',
		approval: 'read',
		parameters: z.object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			const state = await loadState(ctx.cwd)
			const plan = state.changeRequest ?? state.milestone
			if (!plan || !state.roadmap) {
				throw new Error('No active milestone or change request to prepare closeout for.')
			}
			const evidence = state.changeRequest?.closeout ?? state.closeout
			const requirements = closeoutRequirements(plan.acceptance_criteria, plan.verification_commands, evidence)
			const status = evidence?.status ?? 'open'
			const toItem = (requirement: {id: string; item: string; result?: {status: string}}) => ({
				id: requirement.id,
				item: requirement.item,
				...(requirement.result ? {result_status: requirement.result.status} : {}),
			})
			const nextOperation = status === 'closed'
				? (state.changeRequest ? 'close_change' : 'complete_milestone')
				: 'record_closeout'
			const details = {
				roadmap_id: plan.roadmap_id,
				milestone_id: plan.milestone_id,
				...(state.changeRequest ? {change_request_id: state.changeRequest.change_request_id} : {}),
				status,
				acceptance: requirements.acceptance.map(toItem),
				verification: requirements.verification.map(toItem),
				worker_notes_reviewed: evidence?.worker_notes_reviewed ?? false,
				review_summary_present: Boolean(evidence?.review_summary?.trim()),
				unresolved_risks: evidence?.unresolved_risks ?? [],
				next_operation: nextOperation,
				example_closeout: {
					status: 'closed',
					acceptance_results: requirements.acceptance.map((requirement) => ({itemId: requirement.id, status: 'passed'})),
					verification_results: requirements.verification.map((requirement) => ({itemId: requirement.id, status: 'passed'})),
					worker_notes_reviewed: true,
					review_summary: '<summary>',
					unresolved_risks: [],
				},
			}
			return textResult(JSON.stringify(details), details)
		},
	} as ToolDefinition)
}
