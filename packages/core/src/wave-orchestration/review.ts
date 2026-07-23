import {withDiagnosticTiming} from '../diagnostics'
import {searchContext} from '../context'
import {listBlockers, openBlocker, transition,} from '../store/index'
import type {NextActionHint} from '../report/index'
import type {ImplementationProgressStep, RoadmapBlocker, WavePlan} from '../types'
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

You own running the wave's build, tests, and verification commands. Workers do not run builds or tests — a concurrent sibling task may have been incomplete when a worker finished — so this review is the first point where the whole wave is built and verified together. Run the verification commands above, and treat a genuine build or test failure as a BLOCKING (worker-fixable) finding that names the failing command and cause; note any command you could not run.

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

		// Re-review detection. A prior FAILED review is recorded deterministically as
		// blockers titled `Wave <id> review failed` (see recordWaveReview below), one per
		// finding. Their presence for the active wave means the same reviewer should be
		// woken rather than a fresh one spawned. prior_reviewer_agent_id is the most recent
		// reviewer_runs entry for the wave (recorded via recordReviewerDispatch).
		const failedTitle = `Wave ${ctx.activeWave.id} review failed`
		const waveBlockers = await listBlockers(cwd, {
			roadmapId: ctx.roadmapId,
			milestoneId: ctx.milestoneId,
			...(ctx.changeRequestId ? {changeRequestId: ctx.changeRequestId} : {}),
			waveId: ctx.activeWave.id,
		})
		const priorFindings = waveBlockers.blockers
			.filter((blocker) => normalizeReviewText(blocker.title) === normalizeReviewText(failedTitle))
			.map((blocker) => blocker.description)
		const reReview = priorFindings.length > 0
		const priorReviewer = ctx.plan.progress.reviewer_runs
			.filter((run) => run.wave_id === ctx.activeWave.id)
			.at(-1)

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
			re_review: reReview,
			...(reReview && priorReviewer ? {prior_reviewer_agent_id: priorReviewer.agent_id} : {}),
			...(reReview && priorFindings.length > 0 ? {prior_findings: priorFindings} : {}),
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

// Resolution of what should happen to progress immediately after a wave passes review.
// - 'activate': a later wave exists and is pending, so progress can move straight onto it.
// - 'closeout': every wave (including the active one) is now complete.
// - 'none': the active wave could not be located in plan.waves, or the next incomplete wave
//   is already running/reviewing/blocked — its existing state stays authoritative and progress
//   is left on ready_for_next_wave for a human/agent to resolve explicitly.
type PassedWaveAdvance =
	| {kind: 'activate'; nextWave: WavePlan}
	| {kind: 'closeout'}
	| {kind: 'none'}

// Waves are ordered by their position in ctx.plan.waves, so the "next wave" is the first
// later wave (after the active wave's index) that is not yet complete.
function resolvePassedWaveAdvance(ctx: ActivePlanContext): PassedWaveAdvance {
	const activeWaveIndex = ctx.plan.waves.findIndex((wave) => wave.id === ctx.activeWave.id)
	if (activeWaveIndex < 0) return {kind: 'none'}
	const nextWave = ctx.plan.waves.slice(activeWaveIndex + 1).find((wave) => wave.status !== 'complete')
	if (nextWave) {
		// Only advance into a wave that has not started. If the next pending wave is already
		// running, reviewing, or blocked, its existing state stays authoritative.
		if (nextWave.status !== 'pending') return {kind: 'none'}
		return {kind: 'activate', nextWave}
	}
	return {kind: 'closeout'}
}

function passedWaveNextActions(ctx: ActivePlanContext, advance: PassedWaveAdvance): NextActionHint[] | undefined {
	if (advance.kind === 'none') return undefined
	if (advance.kind === 'activate') {
		return [{
			label: 'Advance to next wave',
			tool: {
				name: 'omr_transition',
				input: {
					operation: 'update_implementation_progress',
					progress: {activeWaveId: advance.nextWave.id, step: 'not_started', activeTaskIds: []},
				},
			},
			why: `Wave ${ctx.activeWave.id} passed review and progress is ready_for_next_wave; ${advance.nextWave.id} is the next pending wave.`,
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

// Applies the resolved advance in place so a passed review leaves progress ready to dispatch
// (or closeout) without requiring a separate update_implementation_progress transition from the
// caller. Mirrors the budget-enforcement gate's pattern in dispatch.ts of calling setProgress /
// transition inline before the caller's next assertDispatchableWave check.
async function applyPassedWaveAdvance(
	cwd: string,
	ctx: ActivePlanContext,
	advance: PassedWaveAdvance,
): Promise<ImplementationProgressStep> {
	if (advance.kind === 'activate') {
		await transition(cwd, {
			operation: 'update_implementation_progress',
			progress: {activeWaveId: advance.nextWave.id, step: 'not_started', activeTaskIds: []},
		})
		return 'not_started'
	}
	if (advance.kind === 'closeout') {
		await transition(cwd, {
			operation: 'update_implementation_progress',
			progress: {step: 'closeout_ready', activeTaskIds: []},
		})
		return 'closeout_ready'
	}
	await setProgress(cwd, ctx, 'ready_for_next_wave', [])
	return 'ready_for_next_wave'
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
			// Auto-advance active_wave_id past the just-completed wave so a subsequent
			// prepareWaveDispatch does not re-resolve this now-complete wave and throw. The
			// next_actions hint below stays informational: it describes the same transition
			// that was just applied, in case a caller inspects it, but the state is already
			// advanced and no separate omr_transition call is required.
			const advance = resolvePassedWaveAdvance(ctx)
			const progressStep = await applyPassedWaveAdvance(cwd, ctx, advance)
			const nextActions = passedWaveNextActions(ctx, advance)
			return {
				wave_id: ctx.activeWave.id,
				wave_status: 'complete',
				progress_step: progressStep,
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
