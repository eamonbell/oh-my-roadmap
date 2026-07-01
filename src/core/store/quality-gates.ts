import {readRoadmapEvents} from '../events'
import type {RoadmapMilestoneCheck, WaveFlowCheck} from '../types'
import type {ListQualityGatesInput, ListQualityGatesResult} from './contract'
import {loadRoadmapState, loadState, storeTiming} from './persistence'

export async function listQualityGatesImpl(cwd: string, input: ListQualityGatesInput = {}): Promise<ListQualityGatesResult> {
	const gate = input.gate ?? 'roadmap_milestone_check'
	const eventInput = {
		type: ['quality_gate.recorded'],
		limit: 500,
		...(input.roadmapId ? {roadmapId: input.roadmapId} : {}),
	}
	const result = await readRoadmapEvents(cwd, {
		...eventInput,
	})
	const filteredHistory = result.events.filter((event) => {
		if (event.scope.gate !== gate) return false
		if (input.status === undefined) return true
		return event.details?.gate_status === input.status
	})
	const history = input.limit === undefined ? filteredHistory : filteredHistory.slice(-Math.max(0, Math.floor(input.limit)))

	const state = await loadState(cwd)
	let current: WaveFlowCheck | RoadmapMilestoneCheck | undefined
	const roadmapId = input.roadmapId ?? state.active?.roadmap_id
	if (gate === 'roadmap_milestone_check' && roadmapId) {
		current = state.roadmap?.roadmap_id === roadmapId
			? state.roadmap.roadmap_milestone_check
			: (await loadRoadmapState(cwd, roadmapId)).roadmap_milestone_check
	} else if (gate === 'wave_flow_check' && (!input.roadmapId || input.roadmapId === state.active?.roadmap_id)) {
		current = state.changeRequest?.wave_flow_check ?? state.milestone?.wave_flow_check
	}

	return {
		...(current ? {current} : {}),
		history,
	}
}

export async function listQualityGates(cwd: string, input: ListQualityGatesInput = {}): Promise<ListQualityGatesResult> {
	return await storeTiming('listQualityGates', cwd, {
		roadmap_id: input.roadmapId,
		gate: input.gate ?? 'roadmap_milestone_check',
		status: input.status,
	}, async () => await listQualityGatesImpl(cwd, input))
}
