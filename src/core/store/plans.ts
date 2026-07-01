import * as fs from 'node:fs/promises'
import {openCloseoutEvidence, writeMilestoneCloseout} from '../closeout'
import {appendRoadmapEvent, roadmapEventId} from '../events'
import {appendText, writeMarkdownData, writeText} from '../files'
import {serializeMarkdownDocument} from '../frontmatter'
import {withStoreWriteLock} from '../lock'
import {changeRequestPath, decisionsPath, milestoneCloseoutPath, milestoneDir, milestoneNotesPath, roadmapDocPath} from '../paths'
import type {ChangeRequest, ImplementationProgress, LoadedState, MilestonePlan, Phase, RoadmapState, TaskPlan, WavePlan} from '../types'
import type {CreateChangeRequestInput, CreateMilestonePlanInput, TransitionInput} from './contract'
import {appendTransitionEvent} from './events'
import {
	normalizeChangeRequest,
	pendingRoadmapMilestoneCheck,
	pendingWaveFlowCheck,
	planDefinitionData,
	recordedRoadmapMilestoneCheck,
	recordedWaveFlowCheck,
	renderImplementationPlanBody,
	renderRoadmapMarkdown,
	roadmapContentHash
} from './format'
import {
	loadRoadmapState,
	loadState,
	storeTiming,
	withStoreMutationRollback,
	writeActive,
	writeChangeRequestRuntime,
	writeMilestonePlan,
	writeMilestoneRuntime,
	writeRoadmapState
} from './persistence'
import {assertRoadmapReadyForApproval} from './roadmap'
import {
	approval,
	assertSlug,
	closeoutOrThrow,
	hasPlannableMilestone,
	nowIso,
	requireActiveMilestone,
	requireMilestoneId,
	requirePhase,
	setMilestoneStatus
} from './shared'

export function initialProgress(waves: WavePlan[]): ImplementationProgress {
	return {
		...(waves[0] ? {active_wave_id: waves[0].id} : {}),
		step: 'not_started',
		active_task_ids: [],
		worker_runs: [],
		updated_at: nowIso(),
	}
}

export async function createMilestonePlanImpl(
	cwd: string,
	roadmap: RoadmapState,
	input: CreateMilestonePlanInput,
): Promise<MilestonePlan> {
	return await withStoreWriteLock(cwd, async () => {
		assertSlug(input.milestoneId, 'milestoneId')
		const currentRoadmap = await loadRoadmapState(cwd, roadmap.roadmap_id)
		const roadmapMilestone = currentRoadmap.milestones.find((milestone) => milestone.id === input.milestoneId)
		if (!roadmapMilestone) {
			throw new Error(`Milestone is not defined in roadmap: ${input.milestoneId}`)
		}
		if (roadmapMilestone.status !== 'planned' && roadmapMilestone.status !== 'blocked') {
			throw new Error(`Milestone already has a plan: ${input.milestoneId}`)
		}

		return await withStoreMutationRollback(cwd, currentRoadmap.roadmap_id, async () => {
			const before = {
				phase: currentRoadmap.phase,
				milestone_status: roadmapMilestone.status,
			}

			const plan: MilestonePlan = {
				roadmap_id: currentRoadmap.roadmap_id,
				milestone_id: input.milestoneId,
				title: input.title,
				status: 'milestone_planning',
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
				tasks: input.tasks,
				waves: input.waves,
				progress: initialProgress(input.waves),
				wave_flow_check: pendingWaveFlowCheck(),
			}

			await fs.mkdir(milestoneDir(cwd, currentRoadmap.roadmap_id, input.milestoneId), {recursive: true})
			await writeMilestonePlan(cwd, plan)
			await writeMilestoneRuntime(cwd, plan)
			await writeText(milestoneNotesPath(cwd, currentRoadmap.roadmap_id, input.milestoneId), '# Milestone Notes\n')
			await writeText(
				milestoneCloseoutPath(cwd, currentRoadmap.roadmap_id, input.milestoneId),
				serializeMarkdownDocument(
					openCloseoutEvidence(currentRoadmap.roadmap_id, input.milestoneId) as unknown as Record<string, unknown>,
					'# Closeout Evidence\n',
				),
			)

			roadmapMilestone.status = 'milestone_planning'
			currentRoadmap.active_milestone_id = input.milestoneId
			currentRoadmap.phase = 'milestone_planning'
			await writeRoadmapState(cwd, currentRoadmap)
			await writeActive(cwd, {
				roadmap_id: currentRoadmap.roadmap_id,
				milestone_id: input.milestoneId,
				updated_at: nowIso(),
			})
			await appendRoadmapEvent(cwd, {
				actor: 'user',
				type: 'milestone.plan_created',
				operation: 'create_milestone_plan',
				scope: {
					roadmap_id: currentRoadmap.roadmap_id,
					milestone_id: input.milestoneId,
				},
				summary: `Created milestone plan ${input.milestoneId}.`,
				before,
				after: {
					phase: currentRoadmap.phase,
					milestone_status: roadmapMilestone.status,
				},
			})

			return plan
		})
	})
}

export async function updateMilestonePlanDraft(
	cwd: string,
	plan: MilestonePlan,
	input: CreateMilestonePlanInput,
): Promise<MilestonePlan> {
	if (plan.status !== 'milestone_planning') {
		throw new Error('update_milestone_plan requires a draft milestone plan')
	}
	if (plan.approvals.length > 0) throw new Error('Approved milestone plans cannot be updated')
	if (input.milestoneId !== plan.milestone_id) {
		throw new Error(`update_milestone_plan cannot change milestone id from ${plan.milestone_id} to ${input.milestoneId}`)
	}
	const updated: MilestonePlan = {
		...plan,
		title: input.title,
		open_questions: input.openQuestions ?? [],
		verification_commands: input.verificationCommands,
		acceptance_criteria: input.acceptanceCriteria,
		user_interview: input.userInterview ?? [],
		relevant_existing_code: input.relevantExistingCode ?? [],
		relevant_documentation: input.relevantDocumentation ?? [],
		decisions: input.decisions ?? [],
		dependency_analysis: input.dependencyAnalysis ?? [],
		tasks: input.tasks,
		waves: input.waves,
		progress: initialProgress(input.waves),
		wave_flow_check: pendingWaveFlowCheck(),
	}
	return await withStoreMutationRollback(cwd, updated.roadmap_id, async () => {
		await writeMilestonePlan(cwd, updated)
		await writeMilestoneRuntime(cwd, updated)
		await appendRoadmapEvent(cwd, {
			actor: 'user',
			type: 'milestone.plan_updated',
			operation: 'update_milestone_plan',
			scope: {
				roadmap_id: updated.roadmap_id,
				milestone_id: updated.milestone_id,
			},
			summary: `Updated milestone plan ${updated.milestone_id}.`,
			before: {
				title: plan.title,
				task_count: plan.tasks.length,
				wave_count: plan.waves.length,
				wave_flow_check: plan.wave_flow_check.status,
			},
			after: {
				title: updated.title,
				task_count: updated.tasks.length,
				wave_count: updated.waves.length,
				wave_flow_check: updated.wave_flow_check.status,
			},
		})
		return updated
	})
}

export async function writeChangeRequest(
	cwd: string,
	change: ChangeRequest,
	body?: string,
): Promise<void> {
	const normalized = normalizeChangeRequest(change)
	await writeMarkdownData(
		changeRequestPath(cwd, normalized.roadmap_id, normalized.milestone_id, normalized.change_request_id),
		planDefinitionData(normalized),
		body ?? renderImplementationPlanBody(normalized),
	)
}

export async function writeActivePointer(
	cwd: string,
	roadmapId: string,
	milestoneId: string | undefined,
	changeRequestId?: string,
): Promise<void> {
	await writeActive(cwd, {
		roadmap_id: roadmapId,
		...(milestoneId ? {milestone_id: milestoneId} : {}),
		...(changeRequestId ? {change_request_id: changeRequestId} : {}),
		updated_at: nowIso(),
	})
}

export async function transitionImpl(cwd: string, input: TransitionInput): Promise<LoadedState> {
	return await withStoreWriteLock(cwd, async () => {
		const loaded = await loadState(cwd)
		if (!loaded.active || !loaded.roadmap) {
			throw new Error('No active roadmap. Run /roadmap:new first.')
		}
		const active = loaded.active
		const loadedRoadmap = loaded.roadmap

		return await withStoreMutationRollback(cwd, active.roadmap_id, async () => {
			const beforeEvent = structuredClone(loaded) as LoadedState
			const roadmap = loadedRoadmap
			const activeMilestoneId = active.milestone_id ?? roadmap.active_milestone_id
			let transitionEventId: string | undefined
			let writeRoadmap = true

			switch (input.operation) {
				case 'record_discovery': {
					if (!['discovery', 'roadmap_draft'].includes(roadmap.phase)) {
						throw new Error(`record_discovery requires phase discovery or roadmap_draft; current phase is ${roadmap.phase}`)
					}
					const discoveryContentHash = roadmapContentHash(roadmap)
					roadmap.discovery = {
						recorded: input.discovery?.recorded ?? true,
						external_research_required:
							input.discovery?.external_research_required ?? roadmap.discovery.external_research_required,
						external_research_recorded:
							input.discovery?.external_research_recorded ?? roadmap.discovery.external_research_recorded,
						findings: input.discovery?.findings ?? roadmap.discovery.findings,
					}
					roadmap.phase = 'roadmap_draft'
					roadmap.roadmap_content_hash = roadmapContentHash(roadmap)
					if (roadmap.roadmap_content_hash !== discoveryContentHash) {
						roadmap.roadmap_revision += 1
						roadmap.roadmap_milestone_check = pendingRoadmapMilestoneCheck(
							roadmap.roadmap_revision,
							roadmap.roadmap_content_hash,
						)
					}
					break
				}
				case 'approve_roadmap':
					requirePhase(roadmap.phase, 'roadmap_draft', input.operation)
					if (!roadmap.discovery.recorded) throw new Error('Roadmap approval requires recorded repo discovery')
					if (roadmap.discovery.external_research_required && !roadmap.discovery.external_research_recorded) {
						throw new Error('Roadmap approval requires recorded external research')
					}
					if (roadmap.open_questions.length > 0) {
						throw new Error('Roadmap approval requires all material questions to be resolved')
					}
					await assertRoadmapReadyForApproval(cwd, roadmap)
					roadmap.phase = 'roadmap_approved'
					roadmap.approvals.push(approval(input.approver, input.summary))
					break
				case 'record_roadmap_milestone_check':
					requirePhase(roadmap.phase, 'roadmap_draft', input.operation)
					if (!roadmap.roadmap_finalized) {
						throw new Error('record_roadmap_milestone_check requires a finalized roadmap')
					}
					if (!input.roadmapMilestoneCheck) {
						throw new Error('record_roadmap_milestone_check requires checker input')
					}
					roadmap.roadmap_content_hash = roadmapContentHash(roadmap)
					roadmap.roadmap_milestone_check = recordedRoadmapMilestoneCheck(input.roadmapMilestoneCheck, roadmap)
					transitionEventId = roadmapEventId()
					roadmap.roadmap_milestone_check.event_id = transitionEventId
					break
				case 'reopen_roadmap': {
					requirePhase(roadmap.phase, 'roadmap_approved', input.operation)
					const reason = input.reason?.trim()
					if (!reason) throw new Error('reopen_roadmap requires a reason')
					if (activeMilestoneId) throw new Error('reopen_roadmap requires no active milestone')
					if (active.change_request_id || roadmap.active_change_request_id) {
						throw new Error('reopen_roadmap requires no active change request')
					}

					roadmap.phase = 'roadmap_draft'
					roadmap.roadmap_finalized = false
					roadmap.roadmap_revision += 1
					roadmap.roadmap_content_hash = roadmapContentHash(roadmap)
					roadmap.roadmap_milestone_check = pendingRoadmapMilestoneCheck(
						roadmap.roadmap_revision,
						roadmap.roadmap_content_hash,
					)
					await appendText(
						decisionsPath(cwd, roadmap.roadmap_id),
						`\n## Roadmap Reopened\n\n- Reason: ${reason}\n- At: ${nowIso()}\n\nRoadmap reopened for pre-milestone changes. Regenerate the structured roadmap and require reapproval before milestone planning.\n`,
					)
					await writeText(roadmapDocPath(cwd, roadmap.roadmap_id), renderRoadmapMarkdown(roadmap))
					break
				}
				case 'start_milestone_planning':
					if (!['roadmap_approved', 'complete'].includes(roadmap.phase)) {
						throw new Error(`start_milestone_planning requires phase roadmap_approved or complete; current phase is ${roadmap.phase}`)
					}
					if (roadmap.phase === 'complete') {
						if (active.change_request_id || roadmap.active_change_request_id) {
							throw new Error('start_milestone_planning requires no active change request')
						}
						if (!hasPlannableMilestone(roadmap)) {
							throw new Error('start_milestone_planning requires a planned or blocked milestone')
						}
						delete roadmap.active_milestone_id
						await writeActivePointer(cwd, roadmap.roadmap_id, undefined)
					}
					roadmap.phase = 'milestone_planning'
					break
				case 'create_milestone_plan':
					requirePhase(roadmap.phase, 'milestone_planning', input.operation)
					if (!input.milestone) throw new Error('create_milestone_plan requires milestone input')
					await createMilestonePlan(cwd, roadmap, input.milestone)
					return await loadState(cwd)
				case 'approve_milestone': {
					requirePhase(roadmap.phase, 'milestone_planning', input.operation)
					requireActiveMilestone(activeMilestoneId, loaded.milestone)
					const milestoneId = requireMilestoneId(activeMilestoneId)
					const plan = {...loaded.milestone, status: 'milestone_approved' as Phase}
					if (plan.open_questions.length > 0) throw new Error('Milestone approval requires open questions to be resolved')
					if (plan.wave_flow_check.status !== 'passed') {
						throw new Error('Milestone approval requires a passed wave-flow check')
					}
					if (plan.approvals.length > 0) throw new Error('Milestone is already approved')
					plan.approvals.push(approval(input.approver, input.summary))
					await writeMilestonePlan(cwd, plan)
					roadmap.phase = 'milestone_approved'
					setMilestoneStatus(roadmap, milestoneId, 'milestone_approved')
					break
				}
				case 'update_milestone_plan': {
					requirePhase(roadmap.phase, 'milestone_planning', input.operation)
					requireActiveMilestone(activeMilestoneId, loaded.milestone)
					if (!input.milestone) throw new Error('update_milestone_plan requires milestone input')
					await updateMilestonePlanDraft(cwd, loaded.milestone, input.milestone)
					return await loadState(cwd)
				}
				case 'start_implementation': {
					if (loaded.changeRequest) {
						if (!['reviewing', 'closeout', 'complete'].includes(roadmap.phase)) {
							throw new Error('Change implementation can start only from reviewing, closeout, or complete')
						}
						if (!['approved', 'implementing'].includes(loaded.changeRequest.status)) {
							throw new Error('Change implementation requires an approved change request')
						}
						const change = {...loaded.changeRequest, status: 'implementing' as const}
						await writeChangeRequest(cwd, change)
						break
					}
					requirePhase(roadmap.phase, 'milestone_approved', input.operation)
					requireActiveMilestone(activeMilestoneId, loaded.milestone)
					const milestoneId = requireMilestoneId(activeMilestoneId)
					if (loaded.milestone.approvals.length === 0) throw new Error('Implementation requires milestone approval')
					roadmap.phase = 'implementing'
					setMilestoneStatus(roadmap, milestoneId, 'implementing')
					break
				}
				case 'start_reviewing':
					requirePhase(roadmap.phase, 'implementing', input.operation)
					requireActiveMilestone(activeMilestoneId, loaded.milestone)
					const reviewingMilestoneId = requireMilestoneId(activeMilestoneId)
					roadmap.phase = 'reviewing'
					setMilestoneStatus(roadmap, reviewingMilestoneId, 'reviewing')
					break
				case 'start_closeout':
					requirePhase(roadmap.phase, 'reviewing', input.operation)
					requireActiveMilestone(activeMilestoneId, loaded.milestone)
					const closeoutMilestoneId = requireMilestoneId(activeMilestoneId)
					roadmap.phase = 'closeout'
					setMilestoneStatus(roadmap, closeoutMilestoneId, 'closeout')
					break
				case 'complete_milestone':
					requirePhase(roadmap.phase, 'closeout', input.operation)
					requireActiveMilestone(activeMilestoneId, loaded.milestone)
					const completedMilestoneId = requireMilestoneId(activeMilestoneId)
					closeoutOrThrow(
						loaded.closeout,
						loaded.milestone.acceptance_criteria,
						loaded.milestone.verification_commands,
					)
					roadmap.phase = 'complete'
					setMilestoneStatus(roadmap, completedMilestoneId, 'complete')
					break
				case 'request_bypass':
					if (!input.reason) throw new Error('Bypass requires a reason')
					roadmap.bypass = {
						active: true,
						reason: input.reason,
						requested_by: input.approver ?? 'user',
						requested_at: nowIso(),
					}
					break
				case 'clear_bypass':
					delete roadmap.bypass
					break
				case 'approve_change': {
					if (!loaded.changeRequest || !activeMilestoneId) {
						throw new Error('No active change request to approve')
					}
					if (loaded.changeRequest.status !== 'draft') throw new Error('Only draft change requests can be approved')
					if (loaded.changeRequest.wave_flow_check.status !== 'passed') {
						throw new Error('Change approval requires a passed wave-flow check')
					}
					const change = {
						...loaded.changeRequest,
						status: 'approved' as const,
						approvals: [...loaded.changeRequest.approvals, approval(input.approver, input.summary)],
					}
					await writeChangeRequest(cwd, change)
					await writeChangeRequestRuntime(cwd, change)
					break
				}
				case 'update_change_request_plan': {
					if (!loaded.changeRequest || !activeMilestoneId) {
						throw new Error('No active change request to update')
					}
					if (!input.changeRequest) throw new Error('update_change_request_plan requires change request input')
					if (loaded.changeRequest.status !== 'draft') throw new Error('Only draft change requests can be updated')
					if (input.changeRequest.changeRequestId !== loaded.changeRequest.change_request_id) {
						throw new Error(
							`update_change_request_plan cannot change request id from ${loaded.changeRequest.change_request_id} to ${input.changeRequest.changeRequestId}`,
						)
					}
					const change: ChangeRequest = {
						...loaded.changeRequest,
						title: input.changeRequest.title,
						request: input.changeRequest.request,
						verification_commands: input.changeRequest.verificationCommands,
						acceptance_criteria: input.changeRequest.acceptanceCriteria,
						user_interview: input.changeRequest.userInterview ?? [],
						relevant_existing_code: input.changeRequest.relevantExistingCode ?? [],
						relevant_documentation: input.changeRequest.relevantDocumentation ?? [],
						decisions: input.changeRequest.decisions ?? [],
						dependency_analysis: input.changeRequest.dependencyAnalysis ?? [],
						tasks: input.changeRequest.tasks,
						waves: input.changeRequest.waves,
						progress: initialProgress(input.changeRequest.waves),
						wave_flow_check: pendingWaveFlowCheck(),
					}
					await writeChangeRequest(cwd, change)
					await writeChangeRequestRuntime(cwd, change)
					break
				}
				case 'close_change': {
					if (!loaded.changeRequest || !activeMilestoneId) throw new Error('No active change request to close')
					const milestoneId = requireMilestoneId(activeMilestoneId)
					if (!loaded.changeRequest.closeout) throw new Error('Change closeout evidence is required')
					closeoutOrThrow(
						loaded.changeRequest.closeout,
						loaded.changeRequest.acceptance_criteria,
						loaded.changeRequest.verification_commands,
					)
					const change = {...loaded.changeRequest, status: 'closed' as const}
					await writeChangeRequest(cwd, change)
					delete roadmap.active_change_request_id
					await writeActivePointer(cwd, roadmap.roadmap_id, milestoneId)
					break
				}
				case 'update_task_status': {
					if (!input.taskId || !input.taskStatus) throw new Error('update_task_status requires taskId and taskStatus')
					if (loaded.changeRequest) {
						const tasks = updateTaskStatus(loaded.changeRequest.tasks, input.taskId, input.taskStatus)
						await writeChangeRequestRuntime(cwd, {...loaded.changeRequest, tasks})
						writeRoadmap = false
						break
					}
					requireActiveMilestone(activeMilestoneId, loaded.milestone)
					const tasks = updateTaskStatus(loaded.milestone.tasks, input.taskId, input.taskStatus)
					await writeMilestoneRuntime(cwd, {...loaded.milestone, tasks})
					writeRoadmap = false
					break
				}
				case 'update_wave_status': {
					if (!input.waveId || !input.waveStatus) throw new Error('update_wave_status requires waveId and waveStatus')
					if (loaded.changeRequest) {
						const waves = updateWaveStatus(loaded.changeRequest.waves, input.waveId, input.waveStatus)
						await writeChangeRequestRuntime(cwd, {...loaded.changeRequest, waves})
						writeRoadmap = false
						break
					}
					requireActiveMilestone(activeMilestoneId, loaded.milestone)
					const waves = updateWaveStatus(loaded.milestone.waves, input.waveId, input.waveStatus)
					await writeMilestoneRuntime(cwd, {...loaded.milestone, waves})
					writeRoadmap = false
					break
				}
				case 'update_implementation_progress': {
					if (!input.progress) throw new Error('update_implementation_progress requires progress input')
					const existingProgress = loaded.changeRequest?.progress ?? loaded.milestone?.progress
					const progress = {
						...(input.progress.activeWaveId ? {active_wave_id: input.progress.activeWaveId} : {}),
						step: input.progress.step,
						active_task_ids: input.progress.activeTaskIds ?? [],
						worker_runs: existingProgress?.worker_runs ?? [],
						...(input.progress.blockedReason ? {blocked_reason: input.progress.blockedReason} : {}),
						updated_at: nowIso(),
					} satisfies ImplementationProgress
					if (loaded.changeRequest) {
						await writeChangeRequestRuntime(cwd, {...loaded.changeRequest, progress})
						writeRoadmap = false
						break
					}
					requireActiveMilestone(activeMilestoneId, loaded.milestone)
					await writeMilestoneRuntime(cwd, {...loaded.milestone, progress})
					writeRoadmap = false
					break
				}
				case 'record_closeout': {
					if (!input.closeout) throw new Error('record_closeout requires closeout evidence')
					requireActiveMilestone(activeMilestoneId, loaded.milestone)
					const milestoneId = requireMilestoneId(activeMilestoneId)
					const evidence = {
						...input.closeout,
						roadmap_id: roadmap.roadmap_id,
						milestone_id: milestoneId,
						status: input.closeout.status,
						...(input.closeout.status === 'closed' && !input.closeout.closed_at
							? {closed_at: nowIso()}
							: {}),
					}
					if (loaded.changeRequest) {
						const changeEvidence = {
							...evidence,
							change_request_id: loaded.changeRequest.change_request_id,
						}
						const change = {...loaded.changeRequest, closeout: changeEvidence}
						await writeChangeRequest(cwd, change)
						break
					}
					await writeMilestoneCloseout(cwd, evidence)
					break
				}
				case 'record_wave_flow_check': {
					if (!input.waveFlowCheck) throw new Error('record_wave_flow_check requires wave flow check input')
					const waveFlowCheck = recordedWaveFlowCheck(input.waveFlowCheck)
					if (loaded.changeRequest) {
						if (loaded.changeRequest.status !== 'draft') throw new Error('record_wave_flow_check requires a draft change request')
						await writeChangeRequestRuntime(cwd, {...loaded.changeRequest, wave_flow_check: waveFlowCheck})
						writeRoadmap = false
						break
					}
					requireActiveMilestone(activeMilestoneId, loaded.milestone)
					if (loaded.milestone.status !== 'milestone_planning') {
						throw new Error('record_wave_flow_check requires a draft milestone plan')
					}
					await writeMilestoneRuntime(cwd, {...loaded.milestone, wave_flow_check: waveFlowCheck})
					writeRoadmap = false
					break
				}
				default:
					input.operation satisfies never
			}

			if (writeRoadmap) await writeRoadmapState(cwd, roadmap)
			const after = await loadState(cwd)
			await appendTransitionEvent(cwd, input, beforeEvent, after, transitionEventId)
			return after
		})
	})
}

export function updateTaskStatus(
	tasks: TaskPlan[],
	taskId: string,
	status: TaskPlan['status'],
): TaskPlan[] {
	let found = false
	const updated = tasks.map((task) => {
		if (task.id !== taskId) return task
		found = true
		return {...task, status}
	})
	if (!found) throw new Error(`Unknown task: ${taskId}`)
	return updated
}

export function updateWaveStatus(
	waves: WavePlan[],
	waveId: string,
	status: WavePlan['status'],
): WavePlan[] {
	let found = false
	const updated = waves.map((wave) => {
		if (wave.id !== waveId) return wave
		found = true
		return {...wave, status}
	})
	if (!found) throw new Error(`Unknown wave: ${waveId}`)
	return updated
}

export async function createChangeRequestImpl(
	cwd: string,
	input: CreateChangeRequestInput,
): Promise<ChangeRequest> {
	return await withStoreWriteLock(cwd, async () => {
		assertSlug(input.changeRequestId, 'changeRequestId')
		const loaded = await loadState(cwd)
		if (!loaded.active?.roadmap_id || !loaded.active.milestone_id || !loaded.roadmap) {
			throw new Error('Change requests require an active roadmap and milestone')
		}
		const active = loaded.active
		const milestoneId = active.milestone_id
		if (!milestoneId) throw new Error('Change requests require an active roadmap and milestone')
		const roadmap = loaded.roadmap
		if (active.change_request_id || roadmap.active_change_request_id) {
			throw new Error('Only one active change request is allowed')
		}
		if (!['reviewing', 'closeout', 'complete'].includes(roadmap.phase)) {
			throw new Error('Change requests are allowed only after implementation has produced changes')
		}

		return await withStoreMutationRollback(cwd, active.roadmap_id, async () => {
			const change: ChangeRequest = {
				roadmap_id: active.roadmap_id,
				milestone_id: milestoneId,
				change_request_id: input.changeRequestId,
				title: input.title,
				status: 'draft',
				requested_at: nowIso(),
				request: input.request,
				approvals: [],
				verification_commands: input.verificationCommands,
				acceptance_criteria: input.acceptanceCriteria,
				user_interview: input.userInterview ?? [],
				relevant_existing_code: input.relevantExistingCode ?? [],
				relevant_documentation: input.relevantDocumentation ?? [],
				decisions: input.decisions ?? [],
				dependency_analysis: input.dependencyAnalysis ?? [],
				tasks: input.tasks,
				waves: input.waves,
				progress: initialProgress(input.waves),
				wave_flow_check: pendingWaveFlowCheck(),
			}

			await writeChangeRequest(cwd, change)
			await writeChangeRequestRuntime(cwd, change)
			roadmap.active_change_request_id = change.change_request_id
			await writeRoadmapState(cwd, roadmap)
			await writeActive(cwd, {
				roadmap_id: change.roadmap_id,
				milestone_id: change.milestone_id,
				change_request_id: change.change_request_id,
				updated_at: nowIso(),
			})
			await appendRoadmapEvent(cwd, {
				actor: 'user',
				type: 'change.created',
				scope: {
					roadmap_id: change.roadmap_id,
					milestone_id: change.milestone_id,
					change_request_id: change.change_request_id,
				},
				summary: `Created change request ${change.change_request_id}.`,
				after: {
					status: change.status,
					task_count: change.tasks.length,
					wave_count: change.waves.length,
				},
			})
			return change
		})
	})
}

export async function createMilestonePlan(
	cwd: string,
	roadmap: RoadmapState,
	input: CreateMilestonePlanInput,
): Promise<MilestonePlan> {
	return await storeTiming('createMilestonePlan', cwd, {
		roadmap_id: roadmap.roadmap_id,
		milestone_id: input.milestoneId,
		task_count: input.tasks.length,
		wave_count: input.waves.length,
	}, async () => await createMilestonePlanImpl(cwd, roadmap, input))
}

export async function transition(cwd: string, input: TransitionInput): Promise<LoadedState> {
	return await storeTiming('transition', cwd, {
		operation: input.operation,
		task_id: input.taskId,
		wave_id: input.waveId,
	}, async () => await transitionImpl(cwd, input))
}

export async function createChangeRequest(
	cwd: string,
	input: CreateChangeRequestInput,
): Promise<ChangeRequest> {
	return await storeTiming('createChangeRequest', cwd, {
		change_request_id: input.changeRequestId,
		task_count: input.tasks.length,
		wave_count: input.waves.length,
	}, async () => await createChangeRequestImpl(cwd, input))
}
