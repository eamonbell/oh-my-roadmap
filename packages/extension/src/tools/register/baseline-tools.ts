import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {
	recordVerificationBaseline,
	type RecordVerificationBaselineInput,
} from '@oh-my-roadmap/core/wave-orchestration/index'
import {receiptResult, type ToolRegistrationContext} from './shared'

export function registerBaselineTools(ctx: ToolRegistrationContext): void {
	const {z, register} = ctx
	const {waveOrchestrationTargetSchema} = ctx.schemas

	register({
		name: 'omr_record_verification_baseline',
		label: 'Record Verification Baseline',
		description: 'Record the results of running the plan\'s verification commands at implementation start, so reviewers can later diff findings against a baseline ("no new failures vs baseline"). Recording again replaces the prior baseline.',
		approval: 'write',
		parameters: waveOrchestrationTargetSchema.extend({
			command_results: z.array(z.object({
				command: z.string(),
				exit_status: z.number().optional(),
				failing_tests: z.array(z.string()),
				failure_count: z.number(),
			})),
			captured_by: z.string().optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const {command_results, captured_by, ...rest} = params as Record<string, unknown> & {
				command_results: RecordVerificationBaselineInput['commandResults'];
				captured_by?: string;
			}
			const input: RecordVerificationBaselineInput = {
				...rest,
				commandResults: command_results,
				...(captured_by ? {capturedBy: captured_by} : {}),
			}
			const baseline = await recordVerificationBaseline(ctx.cwd, input)
			const totalFailing = baseline.command_results.reduce((sum, result) => sum + result.failure_count, 0)
			return receiptResult(
				ctx.cwd,
				`Recorded verification baseline: ${baseline.command_results.length} commands, ${totalFailing} failing tests.`,
				baseline,
			)
		},
	} as ToolDefinition)
}
