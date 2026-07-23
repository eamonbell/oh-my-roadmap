import { randomUUID } from 'node:crypto'
import { withDiagnosticTiming } from '../diagnostics'
import { searchContext } from '../context'
import type { ContextEntryResult } from '../context-types'
import { listBlockers, nowIso, openBlocker, transition, } from '../store/index'
import type { NextActionHint } from '../report/index'
import type { ImplementationProgressStep, ReworkQueueItem, RoadmapBlocker, WaveCheckpoint, WavePlan } from '../types'
import { DEFAULT_MAX_REVIEW_CYCLES, loadMergedConfig, loadProjectGitCheckpoints } from '../project-init'
import { activePlanContext, type ActivePlanContext, assertImplementationReady, writePlanRuntime, } from './context'
import {
	manifestPromptSection,
	ownedPathspecsForWave,
	setProgress,
	verificationPreflightFor,
	verificationPreflightPromptSection,
	type WaveWithGit,
} from './dispatch'
import { buildWaveChanges, commitWaveCheckpoint, resolveGitBoundary } from './git'
import type { CommitWaveCheckpointInput } from './git'
import { loadWaveContextSources, sliceReviewerSeededContext } from './context-seeding'
import type {
	PlanDerivedManifest,
	PrepareWaveReviewResult,
	RecordWaveReviewInput,
	RecordWaveReviewResult,
	RemainingWaveContext,
	SeededContext,
	VerificationPreflightHint,
	WaveOrchestrationTargetInput,
} from './types'

async function assertNoOpenBlockingBlockers(cwd: string, ctx: ActivePlanContext): Promise<void> {
	const result = await listBlockers(cwd, {
		roadmapId: ctx.roadmapId,
		milestoneId: ctx.milestoneId,
		...(ctx.changeRequestId ? { changeRequestId: ctx.changeRequestId } : {}),
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

export function remainingWaveContexts(
	plan: Pick<ActivePlanContext['plan'], 'waves' | 'tasks'>,
	activeWaveId: string,
): RemainingWaveContext[] {
	const activeWaveIndex = plan.waves.findIndex((wave) => wave.id === activeWaveId)
	if (activeWaveIndex < 0) throw new Error(`Active wave ${activeWaveId} is missing from the plan`)
	const taskById = new Map(plan.tasks.map((task) => [task.id, task]))
	return plan.waves
		.slice(activeWaveIndex + 1)
		.filter((wave) => wave.status !== 'complete')
		.map((wave) => ({
			wave_id: wave.id,
			goal: wave.goal,
			exit_criteria: wave.exit_criteria,
			tasks: wave.tasks.map((taskId) => {
				const task = taskById.get(taskId)
				if (!task) throw new Error(`Wave ${wave.id} references unknown task ${taskId}`)
				return {
					task_id: task.id,
					title: task.title,
					owned_files: task.owned_files,
					owned_modules: task.owned_modules,
					shared_interfaces: task.shared_interfaces,
					done_criteria: task.done_criteria,
				}
			}),
		}))
}

function reviewPrompt(
	ctx: ActivePlanContext,
	seededContext: SeededContext,
	remainingWaves: RemainingWaveContext[],
): string {
	const taskLines = ctx.activeTasks
		.flatMap((task) => [
			`- ${task.id}: ${task.title} (${task.worker}); owned files ${task.owned_files.join(', ') || '(none)'}; owned modules ${task.owned_modules.join(', ') || '(none)'}`,
			'  Done criteria:',
			...(task.done_criteria.length > 0 ? task.done_criteria.map((item) => `  - ${item}`) : ['  - (none)']),
		])
		.join('\n')
	const manifestSection = manifestPromptSection(reviewManifest(ctx))
	const preflightSection = verificationPreflightPromptSection(reviewVerificationPreflight(ctx))
	const scopeHeader = ctx.isAdhoc
		? `Ad-hoc plan: ${ctx.roadmapId}\n`
		: `Roadmap: ${ctx.roadmapId}\nMilestone: ${ctx.milestoneId}\n${ctx.changeRequestId ? `Change request: ${ctx.changeRequestId}\n` : ''}`
	return `You are reviewer for oh-my-roadmap wave ${ctx.activeWave.id}: ${ctx.activeWave.goal}.

${scopeHeader}Review checkpoint:
${ctx.activeWave.review_checkpoint}

Active wave exit criteria:
${ctx.activeWave.exit_criteria.map((item) => `- ${item}`).join('\n')}

Active tasks and done criteria:
${taskLines}

Milestone acceptance context (non-gating for this wave; final disposition is closeout)
${ctx.plan.acceptance_criteria.map((item) => `- ${item}`).join('\n')}

Remaining waves (informational future map; non-gating for this wave):
${JSON.stringify(remainingWaves)}

Seeded reviewer context (this compact JSON exactly matches result.seeded_context):
${JSON.stringify(seededContext)}
These seeded items were verified when this review package was assembled, but live repository code remains authoritative. Typed warnings name context omitted because it was stale, missing, mismatched, outside the repository, unavailable, or truncated. Use seeded_context.style_guidance as the complete style guidance for this review; an explicit "No recorded code-style guidance for these files." is authoritative and requires no separate style lookup.

Verification commands:
${ctx.plan.verification_commands.map((item) => `- ${item}`).join('\n')}

${manifestSection}

${preflightSection}

Workers self-verify before yielding: they always run LSP diagnostics on every file they touch, and — when their dispatch grants it (a single-worker wave, or a genuine rework) — also run their task's own verification commands against their OWNED files, recording exact command receipts (a "Commands run:" section and/or "VERIFIED:" lines) in their worker note. Verify those receipts rather than re-discovering or re-running everything from scratch; the review package carries worker_command_receipts (best-effort parses of what each worker reported running) as your starting point. Then, once for the whole wave, run the plan's milestone-level verification commands above yourself to confirm the assembled wave holds together — a concurrent sibling task may have been incomplete when any single worker finished, so this integration pass is still the first point where the whole wave is verified together.

Judge verification results RELATIVE TO the verification_baseline captured at implementation start: the bar is no new failures and no lost passes, not absolute full-suite success. Treat pre-existing baseline failures as informational. When rework_queue is present, confirm each pending item is resolved rather than re-reporting it as a new finding.

Judge this wave only against the active wave exit criteria and active task done criteria above. Milestone acceptance context and remaining_waves are informational during this review. Do not fail this wave solely because an item is owned by remaining_waves; final milestone acceptance disposition belongs to closeout.

Report passed or failed status with a summary and concrete findings for the orchestrator to record with omr_record_wave_review.`
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

		const contextSources = await loadWaveContextSources(cwd, ctx)
		const seededContext = sliceReviewerSeededContext(contextSources, ctx.activeTasks)
		const remainingWaves = remainingWaveContexts(ctx.plan, ctx.activeWave.id)

		if (ctx.activeWave.status !== 'reviewing') {
			await transition(cwd, { operation: 'update_wave_status', waveId: ctx.activeWave.id, waveStatus: 'reviewing' })
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
			...(ctx.changeRequestId ? { changeRequestId: ctx.changeRequestId } : {}),
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

		// Verification baseline (if captured at implementation start) rides along so the reviewer
		// can diff current verification results against it. Read from the active plan's progress —
		// which is milestone, change-request, or ad-hoc scoped via ctx.plan.
		const verificationBaseline = ctx.plan.progress.verification_baseline
		// Pending rework items for THIS wave: worker-fixable findings from an earlier review round
		// that a reviewer should confirm are resolved (rather than re-report).
		const pendingRework = (ctx.plan.progress.rework_queue ?? []).filter(
			(item) => item.wave_id === ctx.activeWave.id && item.status === 'pending',
		)
		// Best-effort receipts of the commands each worker reports having run, parsed from the
		// worker notes already fetched above (see parseWorkerCommandReceipts for the convention).
		const commandReceipts = parseWorkerCommandReceipts(workerNotes.results)

		// R24 wave diffs: whenever the cwd is a usable git repo, build an on-demand change package by
		// diffing the recorded start boundary (captured at fresh dispatch) against the current worktree,
		// scoped to the wave's owned pathspecs. Independent of the checkpoints flag and purely additive:
		// an unusable repo yields available:false with warnings, which is still informative.
		const waveChanges = await buildWaveChanges(
			cwd,
			(ctx.activeWave as WaveWithGit).git?.start?.start_head,
			ownedPathspecsForWave(ctx.activeTasks),
		)

		return {
			roadmap_id: ctx.roadmapId,
			milestone_id: ctx.milestoneId,
			...(ctx.changeRequestId ? { change_request_id: ctx.changeRequestId } : {}),
			wave_id: ctx.activeWave.id,
			reviewer: 'reviewer',
			re_review: reReview,
			...(reReview && priorReviewer ? { prior_reviewer_agent_id: priorReviewer.agent_id } : {}),
			...(reReview && priorFindings.length > 0 ? { prior_findings: priorFindings } : {}),
			prompt: reviewPrompt(ctx, seededContext, remainingWaves),
			seeded_context: seededContext,
			remaining_waves: remainingWaves,
			manifest: reviewManifest(ctx),
			verification_preflight: reviewVerificationPreflight(ctx),
			tasks: ctx.activeTasks.map((task) => ({
				task_id: task.id,
				title: task.title,
				worker: task.worker,
				owned_files: task.owned_files,
				owned_modules: task.owned_modules,
				shared_interfaces: task.shared_interfaces,
				done_criteria: task.done_criteria,
			})),
			worker_notes: workerNotes.results,
			...(verificationBaseline ? { verification_baseline: verificationBaseline } : {}),
			...(pendingRework.length > 0 ? { rework_queue: pendingRework } : {}),
			...(commandReceipts.length > 0 ? { worker_command_receipts: commandReceipts } : {}),
			wave_changes: waveChanges,
		}
	})
}

function normalizeReviewText(value: string): string {
	return value.trim().replace(/\s+/g, ' ')
}

// No rework-id helper exists in the store, so mirror roadmapBlockerId()'s `<prefix>_<uuid>` style.
function reworkQueueId(): string {
	return `rework_${randomUUID()}`
}

// Worker-fixable rework items require a task_id. Prefer the finding's own task_id; when absent,
// fall back to the wave's single active task, or (when the wave has several tasks) record the item
// as wave-scoped by stamping the wave id so the item still tracks to a concrete owner.
function reworkFallbackTaskId(ctx: ActivePlanContext): string {
	if (ctx.activeTasks.length === 1) return ctx.activeTasks[0]!.id
	return ctx.activeWave.id
}

// Worker command-receipt convention (documented, best-effort, defensive):
// Within a worker note body, commands the worker reports having run are listed either as
//   Commands run: <cmd>            (inline, single command after the colon), or
//   Commands run:                  (header line) followed by bullet lines `- <cmd>` / `* <cmd>`
//     - <cmd>
//     - <cmd>
// and/or as standalone `VERIFIED: <cmd>` lines anywhere in the body. A note with no such marker is
// omitted entirely. The Commands-run bullet block ends at the first non-bullet line.
function extractWorkerCommands(body: string): string[] {
	const commands: string[] = []
	let inCommandsBlock = false
	for (const raw of body.split(/\r?\n/)) {
		const line = raw.trim()
		const verified = /^VERIFIED:\s*(.+)$/i.exec(line)
		if (verified) {
			inCommandsBlock = false
			const cmd = verified[1]!.trim()
			if (cmd) commands.push(cmd)
			continue
		}
		const header = /^Commands run:\s*(.*)$/i.exec(line)
		if (header) {
			inCommandsBlock = true
			const inline = header[1]!.trim()
			if (inline) commands.push(inline)
			continue
		}
		if (inCommandsBlock) {
			const bullet = /^[-*]\s+(.+)$/.exec(line)
			if (bullet) {
				const cmd = bullet[1]!.trim()
				if (cmd) commands.push(cmd)
				continue
			}
			// Any non-bullet line (including a blank line) ends the Commands-run block.
			inCommandsBlock = false
		}
	}
	return commands
}

function parseWorkerCommandReceipts(
	notes: ContextEntryResult[],
): { task_id: string; agent_id?: string; commands: string[] }[] {
	const receipts: { task_id: string; agent_id?: string; commands: string[] }[] = []
	for (const note of notes) {
		const body = typeof note.body === 'string' ? note.body : ''
		if (!body) continue
		const commands = extractWorkerCommands(body)
		if (commands.length === 0) continue
		const taskId = typeof note.metadata.task_id === 'string' ? note.metadata.task_id : ''
		const agentId = typeof note.metadata.worker_id === 'string' ? note.metadata.worker_id : undefined
		receipts.push({ task_id: taskId, ...(agentId ? { agent_id: agentId } : {}), commands })
	}
	return receipts
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

// The blocking findings carried by THIS review, in order. Structured findings contribute their
// worker-fixable and needs-user texts; the legacy string path reuses reviewBlockingFindings.
function currentBlockingFindings(input: RecordWaveReviewInput): string[] {
	const structured = input.structured_findings
	if (structured !== undefined && structured.length > 0) {
		return structured
			.filter((finding) => finding.severity === 'blocking_worker_fixable' || finding.severity === 'blocking_needs_user')
			.map((finding) => finding.text)
	}
	return reviewBlockingFindings(input)
}

// R20 accumulated findings history for a capped wave: every prior worker-fixable finding still
// tracked in the rework queue for this wave, plus every prior needs-user finding recorded as a
// `Wave <id> review failed` blocker, plus the current review's blocking findings — normalized and
// de-duplicated while preserving first-seen order. This is what the needs-user cap blocker carries
// so the user sees the whole loop's history rather than only the final round.
function accumulatedFindingsHistory(
	ctx: ActivePlanContext,
	existingBlockers: RoadmapBlocker[],
	failedTitle: string,
	currentFindings: string[],
): string[] {
	const seen = new Set<string>()
	const history: string[] = []
	const push = (text: string): void => {
		const normalized = normalizeReviewText(text)
		if (normalized && !seen.has(normalized)) {
			seen.add(normalized)
			history.push(normalized)
		}
	}
	for (const item of ctx.plan.progress.rework_queue ?? []) {
		if (item.wave_id === ctx.activeWave.id) push(item.finding_text)
	}
	for (const blocker of existingBlockers) {
		if (normalizeReviewText(blocker.title) === normalizeReviewText(failedTitle)) push(blocker.description)
	}
	for (const finding of currentFindings) push(finding)
	return history
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
	| { kind: 'activate'; nextWave: WavePlan }
	| { kind: 'closeout' }
	| { kind: 'none' }

// Waves are ordered by their position in ctx.plan.waves, so the "next wave" is the first
// later wave (after the active wave's index) that is not yet complete.
function resolvePassedWaveAdvance(ctx: ActivePlanContext): PassedWaveAdvance {
	const activeWaveIndex = ctx.plan.waves.findIndex((wave) => wave.id === ctx.activeWave.id)
	if (activeWaveIndex < 0) return { kind: 'none' }
	const nextWave = ctx.plan.waves.slice(activeWaveIndex + 1).find((wave) => wave.status !== 'complete')
	if (nextWave) {
		// Only advance into a wave that has not started. If the next pending wave is already
		// running, reviewing, or blocked, its existing state stays authoritative.
		if (nextWave.status !== 'pending') return { kind: 'none' }
		return { kind: 'activate', nextWave }
	}
	return { kind: 'closeout' }
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
					progress: { activeWaveId: advance.nextWave.id, step: 'not_started', activeTaskIds: [] },
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
				progress: { step: 'closeout_ready', activeTaskIds: [] },
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
			progress: { activeWaveId: advance.nextWave.id, step: 'not_started', activeTaskIds: [] },
		})
		return 'not_started'
	}
	if (advance.kind === 'closeout') {
		await transition(cwd, {
			operation: 'update_implementation_progress',
			progress: { step: 'closeout_ready', activeTaskIds: [] },
		})
		return 'closeout_ready'
	}
	await setProgress(cwd, ctx, 'ready_for_next_wave', [])
	return 'ready_for_next_wave'
}

// Build the checkpoint commit input from the active plan context. Workflow + ids are sourced from
// ctx: a change request wins (workflow:'change-request' with roadmap/milestone/change-request ids);
// otherwise an ad-hoc plan (workflow:'adhoc' with its adhoc_id); otherwise a roadmap milestone
// (workflow:'roadmap' with roadmap/milestone ids). predirty rides from the recorded git.start so the
// commit can warn about pre-existing uncommitted changes it swept in.
function buildCheckpointInput(ctx: ActivePlanContext, ownedPathspecs: string[]): CommitWaveCheckpointInput {
	const predirty = (ctx.activeWave as WaveWithGit).git?.start?.predirty
	const common = {
		waveId: ctx.activeWave.id,
		waveGoal: ctx.activeWave.goal,
		taskIds: ctx.activeTasks.map((task) => task.id),
		ownedPathspecs,
		...(predirty && predirty.length > 0 ? { predirty } : {}),
	}
	if (ctx.changeRequestId) {
		return {
			...common,
			workflow: 'change-request',
			roadmapId: ctx.roadmapId,
			milestoneId: ctx.milestoneId,
			changeRequestId: ctx.changeRequestId,
		}
	}
	if (ctx.isAdhoc) {
		const adhocId = 'adhoc_id' in ctx.plan ? ctx.plan.adhoc_id : ctx.roadmapId
		return { ...common, workflow: 'adhoc', adhocId }
	}
	return { ...common, workflow: 'roadmap', roadmapId: ctx.roadmapId, milestoneId: ctx.milestoneId }
}

// Persist a checkpoint (or skipped record) onto the active wave's git.checkpoint. Mirrors the failed
// branch's rework persistence: reload, set the field on the reloaded wave (git.start is preserved via
// the round-tripped wave.git), and write runtime carrying the current progress forward. Ordered so a
// crash after the commit but before completion leaves the checkpoint persisted and the wave still
// reviewing — a re-run re-commits idempotently (HEAD trailer) and then completes.
async function persistWaveCheckpoint(
	cwd: string,
	input: RecordWaveReviewInput,
	checkpoint: WaveCheckpoint,
): Promise<void> {
	const reloaded = await activePlanContext(cwd, input)
	const wave = reloaded.plan.waves.find((candidate) => candidate.id === reloaded.activeWave.id) as
		| WaveWithGit
		| undefined
	if (!wave) return
	wave.git = { ...(wave.git ?? {}), checkpoint }
	await writePlanRuntime(cwd, reloaded.plan)
}

// Passed-wave checkpoint (F1). Runs AFTER the no-blocking-blockers assertion and BEFORE the wave is
// marked complete, so a failing hook / commit error propagates and leaves the wave reviewing rather
// than completed-but-uncommitted. Returns undefined when checkpoints are disabled (no checkpoint
// field on the result). Unusable git (no repo / detached HEAD) records a skipped checkpoint and never
// blocks completion. THROWS from commitWaveCheckpoint are intentionally not caught.
async function checkpointPassedWave(
	cwd: string,
	input: RecordWaveReviewInput,
	ctx: ActivePlanContext,
): Promise<{ status: WaveCheckpoint['status']; commit?: string; warnings: string[] } | undefined> {
	if (!(await loadProjectGitCheckpoints(cwd))) return undefined

	const ownedPathspecs = ownedPathspecsForWave(ctx.activeTasks)
	const boundary = await resolveGitBoundary(cwd)
	if (!boundary.available || boundary.detached) {
		const reason = boundary.available ? 'detached HEAD' : `git unavailable: ${boundary.reason ?? 'not a git work tree'}`
		const warning = `Wave ${ctx.activeWave.id} checkpoint skipped: ${reason}`
		await persistWaveCheckpoint(cwd, input, { status: 'skipped', reason, warnings: [warning], at: nowIso() })
		return { status: 'skipped', warnings: [warning] }
	}

	const checkpoint = await commitWaveCheckpoint(cwd, buildCheckpointInput(ctx, ownedPathspecs))
	await persistWaveCheckpoint(cwd, input, checkpoint)
	return {
		status: checkpoint.status,
		...(checkpoint.commit ? { commit: checkpoint.commit } : {}),
		warnings: checkpoint.warnings,
	}
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
		metadata: { status: input.status },
	}, async () => {
		const ctx = await activePlanContext(cwd, input)
		const incomplete = ctx.activeTasks.filter((task) => task.status !== 'done')
		if (incomplete.length > 0) {
			throw new Error(`Active wave ${ctx.activeWave.id} still has incomplete tasks: ${incomplete.map((task) => task.id).join(', ')}`)
		}

		if (input.status === 'passed') {
			await assertNoOpenBlockingBlockers(cwd, ctx)
			// F1 checkpoint runs here — after the blocking-blocker gate, before the complete
			// transition — so a commit failure (e.g. a failing pre-commit hook) propagates and the
			// wave stays reviewing rather than completing without a commit. Disabled -> undefined.
			const checkpoint = await checkpointPassedWave(cwd, input, ctx)
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
				...(nextActions ? { next_actions: nextActions } : {}),
				...(checkpoint ? { checkpoint } : {}),
			}
		}

		const existingBlockers = await listBlockers(cwd, {
			roadmapId: ctx.roadmapId,
			milestoneId: ctx.milestoneId,
			...(ctx.changeRequestId ? { changeRequestId: ctx.changeRequestId } : {}),
			waveId: ctx.activeWave.id,
		})
		const title = `Wave ${ctx.activeWave.id} review failed`

		// Structured findings (R1 severity routing): route each finding by severity.
		//   pass / advisory           -> dropped (no blocker, no rework)
		//   blocking_needs_user       -> canonical blocking blocker (deduped like the string path)
		//   blocking_worker_fixable   -> rework-queue item (NOT a blocker), dispatchable back to a worker
		// When absent, the legacy string-based reviewBlockingFindings behavior is preserved verbatim.
		const structured = input.structured_findings
		const useStructured = structured !== undefined && structured.length > 0

		// R20 core-enforced fix->re-review loop cap. Count how many review cycles this wave has
		// already run from the per-wave reviewer_runs history — one reviewer dispatch is recorded
		// per cycle by recordReviewerDispatch (see the reviewer rework rule) — flooring at 1 so the
		// in-flight failed review always counts. When the count reaches max_review_cycles we stop
		// routing findings back into rework and instead auto-mint a single needs-user blocker
		// carrying the accumulated findings history, so an unbounded fix->re-review loop can never
		// spin forever without a user decision. Below the cap, routing is unchanged.
		const maxReviewCycles = (await loadMergedConfig(cwd)).orchestration.max_review_cycles ?? DEFAULT_MAX_REVIEW_CYCLES
		const reviewCycles = Math.max(
			ctx.plan.progress.reviewer_runs.filter((run) => run.wave_id === ctx.activeWave.id).length,
			1,
		)
		const capReached = reviewCycles >= maxReviewCycles

		const blockers: RoadmapBlocker[] = []
		const reworkItems: ReworkQueueItem[] = []
		let cappedNeedsUser = false

		if (capReached) {
			// Cap hit: refuse further rework. Mint (or reuse) one canonical needs-user blocker via the
			// same R1 openBlocker/sameReviewBlocker machinery the blocking_needs_user path uses, whose
			// description carries the whole loop's findings history. Attributed to 'orchestrator' — this
			// is a core-enforced halt, not the reviewer's own classification, and never falsely 'user'.
			cappedNeedsUser = true
			const history = accumulatedFindingsHistory(ctx, existingBlockers.blockers, title, currentBlockingFindings(input))
			const description = [
				`Wave ${ctx.activeWave.id} reached the configured review-cycle cap of ${maxReviewCycles} failed review(s) without a clean pass.`,
				'Automated fix and re-review is halted; this needs a user decision on how to proceed.',
				`Accumulated review findings across all ${reviewCycles} cycle(s):`,
				...(history.length > 0 ? history.map((finding) => `- ${finding}`) : ['- (no specific findings were recorded)']),
			].join('\n')
			const existing = existingBlockers.blockers.find((blocker) => sameReviewBlocker(blocker, ctx, title, description))
			if (existing) {
				blockers.push(existing)
			} else {
				blockers.push(await openBlocker(cwd, {
					roadmapId: ctx.roadmapId,
					milestoneId: ctx.milestoneId,
					...(ctx.changeRequestId ? { changeRequestId: ctx.changeRequestId } : {}),
					waveId: ctx.activeWave.id,
					severity: 'blocking',
					title,
					description,
					createdBy: 'orchestrator',
				}))
			}
		} else if (useStructured) {
			for (const finding of structured) {
				if (finding.severity === 'blocking_needs_user') {
					const description = normalizeReviewText(finding.text)
					if (!description) continue
					const existing = existingBlockers.blockers.find((blocker) => sameReviewBlocker(blocker, ctx, title, description))
					if (existing) {
						blockers.push(existing)
						continue
					}
					blockers.push(await openBlocker(cwd, {
						roadmapId: ctx.roadmapId,
						milestoneId: ctx.milestoneId,
						...(ctx.changeRequestId ? { changeRequestId: ctx.changeRequestId } : {}),
						waveId: ctx.activeWave.id,
						...(finding.task_id ? { taskId: finding.task_id } : {}),
						severity: 'blocking',
						title,
						description,
						createdBy: 'reviewer',
					}))
					continue
				}
				if (finding.severity === 'blocking_worker_fixable') {
					reworkItems.push({
						id: reworkQueueId(),
						task_id: finding.task_id ?? reworkFallbackTaskId(ctx),
						wave_id: ctx.activeWave.id,
						finding_text: finding.text,
						source_finding_severity: finding.severity,
						status: 'pending',
						created_at: nowIso(),
						created_by: 'reviewer',
					})
				}
				// pass / advisory: intentionally dropped.
			}
		} else {
			for (const finding of reviewBlockingFindings(input)) {
				const existing = existingBlockers.blockers.find((blocker) => sameReviewBlocker(blocker, ctx, title, finding))
				if (existing) {
					blockers.push(existing)
					continue
				}
				blockers.push(await openBlocker(cwd, {
					roadmapId: ctx.roadmapId,
					milestoneId: ctx.milestoneId,
					...(ctx.changeRequestId ? { changeRequestId: ctx.changeRequestId } : {}),
					waveId: ctx.activeWave.id,
					severity: 'blocking',
					title,
					description: finding,
					createdBy: 'reviewer',
				}))
			}
		}

		// A failed review never advances the wave: even a failure whose structured findings are all
		// pass/advisory (nothing actionable) leaves the wave blocked with a clear reason rather than
		// silently passing. This mirrors the needs-user / rework case, which also blocks.
		await transition(cwd, {
			operation: 'update_wave_status',
			waveId: ctx.activeWave.id,
			waveStatus: 'blocked',
		})
		await setProgress(cwd, ctx, 'resolving_blockers', [], input.summary)

		// Persist rework items durably. setProgress routes through update_implementation_progress,
		// which reconstructs progress and does not carry rework_queue, so append the items with a
		// direct runtime write (mirroring recordVerificationBaseline). Carry any pre-existing queue
		// forward from the pre-transition snapshot, and preserve a captured verification_baseline
		// that the progress-update write would otherwise drop.
		if (reworkItems.length > 0) {
			const reloaded = await activePlanContext(cwd, input)
			const existingQueue = ctx.plan.progress.rework_queue ?? []
			const carriedBaseline = ctx.plan.progress.verification_baseline
			await writePlanRuntime(cwd, {
				...reloaded.plan,
				progress: {
					...reloaded.plan.progress,
					...(carriedBaseline ? { verification_baseline: carriedBaseline } : {}),
					rework_queue: [...existingQueue, ...reworkItems],
					updated_at: nowIso(),
				},
			})
		}

		// When the review-cycle cap forced a needs-user blocker, surface the halt in next_actions so
		// the orchestrator routes the accumulated findings to the user instead of looping again.
		const nextActions: NextActionHint[] | undefined = cappedNeedsUser
			? [{
				label: 'Resolve the review-cycle-cap blocker',
				tool: {
					name: 'omr_list_blockers',
					input: { status: 'open', waveId: ctx.activeWave.id },
				},
				why: `Wave ${ctx.activeWave.id} reached the review-cycle cap of ${maxReviewCycles}; automated rework is halted and the accumulated findings need a user decision.`,
			}]
			: undefined

		return {
			wave_id: ctx.activeWave.id,
			wave_status: 'blocked',
			progress_step: 'resolving_blockers',
			blockers,
			...(nextActions ? { next_actions: nextActions } : {}),
		}
	})
}
