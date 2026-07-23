import {withDiagnosticTiming} from '../diagnostics'
import {nowIso} from '../store/index'
import type {VerificationBaseline, VerificationBaselineCommandResult} from '../types'
import {activePlanContext, assertImplementationReady, writePlanRuntime} from './context'
import type {WaveOrchestrationTargetInput} from './types'

export interface RecordVerificationBaselineInput extends WaveOrchestrationTargetInput {
	commandResults: VerificationBaselineCommandResult[];
	capturedBy?: string;
}

// Captures a verification baseline at implementation start: an agent runs the plan's
// verification commands and records the results here, since core is a pure state engine
// and cannot run tests itself. Reviewers later diff wave-review findings against this
// baseline ("no new failures vs baseline"). Idempotent: recording again replaces the prior
// baseline rather than appending, mirroring how other wave-orchestration writers treat their
// single-slot progress fields.
export async function recordVerificationBaseline(
	cwd: string,
	input: RecordVerificationBaselineInput,
): Promise<VerificationBaseline> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'wave.recordVerificationBaseline',
		cwd,
		slowMs: 250,
	}, async () => {
		await assertImplementationReady(cwd)
		const ctx = await activePlanContext(cwd, input)

		const baseline: VerificationBaseline = {
			captured_at: nowIso(),
			captured_by: input.capturedBy?.trim() || 'orchestrator',
			command_results: input.commandResults,
		}

		await writePlanRuntime(cwd, {
			...ctx.plan,
			progress: {
				...ctx.plan.progress,
				verification_baseline: baseline,
				updated_at: nowIso(),
			},
		})

		return baseline
	})
}
