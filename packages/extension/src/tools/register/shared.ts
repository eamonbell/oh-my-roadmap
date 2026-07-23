import type { AgentToolResult } from '@oh-my-pi/pi-coding-agent'
import type { ExtensionAPI, ToolDefinition } from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import { nextActionHint, nextActionPlan, type NextActionHint } from '@oh-my-roadmap/core/report/index'

type ToolRegistrationZod = ExtensionAPI['zod']['z'];

export function textResult<T>(text: string, details: T): AgentToolResult<T> {
	return { content: [{ type: 'text', text }], details }
}

/**
 * Uniform rich receipt for bare-string mutating tools: computes the next
 * executable workflow action, appends "Next action: X" to the human summary,
 * and returns `next_actions` alongside the tool's existing details payload.
 * Mirrors the receipt shape already used by omr_transition and omr_validate.
 *
 * If `details` already carries a non-empty `next_actions` array (some core
 * operations — e.g. recordWaveReview's auto-advance hint — compute a precise,
 * concrete hint themselves), that existing hint is preferred and is NOT
 * overwritten by a freshly (and more generically) recomputed one.
 */
export async function receiptResult<T extends object>(
	cwd: string,
	summary: string,
	details: T,
	hintMessage?: string,
): Promise<AgentToolResult<T & { next_actions: NextActionHint[] }>> {
	const existing = (details as { next_actions?: unknown }).next_actions
	let next_actions: NextActionHint[] = Array.isArray(existing) ? (existing as NextActionHint[]) : []
	if (next_actions.length === 0) {
		try {
			const next = await nextActionPlan(cwd)
			next_actions = nextActionHint(next, hintMessage ?? 'Action recorded; this is the next executable workflow action.')
		} catch {
			next_actions = []
		}
	}
	const hint = next_actions[0]
	const text = hint ? `${summary} Next action: ${hint.label}.` : summary
	return textResult(text, { ...details, next_actions })
}

export function toolMetadata(tool: ToolDefinition, toolCallId: string, params: unknown): Record<string, unknown> {
	const raw = params && typeof params === 'object' && !Array.isArray(params)
		? params as Record<string, unknown>
		: {}
	return {
		tool_name: tool.name,
		tool_call_id: toolCallId,
		approval: tool.approval ?? 'exec',
		...(typeof raw.operation === 'string' ? { operation: raw.operation } : {}),
		...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
		...(typeof raw.actionId === 'string' ? { action_id: raw.actionId } : {}),
	}
}

export function createToolRegistrationSchemas(z: ToolRegistrationZod) {
	const approvalSchema = z.object({
		approver: z.string().optional(),
		summary: z.string().optional(),
	})
	const relevantCodeReferenceSchema = z.object({
		path: z.string(),
		line: z.number().int().positive().optional(),
		symbol: z.string().optional(),
		note: z.string(),
	})
	const sharedInterfaceContractSchema = z.object({
		name: z.string(),
		signature: z.string(),
		source_path: z.string(),
		line: z.number().int().positive().optional(),
		planned: z.boolean(),
		planned_by_task_id: z.string().optional(),
	})
	const taskSchema = z.object({
		id: z.string(),
		title: z.string(),
		objective: z.string(),
		implementation_notes: z.array(z.string()).default([]),
		done_criteria: z.array(z.string()),
		verification_commands: z.array(z.string()).default([]),
		worker: z.enum(['worker-light', 'worker', 'worker-heavy']),
		status: z.enum(['assigned', 'started', 'done', 'blocked']).default('assigned'),
		depends_on: z.array(z.string()).default([]),
		owned_files: z.array(z.string()).default([]),
		owned_modules: z.array(z.string()).default([]),
		shared_interfaces: z.array(z.string()).default([]),
		relevant_existing_code: z.array(relevantCodeReferenceSchema),
		shared_interface_contracts: z.array(sharedInterfaceContractSchema),
	})
	const waveSchema = z.object({
		id: z.string(),
		goal: z.string(),
		exit_criteria: z.array(z.string()),
		review_checkpoint: z.string(),
		status: z.enum(['pending', 'running', 'reviewing', 'blocked', 'complete']).default('pending'),
		tasks: z.array(z.string()),
	})
	const evidenceResultSchema = z
		.object({
			item: z.string().optional(),
			itemId: z.string().optional(),
			status: z.enum(['open', 'passed', 'failed', 'deferred']),
			reason: z.string().optional(),
			approver: z.string().optional(),
			at: z.string().optional(),
		})
		.refine((result) => result.item !== undefined || result.itemId !== undefined, {
			message: 'Closeout result requires itemId or item.',
		})
	const riskDispositionSchema = z.object({
		risk: z.string(),
		disposition: z.enum(['resolved', 'deferred']),
		reason: z.string().optional(),
		approver: z.string().optional(),
	})
	const closeoutSchema = z.object({
		status: z.enum(['open', 'recorded', 'closed']),
		acceptance_results: z.array(evidenceResultSchema),
		verification_results: z.array(evidenceResultSchema),
		worker_notes_reviewed: z.boolean(),
		review_summary: z.string(),
		unresolved_risks: z.array(riskDispositionSchema),
		closed_by: z.string().optional(),
		closed_at: z.string().optional(),
	})
	const milestoneInputSchema = z.object({
		milestoneId: z.string(),
		title: z.string(),
		verificationCommands: z.array(z.string()),
		acceptanceCriteria: z.array(z.string()),
		userInterview: z.array(z.string()).default([]),
		relevantExistingCode: z.array(z.string()).default([]),
		relevantDocumentation: z.array(z.string()).default([]),
		decisions: z.array(z.string()).default([]),
		dependencyAnalysis: z.array(z.string()).default([]),
		tasks: z.array(taskSchema),
		waves: z.array(waveSchema),
		openQuestions: z.array(z.string()).optional(),
	})
	const changeRequestInputSchema = z.object({
		changeRequestId: z.string(),
		title: z.string(),
		request: z.string(),
		verificationCommands: z.array(z.string()),
		acceptanceCriteria: z.array(z.string()),
		userInterview: z.array(z.string()).default([]),
		relevantExistingCode: z.array(z.string()).default([]),
		relevantDocumentation: z.array(z.string()).default([]),
		decisions: z.array(z.string()).default([]),
		dependencyAnalysis: z.array(z.string()).default([]),
		tasks: z.array(taskSchema),
		waves: z.array(waveSchema),
	})
	const implementationProgressStepSchema = z.enum([
		'not_started',
		'dispatching',
		'workers_running',
		'wave_review',
		'resolving_blockers',
		'ready_for_next_wave',
		'closeout_ready',
	])
	const implementationProgressInputSchema = z.object({
		activeWaveId: z.string().optional(),
		step: implementationProgressStepSchema,
		activeTaskIds: z.array(z.string()).default([]),
		blockedReason: z.string().optional(),
	})
	const waveFlowCheckInputSchema = z.object({
		status: z.enum(['passed', 'failed']),
		checkedBy: z.string().optional(),
		summary: z.string().optional(),
		findings: z.array(z.string()).default([]),
	})
	const contextArtifactSchema = z.enum(['notes', 'decisions', 'risks', 'roadmap', 'plan'])
	const contextNoteKindSchema = z.enum(['worker', 'review', 'orchestrator', 'decision', 'issue'])
	const contextNoteStatusSchema = z.enum(['open', 'resolved', 'deferred'])
	const blockerSeveritySchema = z.enum(['blocking', 'non_blocking'])
	const blockerStatusSchema = z.enum(['open', 'resolved', 'deferred'])
	const waveOrchestrationTargetSchema = z.object({
		roadmapId: z.string().optional(),
		milestoneId: z.string().optional(),
		changeRequestId: z.string().optional(),
	})
	const roadmapMilestoneSchema = z.object({
		id: z.string(),
		title: z.string(),
		status: z
			.enum([
				'planned',
				'blocked',
				'discovery',
				'roadmap_draft',
				'roadmap_approved',
				'milestone_planning',
				'milestone_approved',
				'implementing',
				'reviewing',
				'closeout',
				'complete',
			])
			.default('planned'),
		goal: z.string(),
		scope: z.array(z.string()),
		non_goals: z.array(z.string()),
		evidence: z.array(z.string()),
		dependencies: z.array(z.string()).default([]),
		risks: z.array(z.string()),
		acceptance_intent: z.array(z.string()),
		verification_intent: z.array(z.string()),
	})

	return {
		approvalSchema,
		taskSchema,
		waveSchema,
		evidenceResultSchema,
		riskDispositionSchema,
		closeoutSchema,
		milestoneInputSchema,
		changeRequestInputSchema,
		implementationProgressStepSchema,
		implementationProgressInputSchema,
		waveFlowCheckInputSchema,
		contextArtifactSchema,
		contextNoteKindSchema,
		contextNoteStatusSchema,
		blockerSeveritySchema,
		blockerStatusSchema,
		waveOrchestrationTargetSchema,
		roadmapMilestoneSchema,
	}
}

export type ToolRegistrationSchemas = ReturnType<typeof createToolRegistrationSchemas>;

export type ToolRegistrationContext = {
	api: ExtensionAPI;
	z: ToolRegistrationZod;
	register: (tool: ToolDefinition) => void;
	schemas: ToolRegistrationSchemas;
};
