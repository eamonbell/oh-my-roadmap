import {withDiagnosticTiming} from '../diagnostics'
import {searchContext} from '../context'
import {listBlockers, openBlocker, transition,} from '../store/index'
import type {NextActionHint} from '../report/index'
import type {RoadmapBlocker} from '../types'
import {activePlanContext, type ActivePlanContext, assertImplementationReady,} from './context'
import {
	manifestPromptSection,
	setProgress,
	verificationPreflightFor,
	verificationPreflightPromptSection,
} from './dispatch'
import type {
	PlanDerivedManifest,
	PrepareWaveReviewResult,
	RecordWaveReviewInput,
	RecordWaveReviewResult,
	VerificationPreflightHint,
	WaveOrchestrationTargetInput,
} from './types'

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

function dedupeConcat(lists: string[][]): string[] {
	const seen = new Set<string>()
	for (const list of lists) {
		for (const item of list) seen.add(item)
	}
	return [...seen]
}

// Review manifest spans the whole wave: reviewers inspect all active tasks together, so
// sibling reservation does not apply (reserved_sibling_scope is empty).
export function reviewManifest(ctx: ActivePlanContext): PlanDerivedManifest {
	return {
		owned_files: dedupeConcat(ctx.activeTasks.map((task) => task.owned_files)),
		owned_modules: dedupeConcat(ctx.activeTasks.map((task) => task.owned_modules)),
		shared_interfaces: dedupeConcat(ctx.activeTasks.map((task) => task.shared_interfaces)),
		dependencies: dedupeConcat(ctx.activeTasks.map((task) => task.depends_on)),
		reserved_sibling_scope: [],
		relevant_existing_code: ctx.plan.relevant_existing_code,
		relevant_documentation: ctx.plan.relevant_documentation,
	}
}

export function reviewVerificationPreflight(ctx: ActivePlanContext): VerificationPreflightHint {
	return verificationPreflightFor(ctx.plan.verification_commands)
}

function reviewPrompt(ctx: ActivePlanContext): string {
	const taskLines = ctx.activeTasks
	.map((task) => `- ${task.id}: ${task.title} (${task.worker}); owned files ${task.owned_files.join(', ') || '(none)'}; owned modules ${task.owned_modules.join(', ') || '(none)'}`)
	.join('\n')
	const manifestSection = manifestPromptSection(reviewManifest(ctx))
	const preflightSection = verificationPreflightPromptSection(reviewVerificationPreflight(ctx))
	const scopeHeader = ctx.isAdhoc
		? `Ad-hoc plan: ${ctx.roadmapId}\n`
		: `Roadmap: ${ctx.roadmapId}\nMilestone: ${ctx.milestoneId}\n${ctx.changeRequestId ? `Change request: ${ctx.changeRequestId}\n` : ''}`
	return `You are reviewer for oh-my-roadmap wave ${ctx.activeWave.id}: ${ctx.activeWave.goal}.

${scopeHeader}Review checkpoint:
${ctx.activeWave.review_checkpoint}

Wave exit criteria:
${ctx.activeWave.exit_criteria.map((item) => `- ${item}`).join('\n')}

Tasks in this wave:
${taskLines}

Acceptance criteria:
${ctx.plan.acceptance_criteria.map((item) => `- ${item}`).join('\n')}

Verification commands:
${ctx.plan.verification_commands.map((item) => `- ${item}`).join('\n')}

${manifestSection}

${preflightSection}

Before creating throwaway verification code or code-level repros, call omr_style_guide with the relevant task owned files from the manifest above or the files you are inspecting, and follow any recorded hard/style guidance where practical. If no relevant file path is known, skip the call and do not invent language-specific rules.

Review only this active wave. Verify completed work against task scope, ownership, shared interfaces, exit criteria, and acceptance criteria. Report passed or failed status with a summary and concrete findings for the orchestrator to record with omr_record_wave_review.`
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

		// Match worker notes by the wave's task IDs rather than wave_id: waveId is an
		// optional field on append_note and worker notes are sometimes written without
		// it, which previously excluded them here. Task IDs are unique per wave and are
		// reliably stamped on worker notes.
		const workerNotes = await searchContext(cwd, {
			artifacts: ['notes'],
			kinds: ['worker'],
			taskIds: ctx.activeTasks.map((task) => task.id),
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
			manifest: reviewManifest(ctx),
			verification_preflight: reviewVerificationPreflight(ctx),
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

function passedWaveNextActions(ctx: ActivePlanContext): NextActionHint[] | undefined {
	// Waves are ordered by their position in ctx.plan.waves, so the "next wave" is the
	// first later wave (after the active wave's index) that is not yet complete.
	const activeWaveIndex = ctx.plan.waves.findIndex((wave) => wave.id === ctx.activeWave.id)
	if (activeWaveIndex < 0) return undefined
	const nextWave = ctx.plan.waves.slice(activeWaveIndex + 1).find((wave) => wave.status !== 'complete')
	if (nextWave) {
		// Only advance into a wave that has not started. If the next pending wave is already
		// running, reviewing, or blocked, its existing state stays authoritative and we emit
		// no hint.
		if (nextWave.status !== 'pending') return undefined
		return [{
			label: 'Advance to next wave',
			tool: {
				name: 'omr_transition',
				input: {
					operation: 'update_implementation_progress',
					progress: {activeWaveId: nextWave.id, step: 'not_started', activeTaskIds: []},
				},
			},
			why: `Wave ${ctx.activeWave.id} passed review and progress is ready_for_next_wave; ${nextWave.id} is the next pending wave.`,
		}]
	}
	return [{
		label: 'Mark closeout ready',
		tool: {
			name: 'omr_transition',
			input: {
				operation: 'update_implementation_progress',
				progress: {step: 'closeout_ready', activeTaskIds: []},
			},
		},
		why: `Wave ${ctx.activeWave.id} passed review and all waves are complete.`,
	}]
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
			})
			await setProgress(cwd, ctx, 'ready_for_next_wave', [])
			const nextActions = passedWaveNextActions(ctx)
			return {
				wave_id: ctx.activeWave.id,
				wave_status: 'complete',
				progress_step: 'ready_for_next_wave',
				blockers: [],
				...(nextActions ? {next_actions: nextActions} : {}),
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
