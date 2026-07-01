import {appendRoadmapEvent} from '../events'
import type {LoadedState, RoadmapBlocker, RoadmapEvent, RoadmapEventScope} from '../types'
import type {TransitionInput} from './contract'

export function scopeFromLoaded(loaded: LoadedState): RoadmapEventScope {
	const roadmapId = loaded.active?.roadmap_id ?? loaded.roadmap?.roadmap_id
	if (!roadmapId) throw new Error('Cannot record event without a roadmap id')
	const scope: RoadmapEventScope = {roadmap_id: roadmapId}
	const milestoneId = loaded.active?.milestone_id ?? loaded.roadmap?.active_milestone_id ?? loaded.milestone?.milestone_id
	if (milestoneId) scope.milestone_id = milestoneId
	const changeRequestId =
		loaded.active?.change_request_id ?? loaded.roadmap?.active_change_request_id ?? loaded.changeRequest?.change_request_id
	if (changeRequestId) scope.change_request_id = changeRequestId
	return scope
}

export function loadedSnapshot(loaded: LoadedState): Record<string, unknown> {
	const snapshot: Record<string, unknown> = {}
	if (loaded.roadmap) {
		snapshot.phase = loaded.roadmap.phase
		snapshot.roadmap_finalized = loaded.roadmap.roadmap_finalized
		snapshot.active_milestone_id = loaded.roadmap.active_milestone_id ?? null
		snapshot.active_change_request_id = loaded.roadmap.active_change_request_id ?? null
	}
	if (loaded.milestone) snapshot.milestone_status = loaded.milestone.status
	if (loaded.changeRequest) snapshot.change_request_status = loaded.changeRequest.status
	return snapshot
}

export function taskStatusSnapshot(loaded: LoadedState, taskId: string | undefined): Record<string, unknown> {
	if (!taskId) return loadedSnapshot(loaded)
	const task = (loaded.changeRequest?.tasks ?? loaded.milestone?.tasks ?? []).find((candidate) => candidate.id === taskId)
	return {task_id: taskId, status: task?.status ?? null}
}

export function waveStatusSnapshot(loaded: LoadedState, waveId: string | undefined): Record<string, unknown> {
	if (!waveId) return loadedSnapshot(loaded)
	const wave = (loaded.changeRequest?.waves ?? loaded.milestone?.waves ?? []).find((candidate) => candidate.id === waveId)
	return {wave_id: waveId, status: wave?.status ?? null}
}

export function progressSnapshot(loaded: LoadedState): Record<string, unknown> {
	const progress = loaded.changeRequest?.progress ?? loaded.milestone?.progress
	return {
		active_wave_id: progress?.active_wave_id ?? null,
		step: progress?.step ?? null,
		active_task_ids: progress?.active_task_ids ?? [],
		worker_runs: progress?.worker_runs.map((run) => ({
			task_id: run.task_id,
			wave_id: run.wave_id,
			agent_id: run.agent_id,
			job_id: run.job_id,
			status: run.status,
		})) ?? [],
		blocked_reason: progress?.blocked_reason ?? null,
	}
}

export function waveFlowCheckSnapshot(loaded: LoadedState): Record<string, unknown> {
	const check = loaded.changeRequest?.wave_flow_check ?? loaded.milestone?.wave_flow_check
	return {
		status: check?.status ?? null,
		checked_by: check?.checked_by ?? '',
		checked_at: check?.checked_at ?? '',
	}
}

export function roadmapMilestoneCheckSnapshot(loaded: LoadedState): Record<string, unknown> {
	const check = loaded.roadmap?.roadmap_milestone_check
	return {
		status: check?.status ?? null,
		checked_by: check?.checked_by ?? '',
		checked_at: check?.checked_at ?? '',
		roadmap_revision: check?.roadmap_revision ?? null,
		roadmap_content_hash: check?.roadmap_content_hash ?? '',
		event_id: check?.event_id ?? '',
	}
}

export function closeoutSnapshot(loaded: LoadedState): Record<string, unknown> {
	const closeout = loaded.changeRequest?.closeout ?? loaded.closeout
	return {status: closeout?.status ?? null, closed_by: closeout?.closed_by ?? null}
}

export function eventSnapshot(loaded: LoadedState, input: TransitionInput): Record<string, unknown> {
	switch (input.operation) {
		case 'update_task_status':
			return taskStatusSnapshot(loaded, input.taskId)
		case 'update_wave_status':
			return waveStatusSnapshot(loaded, input.waveId)
		case 'update_implementation_progress':
			return progressSnapshot(loaded)
		case 'record_wave_flow_check':
			return waveFlowCheckSnapshot(loaded)
		case 'record_roadmap_milestone_check':
			return roadmapMilestoneCheckSnapshot(loaded)
		case 'record_closeout':
			return closeoutSnapshot(loaded)
		default:
			return loadedSnapshot(loaded)
	}
}

export function transitionEventScope(loaded: LoadedState, input: TransitionInput): RoadmapEventScope {
	const scope = scopeFromLoaded(loaded)
	if (input.taskId) scope.task_id = input.taskId
	if (input.waveId) scope.wave_id = input.waveId
	if (input.operation === 'record_wave_flow_check') scope.gate = 'wave_flow_check'
	if (input.operation === 'record_roadmap_milestone_check') scope.gate = 'roadmap_milestone_check'
	return scope
}

export function transitionActor(input: TransitionInput): string {
	if (input.operation === 'record_wave_flow_check') {
		return input.waveFlowCheck?.checkedBy?.trim() || 'wave-flow-checker'
	}
	if (input.operation === 'record_roadmap_milestone_check') {
		return input.roadmapMilestoneCheck?.checkedBy?.trim() || 'roadmap-milestone-checker'
	}
	return input.approver?.trim() || 'user'
}

export function transitionEventType(operation: TransitionInput['operation']): string {
	switch (operation) {
		case 'record_discovery':
			return 'roadmap.discovery_recorded'
		case 'approve_roadmap':
			return 'roadmap.approved'
		case 'reopen_roadmap':
			return 'roadmap.reopened'
		case 'record_roadmap_milestone_check':
		case 'record_wave_flow_check':
			return 'quality_gate.recorded'
		case 'start_milestone_planning':
			return 'milestone.planning_started'
		case 'create_milestone_plan':
			return 'milestone.plan_created'
		case 'approve_milestone':
			return 'milestone.approved'
		case 'update_milestone_plan':
			return 'milestone.plan_updated'
		case 'start_implementation':
			return 'implementation.started'
		case 'start_reviewing':
			return 'review.started'
		case 'start_closeout':
			return 'closeout.started'
		case 'complete_milestone':
			return 'milestone.completed'
		case 'request_bypass':
			return 'bypass.requested'
		case 'clear_bypass':
			return 'bypass.cleared'
		case 'approve_change':
			return 'change.approved'
		case 'update_change_request_plan':
			return 'change.plan_updated'
		case 'close_change':
			return 'change.closed'
		case 'update_task_status':
			return 'task.status_changed'
		case 'update_wave_status':
			return 'wave.status_changed'
		case 'update_implementation_progress':
			return 'progress.updated'
		case 'record_closeout':
			return 'closeout.recorded'
	}
}

export function transitionDetails(input: TransitionInput, after?: LoadedState): Record<string, unknown> | undefined {
	const details: Record<string, unknown> = {}
	if (input.summary) details.summary = input.summary
	if (input.reason) details.reason = input.reason
	if (input.taskStatus) details.task_status = input.taskStatus
	if (input.waveStatus) details.wave_status = input.waveStatus
	if (input.progress) details.progress_step = input.progress.step
	if (input.closeout) details.closeout_status = input.closeout.status
	if (input.waveFlowCheck) details.gate_status = input.waveFlowCheck.status
	if (input.roadmapMilestoneCheck) details.gate_status = input.roadmapMilestoneCheck.status
	if (input.operation === 'record_roadmap_milestone_check' && after?.roadmap) {
		const check = after.roadmap.roadmap_milestone_check
		details.roadmap_revision = check.roadmap_revision
		details.roadmap_content_hash = check.roadmap_content_hash
		details.summary = check.summary
		details.findings = check.findings
	}
	return Object.keys(details).length > 0 ? details : undefined
}

export function transitionSummary(input: TransitionInput): string {
	switch (input.operation) {
		case 'update_task_status':
			return `Task ${input.taskId} status changed to ${input.taskStatus}.`
		case 'update_wave_status':
			return `Wave ${input.waveId} status changed to ${input.waveStatus}.`
		case 'update_implementation_progress':
			return `Implementation progress changed to ${input.progress?.step}.`
		case 'record_wave_flow_check':
			return `Wave-flow check recorded as ${input.waveFlowCheck?.status}.`
		case 'record_roadmap_milestone_check':
			return `Roadmap milestone check recorded as ${input.roadmapMilestoneCheck?.status}.`
		case 'record_closeout':
			return `Closeout evidence recorded as ${input.closeout?.status}.`
		default:
			return `Applied ${input.operation}.`
	}
}

export async function appendTransitionEvent(
	cwd: string,
	input: TransitionInput,
	before: LoadedState,
	after: LoadedState,
	id?: string,
): Promise<RoadmapEvent> {
	const details = transitionDetails(input, after)
	return await appendRoadmapEvent(cwd, {
		...(id ? {id} : {}),
		actor: transitionActor(input),
		type: transitionEventType(input.operation),
		operation: input.operation,
		scope: transitionEventScope(before, input),
		summary: transitionSummary(input),
		before: eventSnapshot(before, input),
		after: eventSnapshot(after, input),
		...(details ? {details} : {}),
	})
}

export function blockerScope(blocker: RoadmapBlocker): RoadmapEventScope {
	const scope: RoadmapEventScope = {
		roadmap_id: blocker.roadmap_id,
		blocker_id: blocker.id,
	}
	if (blocker.milestone_id) scope.milestone_id = blocker.milestone_id
	if (blocker.change_request_id) scope.change_request_id = blocker.change_request_id
	if (blocker.task_id) scope.task_id = blocker.task_id
	if (blocker.wave_id) scope.wave_id = blocker.wave_id
	return scope
}

export function blockerSnapshot(blocker: RoadmapBlocker): Record<string, unknown> {
	return {
		id: blocker.id,
		severity: blocker.severity,
		status: blocker.status,
		title: blocker.title,
	}
}

export async function appendBlockerEvent(
	cwd: string,
	type: 'blocker.opened' | 'blocker.resolved' | 'blocker.deferred',
	actor: string,
	blocker: RoadmapBlocker,
	before: RoadmapBlocker | undefined,
	details?: Record<string, unknown>,
): Promise<RoadmapEvent> {
	const action = type.slice('blocker.'.length)
	return await appendRoadmapEvent(cwd, {
		actor,
		type,
		scope: blockerScope(blocker),
		summary: `Blocker ${blocker.id} ${action}: ${blocker.title}.`,
		...(before ? {before: blockerSnapshot(before)} : {}),
		after: blockerSnapshot(blocker),
		details: {
			severity: blocker.severity,
			status: blocker.status,
			title: blocker.title,
			...(blocker.note_path ? {note_path: blocker.note_path} : {}),
			...(details ?? {}),
		},
	})
}
