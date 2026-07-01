import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {
	prepareWaveDispatch,
	prepareWaveReview,
	recordWaveResult,
	type RecordWaveResultInput,
	recordWaveReview,
	type RecordWaveReviewInput,
	recordWorkerAbandoned,
	recordWorkerDispatch,
	type RecordWorkerDispatchInput,
	type RecordWorkerRunStatusInput,
	recordWorkerTransportFailed,
	type WaveOrchestrationTargetInput,
} from '../../core/wave-orchestration/index'
import {textResult, type ToolRegistrationContext} from './shared'

export function registerWaveTools(ctx: ToolRegistrationContext): void {
	const {z, register} = ctx
	const {waveOrchestrationTargetSchema} = ctx.schemas

	register({
		name: 'roadmap_engineer_prepare_wave_dispatch',
		label: 'Prepare Wave Dispatch',
		description: 'Validate the active implementation wave and return exact worker assignment packages.',
		approval: 'write',
		parameters: waveOrchestrationTargetSchema,
		async execute(_id, params, _signal, _update, ctx) {
			const result = await prepareWaveDispatch(ctx.cwd, params as WaveOrchestrationTargetInput)
			return textResult(JSON.stringify(result, null, 2), result)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_record_worker_dispatch',
		label: 'Record Worker Dispatch',
		description: 'Persist an active worker-run lease immediately after spawning a background worker job.',
		approval: 'write',
		parameters: waveOrchestrationTargetSchema.extend({
			taskId: z.string(),
			agentId: z.string(),
			jobId: z.string(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await recordWorkerDispatch(ctx.cwd, params as RecordWorkerDispatchInput)
			return textResult(`Recorded worker dispatch for ${result.task_id}.`, result)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_record_worker_transport_failed',
		label: 'Record Worker Transport Failed',
		description: 'Mark an active worker run as transport_failed while the orchestrator probes the original worker.',
		approval: 'write',
		parameters: waveOrchestrationTargetSchema.extend({
			taskId: z.string(),
			agentId: z.string().optional(),
			jobId: z.string().optional(),
			lastError: z.string().optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await recordWorkerTransportFailed(ctx.cwd, params as RecordWorkerRunStatusInput)
			return textResult(`Recorded worker transport failure for ${result.task_id}.`, result)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_record_worker_abandoned',
		label: 'Record Worker Abandoned',
		description: 'Mark an unreachable worker run abandoned after the 5-minute probe timeout or when the job/agent is absent from the current session.',
		approval: 'write',
		parameters: waveOrchestrationTargetSchema.extend({
			taskId: z.string(),
			agentId: z.string().optional(),
			jobId: z.string().optional(),
			lastError: z.string().optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await recordWorkerAbandoned(ctx.cwd, params as RecordWorkerRunStatusInput)
			return textResult(`Recorded worker abandoned for ${result.task_id}.`, result)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_record_wave_result',
		label: 'Record Wave Result',
		description: 'Record an active-wave worker result, update task runtime state, and open blockers when needed.',
		approval: 'write',
		parameters: waveOrchestrationTargetSchema.extend({
			taskId: z.string(),
			status: z.enum(['completed', 'failed', 'blocked']),
			summary: z.string().optional(),
			notes: z.array(z.string()).optional(),
			blocker: z
			.object({
				title: z.string().optional(),
				description: z.string().optional(),
			})
			.optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await recordWaveResult(ctx.cwd, params as RecordWaveResultInput)
			return textResult(`Recorded wave task ${result.task_id} as ${result.status}.`, result)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_prepare_wave_review',
		label: 'Prepare Wave Review',
		description: 'Validate active-wave completion and return the exact reviewer package.',
		approval: 'write',
		parameters: waveOrchestrationTargetSchema,
		async execute(_id, params, _signal, _update, ctx) {
			const result = await prepareWaveReview(ctx.cwd, params as WaveOrchestrationTargetInput)
			return textResult(JSON.stringify(result, null, 2), result)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_record_wave_review',
		label: 'Record Wave Review',
		description: 'Record reviewer pass/fail, mark the active wave complete or blocked, and open review blockers.',
		approval: 'write',
		parameters: waveOrchestrationTargetSchema.extend({
			status: z.enum(['passed', 'failed']),
			summary: z.string(),
			findings: z.array(z.string()).optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const input = params as RecordWaveReviewInput
			const result = await recordWaveReview(ctx.cwd, input)
			return textResult(`Recorded wave review as ${input.status}.`, result)
		},
	} as ToolDefinition)
}
