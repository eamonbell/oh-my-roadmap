import {withDiagnosticTiming} from '../../diagnostics'
import {loadRoadmapBlockers, loadState} from '../store/index'
import type {ImplementationProgress, LoadedState, WavePlan} from '../types'
import {validateRoadmapState} from '../validation'
import {blockerLabels, hasPlannableMilestone, plan, scopeFromState, transitionTool} from './shared'
import type {NextActionPlan} from './types'

function roadmapCheckNextAction(state: LoadedState): NextActionPlan | undefined {
	if (!state.roadmap) return undefined
	const roadmap = state.roadmap
	const check = roadmap.roadmap_milestone_check
	if (!roadmap.roadmap_finalized) return undefined
	if (check.roadmap_revision !== roadmap.roadmap_revision || check.roadmap_content_hash !== roadmap.roadmap_content_hash) {
		return plan({
			id: `roadmap:${roadmap.roadmap_id}:milestone-check:stale`,
			label: 'Rerun roadmap milestone checker',
			description: `Rerun roadmap-milestone checker: checked revision ${check.roadmap_revision}, current revision ${roadmap.roadmap_revision}.`,
			status: 'stale',
			scope: scopeFromState(state),
		})
	}
	if (roadmap.phase !== 'roadmap_draft') return undefined
	if (check.status === 'pending') {
		return plan({
			id: `roadmap:${roadmap.roadmap_id}:milestone-check:pending`,
			label: 'Run roadmap milestone checker',
			description: `Dispatch roadmap-milestone checker for revision ${roadmap.roadmap_revision}.`,
			status: 'agent_required',
			scope: scopeFromState(state),
		})
	}
	if (check.status === 'failed') {
		const finding = check.findings[0] ? ` Latest finding: ${check.findings[0]}` : ''
		return plan({
			id: `roadmap:${roadmap.roadmap_id}:milestone-check:failed`,
			label: 'Revise roadmap after failed checker',
			description: `Revise roadmap, regenerate roadmap.md, then rerun roadmap-milestone checker.${finding}`,
			status: 'needs_input',
			missing_inputs: ['revised roadmap'],
			scope: scopeFromState(state),
		})
	}
	return undefined
}

function waveFlowCheckPlan(state: LoadedState, checkStatus: 'pending' | 'failed', kind: 'milestone' | 'change'): NextActionPlan {
	const label = kind === 'milestone' ? 'milestone plan' : 'change request plan'
	const check = state.changeRequest?.wave_flow_check ?? state.milestone?.wave_flow_check
	const finding = check?.findings[0] ? ` Latest finding: ${check.findings[0]}` : ''
	if (checkStatus === 'pending') {
		return plan({
			id: `${kind}:${state.active?.milestone_id ?? 'none'}:${state.active?.change_request_id ?? 'none'}:wave-flow-check:pending`,
			label: 'Run wave-flow checker',
			description: `Dispatch wave-flow checker for the ${label}.`,
			status: 'agent_required',
			scope: scopeFromState(state),
		})
	}
	return plan({
		id: `${kind}:${state.active?.milestone_id ?? 'none'}:${state.active?.change_request_id ?? 'none'}:wave-flow-check:failed`,
		label: 'Revise plan after failed wave-flow check',
		description: `Revise the ${label}, then rerun wave-flow checker.${finding}`,
		status: 'needs_input',
		missing_inputs: [`revised ${label}`],
		scope: scopeFromState(state),
	})
}

async function nextActionPlanImpl(cwd: string): Promise<NextActionPlan> {
	const state = await loadState(cwd)
	if (!state.active || !state.roadmap) {
		return plan({
			id: 'roadmap:create',
			label: 'Create roadmap',
			description: 'Create a roadmap with /roadmap:new.',
			status: 'needs_input',
			missing_inputs: ['roadmap id', 'roadmap title'],
			scope: {},
		})
	}
	const blockers = await loadRoadmapBlockers(cwd, state.roadmap.roadmap_id)
	const openBlockingBlockers = blockers.filter((blocker) => blocker.status === 'open' && blocker.severity === 'blocking')
	if (openBlockingBlockers.length > 0) {
		return plan({
			id: `roadmap:${state.roadmap.roadmap_id}:blockers:open`,
			label: 'Resolve blocking blockers',
			description: `Resolve or defer blocking blockers: ${blockerLabels(openBlockingBlockers).join(', ')}`,
			status: 'blocked',
			blockers: blockerLabels(openBlockingBlockers),
			scope: scopeFromState(state),
		})
	}
	const roadmapCheckAction = roadmapCheckNextAction(state)
	if (roadmapCheckAction) return roadmapCheckAction
	if (state.changeRequest?.status === 'draft') {
		if (state.changeRequest.wave_flow_check.status === 'pending') return waveFlowCheckPlan(state, 'pending', 'change')
		if (state.changeRequest.wave_flow_check.status === 'failed') return waveFlowCheckPlan(state, 'failed', 'change')
	}
	if (state.roadmap.phase === 'milestone_planning' && state.milestone) {
		if (state.milestone.wave_flow_check.status === 'pending') return waveFlowCheckPlan(state, 'pending', 'milestone')
		if (state.milestone.wave_flow_check.status === 'failed') return waveFlowCheckPlan(state, 'failed', 'milestone')
	}
	const validation = await validateRoadmapState(cwd)
	if (!validation.valid) {
		const firstError = validation.errors[0]
		return plan({
			id: `roadmap:${state.roadmap.roadmap_id}:validation:${firstError?.code ?? 'invalid'}`,
			label: 'Resolve validation errors',
			description: `Resolve validation errors: ${firstError?.message}`,
			status: firstError?.code === 'notes.blocking.open' ? 'blocked' : 'needs_input',
			blockers: firstError?.code === 'notes.blocking.open' ? [firstError.message] : [],
			missing_inputs: firstError?.code === 'notes.blocking.open' ? [] : [firstError?.message ?? 'valid roadmap state'],
			scope: scopeFromState(state),
		})
	}
	if (state.changeRequest) {
		switch (state.changeRequest.status) {
			case 'draft':
				return plan({
					id: `change:${state.changeRequest.change_request_id}:approve`,
					label: 'Approve change request',
					description: 'Approve the change request plan before implementation.',
					status: 'approval_required',
					scope: scopeFromState(state),
				})
			case 'approved':
				return plan({
					id: `change:${state.changeRequest.change_request_id}:start-implementation`,
					label: 'Start change implementation',
					description: 'Start change implementation with /milestone:implement.',
					status: 'ready',
					safe_to_apply: true,
					scope: scopeFromState(state),
					tool: transitionTool({operation: 'start_implementation'}),
				})
			case 'implementing':
				return progressNextActionPlan(state, state.changeRequest.progress, state.changeRequest.waves)
			case 'reviewing':
				return plan({
					id: `change:${state.changeRequest.change_request_id}:review`,
					label: 'Review change request',
					description: 'Review the change request and record closeout evidence.',
					status: 'agent_required',
					scope: scopeFromState(state),
				})
			case 'closed':
				return plan({
					id: `change:${state.changeRequest.change_request_id}:closed`,
					label: 'Continue roadmap',
					description: 'Change request is closed; continue from the current roadmap phase.',
					status: 'needs_input',
					scope: scopeFromState(state),
				})
		}
	}

	switch (state.roadmap.phase) {
		case 'discovery':
			return plan({
				id: `roadmap:${state.roadmap.roadmap_id}:record-discovery`,
				label: 'Record repo discovery',
				description: 'Record repo discovery with roadmap_engineer_transition record_discovery.',
				status: 'needs_input',
				missing_inputs: ['repo discovery findings'],
				scope: scopeFromState(state),
			})
		case 'roadmap_draft':
			return plan({
				id: `roadmap:${state.roadmap.roadmap_id}:approve`,
				label: 'Approve roadmap',
				description: 'Answer all open roadmap questions, then approve the roadmap.',
				status: state.roadmap.open_questions.length > 0 ? 'needs_input' : 'approval_required',
				missing_inputs: state.roadmap.open_questions,
				scope: scopeFromState(state),
			})
		case 'roadmap_approved':
			return plan({
				id: `roadmap:${state.roadmap.roadmap_id}:start-milestone-planning`,
				label: 'Start milestone planning',
				description: 'Plan the next milestone with /milestone:plan.',
				status: 'ready',
				safe_to_apply: true,
				scope: scopeFromState(state),
				tool: transitionTool({operation: 'start_milestone_planning'}),
			})
		case 'milestone_planning':
			return plan({
				id: `milestone:${state.active.milestone_id ?? 'none'}:approve`,
				label: 'Approve milestone',
				description: 'Complete dependency analysis, waves, ownership, verification commands, then approve the milestone.',
				status: 'approval_required',
				scope: scopeFromState(state),
			})
		case 'milestone_approved':
			return plan({
				id: `milestone:${state.active.milestone_id ?? 'none'}:start-implementation`,
				label: 'Start implementation',
				description: 'Start implementation with /milestone:implement.',
				status: 'ready',
				safe_to_apply: true,
				scope: scopeFromState(state),
				tool: transitionTool({operation: 'start_implementation'}),
			})
		case 'implementing':
			if (state.milestone) return progressNextActionPlan(state, state.milestone.progress, state.milestone.waves)
			return plan({
				id: `roadmap:${state.roadmap.roadmap_id}:implement`,
				label: 'Execute current wave',
				description: 'Execute the current wave, append worker notes, then run wave review.',
				status: 'agent_required',
				scope: scopeFromState(state),
			})
		case 'reviewing':
			return plan({
				id: `milestone:${state.active.milestone_id ?? 'none'}:start-closeout`,
				label: 'Enter closeout',
				description: 'Resolve or defer blocking findings, then continue or enter closeout.',
				status: 'agent_required',
				scope: scopeFromState(state),
			})
		case 'closeout':
			return plan({
				id: `milestone:${state.active.milestone_id ?? 'none'}:record-closeout`,
				label: 'Record closeout evidence',
				description: 'Record structured closeout evidence, then close the milestone with /milestone:close.',
				status: 'needs_input',
				missing_inputs: ['structured closeout evidence'],
				scope: scopeFromState(state),
			})
		case 'complete':
			if (hasPlannableMilestone(state)) {
				return plan({
					id: `roadmap:${state.roadmap.roadmap_id}:start-next-milestone-planning`,
					label: 'Start next milestone planning',
					description: 'Start the next planned milestone with /milestone:plan or create a post-implementation change request.',
					status: 'ready',
					safe_to_apply: true,
					scope: scopeFromState(state),
					tool: transitionTool({operation: 'start_milestone_planning'}),
				})
			}
			return plan({
				id: `roadmap:${state.roadmap.roadmap_id}:complete`,
				label: 'Create follow-up work',
				description: 'Create a post-implementation change request or start a new roadmap.',
				status: 'needs_input',
				missing_inputs: ['change request or new roadmap'],
				scope: scopeFromState(state),
			})
	}
}

export async function nextAction(cwd: string): Promise<string> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'report.nextAction',
		cwd,
		slowMs: 250,
	}, async () => (await nextActionPlan(cwd)).description)
}

function progressNextActionPlan(state: LoadedState, progress: ImplementationProgress, waves: WavePlan[]): NextActionPlan {
	const wave = progress.active_wave_id ? ` ${progress.active_wave_id}` : ''
	const baseScope = scopeFromState(state)
	const activeWaveIndex = progress.active_wave_id
		? waves.findIndex((candidate) => candidate.id === progress.active_wave_id)
		: -1
	switch (progress.step) {
		case 'not_started':
			return plan({
				id: `progress:${progress.active_wave_id ?? 'none'}:dispatch`,
				label: 'Dispatch wave',
				description: `Dispatch wave${wave} and update progress to dispatching.`,
				status: 'agent_required',
				scope: {...baseScope, ...(progress.active_wave_id ? {wave_id: progress.active_wave_id} : {})},
			})
		case 'dispatching':
			return plan({
				id: `progress:${progress.active_wave_id ?? 'none'}:start-workers`,
				label: 'Start assigned tasks',
				description: `Start assigned tasks for wave${wave} and update progress to workers_running.`,
				status: 'agent_required',
				scope: {...baseScope, ...(progress.active_wave_id ? {wave_id: progress.active_wave_id} : {})},
			})
		case 'workers_running':
			return plan({
				id: `progress:${progress.active_wave_id ?? 'none'}:collect-worker-notes`,
				label: 'Collect worker notes',
				description: 'Collect worker notes for active tasks, then update progress to wave_review.',
				status: 'agent_required',
				scope: {...baseScope, ...(progress.active_wave_id ? {wave_id: progress.active_wave_id} : {})},
			})
		case 'wave_review':
			return plan({
				id: `progress:${progress.active_wave_id ?? 'none'}:wave-review`,
				label: 'Run wave review',
				description: `Run review for wave${wave}; resolve blockers or mark the wave complete.`,
				status: 'agent_required',
				scope: {...baseScope, ...(progress.active_wave_id ? {wave_id: progress.active_wave_id} : {})},
			})
		case 'resolving_blockers':
			return plan({
				id: `progress:${progress.active_wave_id ?? 'none'}:resolve-blockers`,
				label: 'Resolve progress blocker',
				description: `Resolve blocker: ${progress.blocked_reason ?? 'not recorded'}.`,
				status: 'blocked',
				blockers: [progress.blocked_reason ?? 'not recorded'],
				scope: {...baseScope, ...(progress.active_wave_id ? {wave_id: progress.active_wave_id} : {})},
			})
		case 'ready_for_next_wave': {
			const activeWave = activeWaveIndex >= 0 ? waves[activeWaveIndex] : undefined
			if (activeWave && activeWave.status !== 'complete') {
				return plan({
					id: `progress:${activeWave.id}:complete-before-advance`,
					label: 'Complete active wave',
					description: 'Advance progress to the next wave, or mark closeout_ready if no waves remain.',
					status: 'agent_required',
					scope: {...baseScope, wave_id: activeWave.id},
				})
			}
			const previousWavesComplete = activeWaveIndex >= 0 &&
				waves.slice(0, activeWaveIndex + 1).every((candidate) => candidate.status === 'complete')
			const nextWave = previousWavesComplete
				? waves.slice(activeWaveIndex + 1).find((candidate) => candidate.status !== 'complete')
				: undefined
			if (nextWave?.status === 'pending') {
				return plan({
					id: `progress:${nextWave.id}:activate`,
					label: 'Advance to next wave',
					description: 'Advance progress to the next wave, or mark closeout_ready if no waves remain.',
					status: 'ready',
					safe_to_apply: true,
					scope: {...baseScope, wave_id: nextWave.id},
					tool: transitionTool({
						operation: 'update_implementation_progress',
						progress: {activeWaveId: nextWave.id, step: 'not_started', activeTaskIds: []},
					}),
				})
			}
			if (previousWavesComplete && !nextWave) {
				return plan({
					id: `progress:${baseScope.milestone_id ?? baseScope.change_request_id ?? 'active'}:closeout-ready`,
					label: 'Mark closeout ready',
					description: 'Advance progress to the next wave, or mark closeout_ready if no waves remain.',
					status: 'ready',
					safe_to_apply: true,
					scope: baseScope,
					tool: transitionTool({
						operation: 'update_implementation_progress',
						progress: {step: 'closeout_ready', activeTaskIds: []},
					}),
				})
			}
			return plan({
				id: `progress:${progress.active_wave_id ?? 'none'}:advance-ambiguous`,
				label: 'Choose next wave',
				description: 'Advance progress to the next wave, or mark closeout_ready if no waves remain.',
				status: 'needs_input',
				missing_inputs: ['single next pending wave or all waves complete'],
				scope: {...baseScope, ...(progress.active_wave_id ? {wave_id: progress.active_wave_id} : {})},
			})
		}
		case 'closeout_ready':
			if (state.changeRequest) {
				return plan({
					id: `change:${state.changeRequest.change_request_id}:review`,
					label: 'Review change request',
					description: 'Review the change request and record closeout evidence.',
					status: 'agent_required',
					scope: baseScope,
				})
			}
			return plan({
				id: `implementation:${baseScope.milestone_id ?? baseScope.change_request_id ?? 'active'}:start-reviewing`,
				label: 'Enter reviewing',
				description: 'Enter closeout and record structured closeout evidence.',
				status: 'ready',
				safe_to_apply: true,
				scope: baseScope,
				tool: transitionTool({operation: 'start_reviewing'}),
			})
	}
}

export async function nextActionPlan(cwd: string): Promise<NextActionPlan> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'report.nextActionPlan',
		cwd,
		slowMs: 250,
	}, async () => await nextActionPlanImpl(cwd))
}
