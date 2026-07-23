import * as fs from 'node:fs/promises'
import { withStoreWriteLock } from '../lock'
import { adhocPlanDir } from '../paths'
import { captureTaskContext } from '../task-context'
import type { AdhocPlan, CloseoutEvidence, TaskPlan, TaskPlanInput, WavePlan } from '../types'
import { pendingWaveFlowCheck } from './format'
import { clearAdhocActive, loadActive, loadAdhocActive, loadAdhocPlan, writeAdhocActive, writeAdhocPlan, writeAdhocRuntime } from './persistence'
import { initialProgress } from './plans'
import { assertSlug, nowIso } from './shared'

export interface CreateAdhocPlanInput {
	adhocId: string;
	title: string;
	request: string;
	verificationCommands: string[];
	acceptanceCriteria: string[];
	openQuestions?: string[];
	userInterview?: string[];
	relevantExistingCode?: string[];
	relevantDocumentation?: string[];
	decisions?: string[];
	dependencyAnalysis?: string[];
	tasks: TaskPlanInput[];
	waves: WavePlan[];
}

function buildAdhocPlan(input: CreateAdhocPlanInput, tasks: TaskPlan[], now: string): AdhocPlan {
	return {
		adhoc_id: input.adhocId,
		title: input.title,
		status: 'adhoc_draft',
		created_at: now,
		updated_at: now,
		request: input.request,
		approvals: [],
		open_questions: input.openQuestions ?? [],
		verification_commands: input.verificationCommands,
		acceptance_criteria: input.acceptanceCriteria,
		cleanup_policy: 'approval-gated',
		user_interview: input.userInterview ?? [],
		relevant_existing_code: input.relevantExistingCode ?? [],
		relevant_documentation: input.relevantDocumentation ?? [],
		decisions: input.decisions ?? [],
		dependency_analysis: input.dependencyAnalysis ?? [],
		tasks,
		waves: input.waves,
		progress: initialProgress(input.waves),
		wave_flow_check: pendingWaveFlowCheck(),
	}
}

async function persistAdhoc(cwd: string, plan: AdhocPlan): Promise<void> {
	await writeAdhocPlan(cwd, plan)
	await writeAdhocRuntime(cwd, plan)
}

export async function createAdhocPlan(cwd: string, input: CreateAdhocPlanInput): Promise<AdhocPlan> {
	return await withStoreWriteLock(cwd, async () => {
		assertSlug(input.adhocId, 'adhocId')
		if (await loadActive(cwd)) throw new Error('A roadmap is active; close it before starting an ad-hoc plan')
		if (await loadAdhocActive(cwd)) throw new Error('An ad-hoc plan is already active')

		const plan = buildAdhocPlan(input, await captureTaskContext(cwd, input.tasks, input.waves), nowIso())
		await fs.mkdir(adhocPlanDir(cwd, plan.adhoc_id), { recursive: true })
		await persistAdhoc(cwd, plan)
		await writeAdhocActive(cwd, { adhoc_id: plan.adhoc_id, updated_at: plan.updated_at })
		return plan
	})
}

// Replace the active ad-hoc plan's definition (draft revisions before approval).
export async function updateAdhocPlan(cwd: string, input: CreateAdhocPlanInput): Promise<AdhocPlan> {
	return await withStoreWriteLock(cwd, async () => {
		const pointer = await loadAdhocActive(cwd)
		if (!pointer || pointer.adhoc_id !== input.adhocId) {
			throw new Error(`Ad-hoc plan is not active: ${input.adhocId}`)
		}
		const current = await loadAdhocPlan(cwd, input.adhocId)
		if (current.status !== 'adhoc_draft') {
			throw new Error(`Ad-hoc plan can only be edited while in adhoc_draft (current: ${current.status})`)
		}
		const now = nowIso()
		const plan: AdhocPlan = {
			...buildAdhocPlan(input, await captureTaskContext(cwd, input.tasks, input.waves), current.created_at),
			updated_at: now,
			wave_flow_check: current.wave_flow_check,
		}
		await persistAdhoc(cwd, plan)
		return plan
	})
}

export type AdhocTransitionOperation =
	| 'record_wave_flow_check'
	| 'approve'
	| 'start_implementing'
	| 'start_reviewing'
	| 'record_closeout'
	| 'complete'
	| 'cancel';

export interface AdhocTransitionInput {
	operation: AdhocTransitionOperation;
	approver?: string;
	summary?: string;
	waveFlowCheck?: { status: 'passed' | 'failed'; checkedBy?: string; summary?: string; findings?: string[] };
	closeout?: Omit<CloseoutEvidence, 'roadmap_id' | 'milestone_id'>;
}

const STATUS_TRANSITIONS: Record<string, { from: AdhocPlan['status']; to: AdhocPlan['status'] }> = {
	approve: { from: 'adhoc_draft', to: 'adhoc_approved' },
	start_implementing: { from: 'adhoc_approved', to: 'implementing' },
	start_reviewing: { from: 'implementing', to: 'reviewing' },
	record_closeout: { from: 'reviewing', to: 'closeout' },
	complete: { from: 'closeout', to: 'complete' },
}

export async function adhocTransition(cwd: string, input: AdhocTransitionInput): Promise<AdhocPlan | undefined> {
	return await withStoreWriteLock(cwd, async () => {
		const pointer = await loadAdhocActive(cwd)
		if (!pointer) throw new Error('No active ad-hoc plan')
		const plan = await loadAdhocPlan(cwd, pointer.adhoc_id)
		const now = nowIso()

		if (input.operation === 'cancel') {
			await clearAdhocActive(cwd)
			return undefined
		}

		if (input.operation === 'record_wave_flow_check') {
			if (!input.waveFlowCheck) throw new Error('record_wave_flow_check requires a waveFlowCheck result')
			const next: AdhocPlan = {
				...plan,
				updated_at: now,
				wave_flow_check: {
					status: input.waveFlowCheck.status,
					checked_by: input.waveFlowCheck.checkedBy ?? 'wave-flow-checker',
					checked_at: now,
					summary: input.waveFlowCheck.summary ?? '',
					findings: input.waveFlowCheck.findings ?? [],
				},
			}
			await persistAdhoc(cwd, next)
			return next
		}

		const transition = STATUS_TRANSITIONS[input.operation]
		if (!transition) throw new Error(`Unknown ad-hoc transition: ${input.operation}`)
		if (plan.status !== transition.from) {
			throw new Error(`Cannot ${input.operation} an ad-hoc plan in status ${plan.status} (requires ${transition.from})`)
		}

		if (input.operation === 'approve' && plan.wave_flow_check.status !== 'passed') {
			throw new Error('Ad-hoc plan approval requires a passed wave-flow check')
		}

		const next: AdhocPlan = { ...plan, status: transition.to, updated_at: now }
		if (input.operation === 'approve') {
			next.approvals = [...plan.approvals, { by: input.approver ?? 'user', at: now, summary: input.summary ?? 'approved' }]
		}
		if (input.operation === 'record_closeout') {
			if (!input.closeout) throw new Error('record_closeout requires closeout evidence')
			next.closeout = { ...input.closeout, roadmap_id: '', milestone_id: plan.adhoc_id }
		}

		await persistAdhoc(cwd, next)
		if (input.operation === 'complete') await clearAdhocActive(cwd)
		return next
	})
}
