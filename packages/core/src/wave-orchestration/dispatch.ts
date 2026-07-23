import { consumeOneShot, hasAvailableOneShot } from '../budget'
import type { BudgetDimension } from '../budget'
import { withDiagnosticTiming } from '../diagnostics'
import { startTimeClock, pauseTimeClock, resumeTimeClock } from '../elapsed-time'
import { evaluateBudgetEnforcement, formatBudgetBlockReason } from '../enforcement'
import type { BudgetScope, EnforcementState } from '../enforcement'
import {
	loadMilestoneBudgetState,
	loadRoadmapBudgetState,
	nowIso,
	transition,
	writeMilestoneBudgetState,
	writeRoadmapBudgetState,
} from '../store/index'
import type { ImplementationProgressStep, TaskPlan, WaveGitState, WavePlan, WorkerRun } from '../types'
import { loadProjectGitCheckpoints } from '../project-init'
import {
	activePlanContext,
	type ActivePlanContext,
	activeWorkerRuns,
	assertDependenciesComplete,
	assertDispatchableWave,
	assertImplementationReady,
	assertTaskDispatchFields,
	writePlanRuntime,
} from './context'
import { captureWaveGitStart, resolveGitBoundary } from './git'
import { loadWaveContextSources, sliceTaskSeededContext } from './context-seeding'
import type {
	PlanDerivedManifest,
	PrepareWaveDispatchResult,
	PrepareWorkerRedispatchInput,
	PrepareWorkerRedispatchResult,
	SeededContext,
	VerificationPreflightHint,
	WaveOrchestrationTargetInput,
	WaveWorkerAssignment,
} from './types'
import { replaceWorkerRun, requireTaskInActiveWave, writeProgressWithRuns } from './worker-runs'

// git is a runtime-only projection carried on WaveRuntime (see types.ts / format.ts round-trip);
// the WavePlan type intentionally does not declare it, so every access goes through this cast.
// Confining the cast to a single alias keeps the runtime-vs-definition split explicit.
export type WaveWithGit = WavePlan & { git?: WaveGitState };

// Owned pathspecs for a wave: the deduped union of every task's owned_files and owned_modules
// across the wave's tasks. Used to scope Git start capture, diffs, and checkpoint staging.
export function ownedPathspecsForWave(tasks: TaskPlan[]): string[] {
	const seen = new Set<string>()
	for (const task of tasks) {
		for (const owner of [...task.owned_files, ...task.owned_modules]) seen.add(owner)
	}
	return [...seen]
}

// Build the dispatch result's wave_git summary. available reflects whether the cwd is a usable
// git repo (equivalently: whether captureWaveGitStart would return a boundary rather than null);
// warnings name the reason when it is not. The checkpoints flag gates only the commit, not diffs.
async function waveGitDispatchField(
	cwd: string,
	waveId: string,
): Promise<{ available: boolean; checkpoints_enabled: boolean; warnings: string[] }> {
	const boundary = await resolveGitBoundary(cwd)
	const checkpoints_enabled = await loadProjectGitCheckpoints(cwd)
	if (boundary.available) return { available: true, checkpoints_enabled, warnings: [] }
	return {
		available: false,
		checkpoints_enabled,
		warnings: [`Wave ${waveId} Git boundary unavailable: ${boundary.reason ?? 'not a git work tree'}`],
	}
}

export function notesText(notes: string[] | undefined): string {
	return notes && notes.length > 0 ? notes.join('\n') : ''
}

export interface WorkerContinuation {
	priorAgentId: string;
	transportFailures: number;
	lastError?: string;
}

function continuationSection(continuation: WorkerContinuation): string {
	return `

CONTINUATION CONTEXT:
- You are replacing a prior worker (${continuation.priorAgentId}) that hit ${continuation.transportFailures} transport failure(s)${continuation.lastError ? ` (last error: ${continuation.lastError})` : ''} and could not recover in place.
- Read history://${continuation.priorAgentId} FIRST. If the prior attempt had already started editing, its edits are on the active branch (workers run on the active branch with no worktree); if it had not started editing, that transcript is your read/exploration head-start so you need not re-discover the codebase from scratch.
- Do not assume disk edits exist. Inspect the current file state (git status/diff, read your owned files) before editing; do not redo completed work; continue from the last incomplete step.
- The prior owner ${continuation.priorAgentId} may still be live. Before editing any owned file, confirm via hub op:list / op:send that the prior peer is stopped — do not rely on roadmap state saying "abandoned" (state can report abandoned while the peer is demonstrably still editing).`
}

function reservedSiblingScope(ctx: ActivePlanContext, task: TaskPlan): string[] {
	const reserved = new Set<string>()
	for (const sibling of ctx.activeTasks) {
		if (sibling.id === task.id) continue
		for (const owner of [...sibling.owned_files, ...sibling.owned_modules]) reserved.add(owner)
	}
	return [...reserved]
}

// CLIs whose availability we must not assume; commands starting with one of these get a warning.
const CLI_ASSUMPTION_TOOLS = new Set<string>([
	'psql',
	'mysql',
	'redis-cli',
	'docker',
	'kubectl',
	'aws',
	'gcloud',
	'az',
	'curl',
])

const VERIFICATION_PREFLIGHT_GUIDANCE =
	'Run assigned verification when practical. If a verification command depends on an unavailable external CLI or service, stop and append a blocking note with the missing prerequisite instead of inventing a substitute.'

export interface WorkerVerificationPermissionInput {
	// True when the active wave being dispatched has exactly one task in flight, i.e. no
	// concurrent sibling worker can collide with a build/test run.
	singleWorker: boolean;
	// True when this dispatch is a rework redispatch (a transport/abandon continuation via
	// prepareWorkerRedispatch, or an explicit rework_of marker): review has already run for
	// the wave, so any remaining siblings are complete by definition.
	isRework: boolean;
}

// Computes the worker-facing verification guidance for a dispatch. LSP diagnostics are always
// mandatory; running the task's own verification_commands against OWNED files is additionally
// permitted when there is no concurrent sibling risk (single-task wave) or when this dispatch is
// a rework (siblings are, by definition, already complete because review has already run).
export function WORKER_VERIFICATION_GUIDANCE(permission: WorkerVerificationPermissionInput): string[] {
	const ownedTestsPermitted = permission.singleWorker || permission.isRework
	const lines = [
		'Mandatory, in every dispatch: run LSP diagnostics (e.g. xd://lsp) on every file you touch before you yield.',
	]
	if (ownedTestsPermitted) {
		lines.push(
			"You MAY run your task's own verification_commands against your OWNED files (e.g. `bun test <your owned test file>`); do NOT run the full test suite, a whole-project build, or any command touching files you do not own.",
			permission.singleWorker
				? 'This wave has exactly one task in flight, so there is no concurrent sibling to collide with.'
				: 'This is a rework dispatch: review has already run for this wave, so any remaining siblings are complete by definition.',
		)
	} else {
		lines.push(
			'Do NOT run builds, compilers, test suites, or these verification commands, and do not write throwaway scripts that build or execute the code. Concurrent sibling tasks in THIS wave may still be incomplete, so a build or test can fail for reasons entirely outside your task.',
			'The wave reviewer owns all build and test execution and runs it after every task in the wave is done.',
		)
	}
	lines.push(
		'Record in your worker note the exact commands you ran and their results (command receipts), the verification the reviewer should still run, and anything you could not confirm by reading code.',
		'If a verification command depends on an unavailable external CLI or service, still stop and append a blocking note with the missing prerequisite instead of inventing a substitute.',
	)
	return lines
}

export function manifestForTask(ctx: ActivePlanContext, task: TaskPlan): PlanDerivedManifest {
	return {
		owned_files: task.owned_files,
		owned_modules: task.owned_modules,
		shared_interfaces: task.shared_interfaces,
		dependencies: task.depends_on,
		reserved_sibling_scope: reservedSiblingScope(ctx, task),
		relevant_existing_code: ctx.plan.relevant_existing_code,
		relevant_documentation: ctx.plan.relevant_documentation,
	}
}

export function verificationPreflightFor(commands: string[]): VerificationPreflightHint {
	const cliAssumptionWarnings: string[] = []
	const seen = new Set<string>()
	for (const command of commands) {
		const firstToken = command.trim().split(/\s+/)[0]
		if (firstToken && CLI_ASSUMPTION_TOOLS.has(firstToken) && !seen.has(firstToken)) {
			seen.add(firstToken)
			cliAssumptionWarnings.push(
				`Do not assume ${firstToken} is installed; prefer repo-native helpers or configured MCP/tools unless the plan explicitly requires this CLI.`,
			)
		}
	}
	return {
		commands,
		cli_assumption_warnings: cliAssumptionWarnings,
		guidance: [VERIFICATION_PREFLIGHT_GUIDANCE],
	}
}

function listOrNone(items: string[]): string {
	return items.length > 0 ? items.join(', ') : '(none)'
}

export function manifestPromptSection(manifest: PlanDerivedManifest): string {
	return `Plan-derived manifest:
- Owned files: ${listOrNone(manifest.owned_files)}
- Owned modules: ${listOrNone(manifest.owned_modules)}
- Shared interfaces: ${listOrNone(manifest.shared_interfaces)}
- Dependencies: ${listOrNone(manifest.dependencies)}
- Reserved sibling scope: ${listOrNone(manifest.reserved_sibling_scope)}
- Relevant existing code: ${listOrNone(manifest.relevant_existing_code)}
- Relevant documentation: ${listOrNone(manifest.relevant_documentation)}
This manifest is plan-derived and is NOT proof that any listed path exists. If a path is not in this manifest or prior tool output, use glob or omr_search_context to locate it before you read it.`
}

export function verificationPreflightPromptSection(preflight: VerificationPreflightHint): string {
	const warnings = preflight.cli_assumption_warnings.length > 0
		? preflight.cli_assumption_warnings.map((item) => `- ${item}`).join('\n')
		: '- (none)'
	return `Verification preflight:
Commands:
${preflight.commands.length > 0 ? preflight.commands.map((item) => `- ${item}`).join('\n') : '- (none)'}
CLI assumption warnings:
${warnings}
Guidance:
${preflight.guidance.map((item) => `- ${item}`).join('\n')}
If an external CLI warning appears above, do not shell out to that CLI unless the plan explicitly requires it or a repo-native helper is unavailable and the CLI is confirmed to exist.`
}

// Worker-facing preflight: workers must NOT build or test. A concurrent sibling task in the
// same wave may be incomplete, so a build/test could fail for reasons outside this task; the
// reviewer runs the wave's build and verification after every task is done.
export function workerVerificationPreflightPromptSection(
	preflight: VerificationPreflightHint,
	permission: WorkerVerificationPermissionInput,
): string {
	const warnings = preflight.cli_assumption_warnings.length > 0
		? preflight.cli_assumption_warnings.map((item) => `- ${item}`).join('\n')
		: '- (none)'
	const commandsHeader = permission.singleWorker || permission.isRework
		? 'Commands (LSP diagnostics are mandatory; owned-file verification_commands are permitted per the guidance below):'
		: 'Commands the reviewer will run after this wave (do NOT run them yourself; LSP diagnostics are still mandatory):'
	return `Verification preflight:
${commandsHeader}
${preflight.commands.length > 0 ? preflight.commands.map((item) => `- ${item}`).join('\n') : '- (none)'}
CLI assumption warnings:
${warnings}
Guidance:
${WORKER_VERIFICATION_GUIDANCE(permission).map((item) => `- ${item}`).join('\n')}`
}

export function seededContextPromptSection(seededContext: SeededContext): string {
	return `Seeded context (this compact JSON exactly matches assignment.seeded_context):
${JSON.stringify(seededContext)}
The seeded items above were verified when this assignment was assembled, but live repository code remains authoritative. Typed warnings name context items omitted because they were stale, missing, mismatched, outside the repository, unavailable, or truncated. Use seeded_context.style_guidance as the complete style guidance for this assignment; an explicit "No recorded code-style guidance for these files." is authoritative and requires no separate style lookup.`
}

function workerPrompt(
	ctx: ActivePlanContext,
	task: TaskPlan,
	seededContext: SeededContext,
	permission: WorkerVerificationPermissionInput,
	continuation?: WorkerContinuation,
): string {
	const reserved = reservedSiblingScope(ctx, task)
	const manifestSection = manifestPromptSection(manifestForTask(ctx, task))
	const seededContextSection = seededContextPromptSection(seededContext)
	const preflightSection = workerVerificationPreflightPromptSection(
		verificationPreflightFor(task.verification_commands),
		permission,
	)
	const ownedTestsPermitted = permission.singleWorker || permission.isRework
	const verificationCommandsHeader = ownedTestsPermitted
		? 'Verification commands (you MAY run these restricted to your OWNED files — see the verification preflight below for the exact permission and mandatory LSP step):'
		: 'Verification commands (the reviewer runs these after the wave — you do not run builds or tests; LSP diagnostics on touched files are still mandatory — see the verification preflight below):'
	const scopeHeader = ctx.isAdhoc
		? `Ad-hoc plan: ${ctx.roadmapId}\n`
		: `Roadmap: ${ctx.roadmapId}\nMilestone: ${ctx.milestoneId}\n${ctx.changeRequestId ? `Change request: ${ctx.changeRequestId}\n` : ''}`
	const base = `You are ${task.worker} for oh-my-roadmap task ${task.id}: ${task.title}.

${scopeHeader}Wave: ${ctx.activeWave.id} - ${ctx.activeWave.goal}

Objective:
${task.objective}

Implementation notes:
${task.implementation_notes.map((item) => `- ${item}`).join('\n')}

Done criteria:
${task.done_criteria.map((item) => `- ${item}`).join('\n')}

${verificationCommandsHeader}
${task.verification_commands.map((item) => `- ${item}`).join('\n')}

Ownership:
- Owned files: ${task.owned_files.length > 0 ? task.owned_files.join(', ') : '(none)'}
- Owned modules: ${task.owned_modules.length > 0 ? task.owned_modules.join(', ') : '(none)'}
- Shared interfaces: ${task.shared_interfaces.length > 0 ? task.shared_interfaces.join(', ') : '(none)'}
- Dependencies: ${task.depends_on.length > 0 ? task.depends_on.join(', ') : '(none)'}

Reserved by concurrent sibling tasks in THIS wave (do not edit): ${reserved.length > 0 ? reserved.join(', ') : '(none)'}

${manifestSection}

${seededContextSection}

Before your first edit, call omr_task_briefing ONCE with your owned files and dependencies (see Ownership below) instead of many exploratory reads — it returns file sizes, head excerpts, and a one-hop import graph in a single call.

${preflightSection}

You own the files and modules listed above. You may also edit files owned by OTHER waves if your task genuinely requires it — waves run strictly sequentially, so those waves are already complete or have not yet started and no concurrent worker holds their files. Do NOT edit the files/modules reserved by concurrent sibling tasks in THIS wave; those workers are running now and editing them would collide. ${ownedTestsPermitted ? 'You MAY run your task\'s own verification_commands against your OWNED files (see the verification preflight above); do NOT run the full test suite, a whole-project build, or touch unowned files.' : 'Do NOT run builds, compilers, or tests — the wave reviewer owns build and test execution and runs it once the whole wave is complete.'} Run LSP diagnostics on every file you touch before yielding. In your final worker note, include the exact commands you ran (if any), exit codes, and a brief result summary so the reviewer can verify your receipts. Append a concise worker note with files changed, verification performed, and any remaining risks. Then call omr_record_wave_result for this task with status completed or blocked.`
	return continuation ? `${base}${continuationSection(continuation)}` : base
}

interface AssignmentInput {
	task: TaskPlan;
	permission: WorkerVerificationPermissionInput;
	continuation?: WorkerContinuation;
}

async function assignments(
	cwd: string,
	ctx: ActivePlanContext,
	inputs: AssignmentInput[],
): Promise<WaveWorkerAssignment[]> {
	const sources = await loadWaveContextSources(cwd, ctx)
	return inputs.map(({ task, permission, continuation }) => {
		const seededContext = sliceTaskSeededContext(sources, task)
		return {
			task_id: task.id,
			title: task.title,
			worker: task.worker,
			owned_files: task.owned_files,
			owned_modules: task.owned_modules,
			shared_interfaces: task.shared_interfaces,
			dependencies: task.depends_on,
			seeded_context: seededContext,
			manifest: manifestForTask(ctx, task),
			verification_preflight: verificationPreflightFor(task.verification_commands),
			prompt: workerPrompt(ctx, task, seededContext, permission, continuation),
		}
	})
}

export async function setProgress(
	cwd: string,
	ctx: ActivePlanContext,
	step: ImplementationProgressStep,
	activeTaskIds: string[],
	blockedReason?: string,
): Promise<void> {
	await transition(cwd, {
		operation: 'update_implementation_progress',
		progress: {
			activeWaveId: ctx.activeWave.id,
			step,
			activeTaskIds,
			...(blockedReason ? { blockedReason } : {}),
		},
	})
}

// --- Budget enforcement dispatch gate ---

interface BudgetDispatchGate {
	enforcement: EnforcementState
	mustConsumeOneShot: boolean
}

const BUDGET_BLOCK_PREFIX = 'Budget '

// Find the first scope + dimension at the given breach level for block-reason formatting.
function budgetBlockDetails(
	enforcement: EnforcementState,
	level: 'soft' | 'hard',
): { scope: BudgetScope; dimension: BudgetDimension; spent: number; ceiling: number; percentage: number } {
	for (const s of enforcement.scopes) {
		if (!(level === 'hard' ? s.hardBreached : s.softBreached)) continue
		for (const dim of ['tokens', 'cost', 'time'] as BudgetDimension[]) {
			if (s.levels[dim] === level) {
				const consumption = s.consumption.find((c) => c.dimension === dim)
				if (consumption) {
					return {
						scope: s.scope,
						dimension: dim,
						spent: consumption.spent,
						ceiling: consumption.ceiling ?? 0,
						percentage: consumption.percentage ?? 0,
					}
				}
			}
		}
	}
	throw new Error(`Budget ${level} breach reported but no breached dimension found`)
}

async function pauseBudgetTimeClocks(cwd: string, ctx: ActivePlanContext): Promise<void> {
	const now = nowIso()
	const roadmapBudget = await loadRoadmapBudgetState(cwd, ctx.roadmapId)
	if (roadmapBudget) {
		await writeRoadmapBudgetState(cwd, ctx.roadmapId, {
			...roadmapBudget,
			time_tracking: pauseTimeClock(roadmapBudget.time_tracking, now),
		})
	}
	if (ctx.milestoneId) {
		const milestoneBudget = await loadMilestoneBudgetState(cwd, ctx.roadmapId, ctx.milestoneId)
		if (milestoneBudget) {
			await writeMilestoneBudgetState(cwd, ctx.roadmapId, ctx.milestoneId, {
				...milestoneBudget,
				time_tracking: pauseTimeClock(milestoneBudget.time_tracking, now),
			})
		}
	}
}

async function resumeBudgetTimeClocks(cwd: string, ctx: ActivePlanContext): Promise<void> {
	const now = nowIso()
	const roadmapBudget = await loadRoadmapBudgetState(cwd, ctx.roadmapId)
	if (roadmapBudget) {
		await writeRoadmapBudgetState(cwd, ctx.roadmapId, {
			...roadmapBudget,
			time_tracking: resumeTimeClock(roadmapBudget.time_tracking, now),
		})
	}
	if (ctx.milestoneId) {
		const milestoneBudget = await loadMilestoneBudgetState(cwd, ctx.roadmapId, ctx.milestoneId)
		if (milestoneBudget) {
			await writeMilestoneBudgetState(cwd, ctx.roadmapId, ctx.milestoneId, {
				...milestoneBudget,
				time_tracking: resumeTimeClock(milestoneBudget.time_tracking, now),
			})
		}
	}
}

async function startBudgetTimeClocks(cwd: string, ctx: ActivePlanContext): Promise<void> {
	const now = nowIso()
	const roadmapBudget = await loadRoadmapBudgetState(cwd, ctx.roadmapId)
	if (roadmapBudget) {
		await writeRoadmapBudgetState(cwd, ctx.roadmapId, {
			...roadmapBudget,
			time_tracking: startTimeClock(roadmapBudget.time_tracking, now),
		})
	}
	if (ctx.milestoneId) {
		const milestoneBudget = await loadMilestoneBudgetState(cwd, ctx.roadmapId, ctx.milestoneId)
		if (milestoneBudget) {
			await writeMilestoneBudgetState(cwd, ctx.roadmapId, ctx.milestoneId, {
				...milestoneBudget,
				time_tracking: startTimeClock(milestoneBudget.time_tracking, now),
			})
		}
	}
}

// Consume a one-shot from each hard-breached scope that has one available.
async function consumeBudgetOneShot(cwd: string, ctx: ActivePlanContext, enforcement: EnforcementState): Promise<void> {
	for (const scope of enforcement.scopes) {
		if (!scope.hardBreached || !scope.hasAvailableOneShot) continue
		if (scope.scope === 'roadmap') {
			const budget = await loadRoadmapBudgetState(cwd, ctx.roadmapId)
			if (budget && hasAvailableOneShot(budget)) {
				await writeRoadmapBudgetState(cwd, ctx.roadmapId, consumeOneShot(budget))
			}
		} else if (ctx.milestoneId) {
			const budget = await loadMilestoneBudgetState(cwd, ctx.roadmapId, ctx.milestoneId)
			if (budget && hasAvailableOneShot(budget)) {
				await writeMilestoneBudgetState(cwd, ctx.roadmapId, ctx.milestoneId, consumeOneShot(budget))
			}
		}
	}
}

// Budget enforcement gate for wave dispatch: evaluates thresholds, handles
// resume/clear from a prior soft-pause, pauses on soft breach, throws a
// backstop on hard breach, and signals one-shot consumption when a hard
// breach is resolvable. Returns a no-op gate when no budgets are configured.
async function checkBudgetEnforcementForDispatch(
	cwd: string,
	ctx: ActivePlanContext,
): Promise<BudgetDispatchGate> {
	const enforcement = await evaluateBudgetEnforcement(cwd)
	if (enforcement.scopes.length === 0) {
		return { enforcement, mustConsumeOneShot: false }
	}

	const step = ctx.plan.progress.step
	const blockedReason = ctx.plan.progress.blocked_reason ?? ''

	// If the wave is resolving blockers for a non-budget reason, skip —
	// assertDispatchableWave (called by the caller) handles the refusal.
	if (step === 'resolving_blockers' && !blockedReason.startsWith(BUDGET_BLOCK_PREFIX)) {
		return { enforcement, mustConsumeOneShot: false }
	}

	const softResolvable = enforcement.scopes.some((s) => s.softBreached && s.hasAvailableOneShot)
	const hardResolvable = enforcement.scopes.some((s) => s.hardBreached && s.hasAvailableOneShot)

	// Resume/clear: previously paused on a budget soft limit, now the breach
	// is gone (ceiling raised) or a one-shot is available.
	if (step === 'resolving_blockers' && blockedReason.startsWith(BUDGET_BLOCK_PREFIX)) {
		const softCleared = !enforcement.softBreached
		if (softCleared || softResolvable || hardResolvable) {
			await resumeBudgetTimeClocks(cwd, ctx)
			const activeRuns = activeWorkerRuns(ctx.plan).filter((r) => r.wave_id === ctx.activeWave.id)
			const targetStep: ImplementationProgressStep = activeRuns.length > 0 ? 'workers_running' : 'dispatching'
			const targetTaskIds = activeRuns.length > 0
				? activeRuns.map((r) => r.task_id)
				: ctx.activeTasks.filter((t) => t.status !== 'done').map((t) => t.id)
			await setProgress(cwd, ctx, targetStep, targetTaskIds)
			// Keep the in-memory ctx consistent for the caller's assertions.
			ctx.plan.progress.step = targetStep
		} else {
			throw new Error(
				`Active wave ${ctx.activeWave.id} is paused on budget limit: ${blockedReason}`,
			)
		}
	}

	// Hard breach backstop.
	if (enforcement.hardBreached) {
		if (hardResolvable) {
			return { enforcement, mustConsumeOneShot: true }
		}
		const d = budgetBlockDetails(enforcement, 'hard')
		throw new Error(formatBudgetBlockReason('hard', d.scope, d.dimension, d.spent, d.ceiling, d.percentage))
	}

	// Soft breach pause (not resolvable by a one-shot).
	if (enforcement.softBreached && !softResolvable) {
		const d = budgetBlockDetails(enforcement, 'soft')
		const reason = formatBudgetBlockReason('soft', d.scope, d.dimension, d.spent, d.ceiling, d.percentage)
		await pauseBudgetTimeClocks(cwd, ctx)
		await setProgress(cwd, ctx, 'resolving_blockers', ctx.plan.progress.active_task_ids, reason)
		throw new Error(reason)
	}

	return { enforcement, mustConsumeOneShot: false }
}

export async function prepareWaveDispatch(
	cwd: string,
	input: WaveOrchestrationTargetInput = {},
): Promise<PrepareWaveDispatchResult> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'wave.prepareWaveDispatch',
		cwd,
		slowMs: 250,
	}, async () => {
		await assertImplementationReady(cwd)
		const ctx = await activePlanContext(cwd, input)
		const budgetGate = await checkBudgetEnforcementForDispatch(cwd, ctx)
		assertDispatchableWave(ctx)

		const incompleteTasks = ctx.activeTasks.filter((task) => task.status !== 'done')
		if (incompleteTasks.length === 0) {
			throw new Error(`Active wave ${ctx.activeWave.id} has no incomplete tasks to dispatch`)
		}
		for (const task of incompleteTasks) {
			assertTaskDispatchFields(task)
			assertDependenciesComplete(ctx.plan, task)
		}
		const activeRuns = activeWorkerRuns(ctx.plan).filter((run) => run.wave_id === ctx.activeWave.id)
		if (activeRuns.length > 0) {
			await setProgress(cwd, ctx, 'workers_running', activeRuns.map((run) => run.task_id))
			return {
				roadmap_id: ctx.roadmapId,
				milestone_id: ctx.milestoneId,
				...(ctx.changeRequestId ? { change_request_id: ctx.changeRequestId } : {}),
				wave_id: ctx.activeWave.id,
				wave_goal: ctx.activeWave.goal,
				progress_step: 'workers_running',
				assignments: [],
				active_runs: activeRuns,
				instructions:
					'Do not redispatch tasks with active worker runs. First check the current session\'s hub job snapshot (hub op:jobs) and peer roster (hub op:list) for each run\'s job_id or agent_id. If neither the hub op:jobs snapshot nor the op:list peer roster lists the run, record it abandoned immediately; do not poll, probe, or wait. Only poll or probe runs that exist in the current session. If an existing current-session run has a transport failure, record transport_failed, then prefer waking the existing worker: hub op:list to find its peer, hub op:send to it a narrow "resume from your existing transcript" message (never broadcast to:"all"), and wait up to 2 minutes for recovery. Re-resume the same worker up to the configured resume cap before abandoning; an ack is a liveness signal, not grounds to abandon, and hub op:list peer status (not the op:jobs snapshot) is the liveness authority. Do not record a transport failure as a wave result; that opens a blocker. Only after the cap is hit or a fresh op:list confirms the peer is gone, stop the peer (hub op:cancel its job) and record abandoned, then use omr_prepare_worker_redispatch before redispatching only that task.',
				// Reuse/redispatch short-circuit: do NOT re-capture the Git boundary; report current
				// availability only so the caller still sees whether checkpoints/diffs are possible.
				wave_git: await waveGitDispatchField(cwd, ctx.activeWave.id),
			}
		}

		// Only a fresh pending->running dispatch captures the Git start boundary; a redispatch of an
		// already-running wave must leave any existing wave.git untouched (captured exactly once).
		const isFreshDispatch = ctx.activeWave.status === 'pending'
		if (isFreshDispatch) {
			await transition(cwd, { operation: 'update_wave_status', waveId: ctx.activeWave.id, waveStatus: 'running' })
		}
		await setProgress(cwd, ctx, 'dispatching', incompleteTasks.map((task) => task.id))
		// Capture the Git start boundary EXACTLY ONCE, on the fresh path only, and persist it onto the
		// active wave's git.start. This never blocks dispatch: a null capture (git unavailable) simply
		// persists nothing. It rides on a runtime write immediately after the progress transition so a
		// reload overlays it back (format.ts round-trips WaveRuntime.git).
		if (isFreshDispatch) {
			const start = await captureWaveGitStart(cwd, ownedPathspecsForWave(ctx.activeTasks))
			if (start) {
				const reloaded = await activePlanContext(cwd, input)
				const wave = reloaded.plan.waves.find((candidate) => candidate.id === reloaded.activeWave.id) as
					| WaveWithGit
					| undefined
				if (wave) {
					wave.git = { ...(wave.git ?? {}), start }
					await writePlanRuntime(cwd, reloaded.plan)
				}
			}
		}
		// New-wave dispatch: consume a one-shot if the hard breach was resolvable
		// and start per-scope time clocks for budget consumption tracking.
		if (budgetGate.mustConsumeOneShot) {
			await consumeBudgetOneShot(cwd, ctx, budgetGate.enforcement)
		}
		await startBudgetTimeClocks(cwd, ctx)

		return {
			roadmap_id: ctx.roadmapId,
			milestone_id: ctx.milestoneId,
			...(ctx.changeRequestId ? { change_request_id: ctx.changeRequestId } : {}),
			wave_id: ctx.activeWave.id,
			wave_goal: ctx.activeWave.goal,
			progress_step: 'dispatching',
			assignments: await assignments(cwd, ctx, incompleteTasks.map((task) => ({
				task,
				permission: { singleWorker: incompleteTasks.length === 1, isRework: false },
			}))),
			active_runs: [],
			instructions:
				'Dispatch each assignment as a background subagent (the task tool, run in the background) using the assignment\'s exact worker and prompt. Immediately call omr_record_worker_dispatch with the returned agentId and jobId before polling workers via the hub tool (op:jobs / op:wait).',
			wave_git: await waveGitDispatchField(cwd, ctx.activeWave.id),
		}
	})
}

export async function prepareWorkerRedispatch(
	cwd: string,
	// reworkOf is an optional bridge to a reviewer-driven rework-queue item: when set, the
	// caller should pass the same value to omr_record_worker_dispatch's reworkOf so the
	// resulting WorkerRun.rework_of marker is persisted independently of replaces_agent_id.
	input: PrepareWorkerRedispatchInput & { reworkOf?: string },
): Promise<PrepareWorkerRedispatchResult> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'wave.prepareWorkerRedispatch',
		cwd,
		slowMs: 250,
		metadata: { task_id: input.taskId },
	}, async () => {
		await assertImplementationReady(cwd)
		const ctx = await activePlanContext(cwd, input)
		const budgetGate = await checkBudgetEnforcementForDispatch(cwd, ctx)
		const task = requireTaskInActiveWave(ctx, input.taskId)

		// Core guard: never redispatch while a run for this task is still running.
		const runningForTask = ctx.plan.progress.worker_runs.filter(
			(run) => run.task_id === task.id && run.status === 'running',
		)
		if (runningForTask.length > 0) {
			throw new Error(`Task ${task.id} still has a running worker; stop and abandon it before redispatch`)
		}

		// Find the prior transport_failed or abandoned run to replace.
		const failedRuns = ctx.plan.progress.worker_runs.filter((run) =>
			run.task_id === task.id &&
			(run.status === 'transport_failed' || run.status === 'abandoned') &&
			(input.agentId === undefined || run.agent_id === input.agentId) &&
			(input.jobId === undefined || run.job_id === input.jobId)
		)
		if (failedRuns.length === 0) {
			throw new Error(`Task ${task.id} has no transport_failed or abandoned worker run to redispatch`)
		}
		if (failedRuns.length > 1) {
			throw new Error(`Task ${task.id} has multiple transport_failed or abandoned worker runs; include agentId or jobId`)
		}
		const prior = failedRuns[0]
		if (!prior) throw new Error(`Task ${task.id} has no transport_failed or abandoned worker run to redispatch`)

		// Atomically flip the prior run to abandoned (idempotent if already abandoned) and drop it from active_task_ids.
		const abandoned: WorkerRun = {
			...prior,
			status: 'abandoned',
			updated_at: nowIso(),
		}
		const activeTaskIds = ctx.plan.progress.active_task_ids.filter((taskId) => taskId !== prior.task_id)
		await writeProgressWithRuns(
			cwd,
			ctx,
			replaceWorkerRun(ctx.plan.progress.worker_runs, abandoned),
			activeTaskIds,
			ctx.plan.tasks,
			activeTaskIds.length > 0 ? 'workers_running' : 'dispatching',
		)

		// Reload context and build the continuation assignment for the replacement worker.
		const reloaded = await activePlanContext(cwd, input)
		const reloadedTask = requireTaskInActiveWave(reloaded, input.taskId)
		const continuation: WorkerContinuation = {
			priorAgentId: prior.agent_id,
			transportFailures: prior.transport_failures ?? 0,
			...(prior.last_error ? { lastError: prior.last_error } : {}),
		}
		// Consume a one-shot if the hard breach was resolvable at the dispatch gate.
		if (budgetGate.mustConsumeOneShot) {
			await consumeBudgetOneShot(cwd, reloaded, budgetGate.enforcement)
		}
		return {
			roadmap_id: reloaded.roadmapId,
			milestone_id: reloaded.milestoneId,
			...(reloaded.changeRequestId ? { change_request_id: reloaded.changeRequestId } : {}),
			wave_id: reloaded.activeWave.id,
			// isRework must reflect GENUINE rework linkage (a post-review rework-queue item),
			// not merely "went through the redispatch path" — a plain transport-failure/abandon
			// continuation has no review behind it and concurrent siblings may still be running.
			// singleWorker is computed independently from the wave's own current incomplete-task
			// count, so a single-task wave still gets the owned-file permission either way.
			assignment: (await assignments(cwd, reloaded, [{
				task: reloadedTask,
				permission: {
					singleWorker: reloaded.activeTasks.filter((t) => t.status !== 'done').length === 1,
					isRework: Boolean(input.reworkOf),
				},
				continuation,
			}]))[0]!,
			prior_run: {
				agent_id: prior.agent_id,
				job_id: prior.job_id,
				transport_failures: prior.transport_failures ?? 0,
				...(prior.last_error ? { last_error: prior.last_error } : {}),
			},
			instructions: input.reworkOf
				? `Spawn the replacement as a background subagent (the task tool, run in the background) using the assignment's exact worker and prompt (the prompt carries CONTINUATION CONTEXT, the prior worker's history://${prior.agent_id} transcript pointer, and a live-peer coordination warning). Only spawn after the prior peer is stopped and confirmed gone via hub op:list (hub op:cancel its job if still live). Then call omr_record_worker_dispatch with the new agentId and jobId, replacesAgentId set to ${prior.agent_id}, and reworkOf set to ${input.reworkOf}.`
				: `Spawn the replacement as a background subagent (the task tool, run in the background) using the assignment's exact worker and prompt (the prompt carries CONTINUATION CONTEXT, the prior worker's history://${prior.agent_id} transcript pointer, and a live-peer coordination warning). Only spawn after the prior peer is stopped and confirmed gone via hub op:list (hub op:cancel its job if still live). Then call omr_record_worker_dispatch with the new agentId and jobId and replacesAgentId set to ${prior.agent_id}.`,
		}
	})
}
