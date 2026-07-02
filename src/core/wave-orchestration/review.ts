import {withDiagnosticTiming} from '../../diagnostics'
import {searchContext} from '../context'
import {listBlockers, openBlocker, transition,} from '../store/index'
import type {RoadmapBlocker} from '../types'
import {activePlanContext, type ActivePlanContext, assertImplementationReady,} from './context'
import {setProgress} from './dispatch'
import type {PrepareWaveReviewResult, RecordWaveReviewInput, RecordWaveReviewResult, WaveOrchestrationTargetInput,} from './types'

async function assertNoOpenBlockingBlockers(cwd: string, ctx: ActivePlanContext): Promise<void> {
	const result = await listBlockers(cwd, {
		roadmapId: ctx.roadmapId,
		milestoneId: ctx.milestoneId,
		...(ctx.changeRequestId ? {changeRequestId: ctx.changeRequestId} : {}),
		status: 'open',
		severity: 'blocking',
	})
	if (result.blockers.length > 0) {
		throw new Error(`Active plan has open blocking blockers: ${result.blockers.map((blocker) => blocker.title).join(', ')}`)
	}
}

function reviewPrompt(ctx: ActivePlanContext): string {
	const taskLines = ctx.activeTasks
	.map((task) => `- ${task.id}: ${task.title} (${task.worker}); owned files ${task.owned_files.join(', ') || '(none)'}; owned modules ${task.owned_modules.join(', ') || '(none)'}`)
	.join('\n')
	return `You are reviewer for roadmap-engineer wave ${ctx.activeWave.id}: ${ctx.activeWave.goal}.

Roadmap: ${ctx.roadmapId}
Milestone: ${ctx.milestoneId}
${ctx.changeRequestId ? `Change request: ${ctx.changeRequestId}\n` : ''}Review checkpoint:
${ctx.activeWave.review_checkpoint}

Wave exit criteria:
${ctx.activeWave.exit_criteria.map((item) => `- ${item}`).join('\n')}

Tasks in this wave:
${taskLines}

Acceptance criteria:
${ctx.plan.acceptance_criteria.map((item) => `- ${item}`).join('\n')}

Verification commands:
${ctx.plan.verification_commands.map((item) => `- ${item}`).join('\n')}

Review only this active wave. Verify completed work against task scope, ownership, shared interfaces, exit criteria, and acceptance criteria. Report passed or failed status with a summary and concrete findings for the orchestrator to record with roadmap_engineer_record_wave_review.`
}

export async function prepareWaveReview(
	cwd: string,
	input: WaveOrchestrationTargetInput = {},
): Promise<PrepareWaveReviewResult> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'wave.prepareWaveReview',
		cwd,
		slowMs: 250,
	}, async () => {
		await assertImplementationReady(cwd)
		const ctx = await activePlanContext(cwd, input)
		if (ctx.activeWave.status === 'complete') throw new Error(`Active wave ${ctx.activeWave.id} is already complete`)
		if (ctx.activeWave.status === 'blocked') throw new Error(`Active wave ${ctx.activeWave.id} is blocked`)
		await assertNoOpenBlockingBlockers(cwd, ctx)

		const incomplete = ctx.activeTasks.filter((task) => task.status !== 'done')
		if (incomplete.length > 0) {
			throw new Error(`Active wave ${ctx.activeWave.id} still has incomplete tasks: ${incomplete.map((task) => task.id).join(', ')}`)
		}

		if (ctx.activeWave.status !== 'reviewing') {
			await transition(cwd, {operation: 'update_wave_status', waveId: ctx.activeWave.id, waveStatus: 'reviewing'})
		}
		await setProgress(cwd, ctx, 'wave_review', [])

		const workerNotes = await searchContext(cwd, {
			artifacts: ['notes'],
			kinds: ['worker'],
			waveId: ctx.activeWave.id,
			includeBodies: true,
			maxResults: 80,
		})

		return {
			roadmap_id: ctx.roadmapId,
			milestone_id: ctx.milestoneId,
			...(ctx.changeRequestId ? {change_request_id: ctx.changeRequestId} : {}),
			wave_id: ctx.activeWave.id,
			reviewer: 'reviewer',
			prompt: reviewPrompt(ctx),
			tasks: ctx.activeTasks.map((task) => ({
				task_id: task.id,
				title: task.title,
				worker: task.worker,
				owned_files: task.owned_files,
				owned_modules: task.owned_modules,
				shared_interfaces: task.shared_interfaces,
			})),
			worker_notes: workerNotes.results,
		}
	})
}

function normalizeReviewText(value: string): string {
	return value.trim().replace(/\s+/g, ' ')
}

function reviewBlockingFindings(input: RecordWaveReviewInput): string[] {
	const findings = input.findings && input.findings.length > 0 ? input.findings : [input.summary]
	return findings.flatMap((finding) => {
		const normalized = normalizeReviewText(finding)
		const upper = normalized.toUpperCase()
		if (
			upper.startsWith('PASS:') ||
			upper.startsWith('INFO:') ||
			upper.startsWith('NON_BLOCKING:') ||
			upper.startsWith('NON-BLOCKING:')
		) {
			return []
		}
		if (upper.startsWith('BLOCKING:')) {
			const stripped = normalizeReviewText(normalized.slice('BLOCKING:'.length))
			return stripped ? [stripped] : []
		}
		return normalized ? [normalized] : []
	})
}

function sameReviewBlocker(blocker: RoadmapBlocker, ctx: ActivePlanContext, title: string, description: string): boolean {
	return (
		blocker.roadmap_id === ctx.roadmapId &&
		blocker.milestone_id === ctx.milestoneId &&
		blocker.change_request_id === ctx.changeRequestId &&
		blocker.wave_id === ctx.activeWave.id &&
		normalizeReviewText(blocker.title) === normalizeReviewText(title) &&
		normalizeReviewText(blocker.description) === normalizeReviewText(description)
	)
}

export async function recordWaveReview(
	cwd: string,
	input: RecordWaveReviewInput,
): Promise<RecordWaveReviewResult> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'wave.recordWaveReview',
		cwd,
		slowMs: 250,
		metadata: {status: input.status},
	}, async () => {
		const ctx = await activePlanContext(cwd, input)
		const incomplete = ctx.activeTasks.filter((task) => task.status !== 'done')
		if (incomplete.length > 0) {
			throw new Error(`Active wave ${ctx.activeWave.id} still has incomplete tasks: ${incomplete.map((task) => task.id).join(', ')}`)
		}

		if (input.status === 'passed') {
			await assertNoOpenBlockingBlockers(cwd, ctx)
			await transition(cwd, {
				operation: 'update_wave_status',
				waveId: ctx.activeWave.id,
				waveStatus: 'complete',
				summary: input.summary,
			})
			await setProgress(cwd, ctx, 'ready_for_next_wave', [])
			return {
				wave_id: ctx.activeWave.id,
				wave_status: 'complete',
				progress_step: 'ready_for_next_wave',
				blockers: [],
			}
		}

		const blockers: RoadmapBlocker[] = []
		const existingBlockers = await listBlockers(cwd, {
			roadmapId: ctx.roadmapId,
			milestoneId: ctx.milestoneId,
			...(ctx.changeRequestId ? {changeRequestId: ctx.changeRequestId} : {}),
			waveId: ctx.activeWave.id,
		})
		for (const finding of reviewBlockingFindings(input)) {
			const title = `Wave ${ctx.activeWave.id} review failed`
			const existing = existingBlockers.blockers.find((blocker) => sameReviewBlocker(blocker, ctx, title, finding))
			if (existing) {
				blockers.push(existing)
				continue
			}
			blockers.push(await openBlocker(cwd, {
				roadmapId: ctx.roadmapId,
				milestoneId: ctx.milestoneId,
				...(ctx.changeRequestId ? {changeRequestId: ctx.changeRequestId} : {}),
				waveId: ctx.activeWave.id,
				severity: 'blocking',
				title,
				description: finding,
				createdBy: 'reviewer',
			}))
		}
		await transition(cwd, {
			operation: 'update_wave_status',
			waveId: ctx.activeWave.id,
			waveStatus: 'blocked',
			summary: input.summary,
		})
		await setProgress(cwd, ctx, 'resolving_blockers', [], input.summary)
		return {
			wave_id: ctx.activeWave.id,
			wave_status: 'blocked',
			progress_step: 'resolving_blockers',
			blockers,
		}
	})
}
