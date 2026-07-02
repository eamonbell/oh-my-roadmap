import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {readRoadmapEvents, type ReadRoadmapEventsInput} from '../../core/events'
import {readContext, type ReadContextInput, searchContext, type SearchContextInput,} from '../../core/context'
import {listQualityGates, type ListQualityGatesInput, loadRoadmapBlockers, loadState,} from '../../core/store/index'
import {type StateReadScope, summarizeState} from '../../core/state-summary'
import {textResult, type ToolRegistrationContext} from './shared'

export function registerContextTools(ctx: ToolRegistrationContext): void {
	const {z, register} = ctx
	const {contextArtifactSchema, contextNoteKindSchema, contextNoteStatusSchema} = ctx.schemas

	register({
		name: 'roadmap_engineer_read_state',
		label: 'Read Roadmap State',
		description: 'Read compact active roadmap, milestone, and change-request state. Full detail is available through roadmap_engineer_search_context and roadmap_engineer_read_context.',
		approval: 'read',
		parameters: z.object({
			scope: z.enum(['compact', 'roadmap', 'active_milestone', 'active_wave', 'active_change', 'usage']).optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const scope = ((params as { scope?: StateReadScope }).scope ?? 'compact') as StateReadScope
			const state = await loadState(ctx.cwd)
			const blockers = state.roadmap ? await loadRoadmapBlockers(ctx.cwd, state.roadmap.roadmap_id) : []
			// sectionRefs discards snippet bodies, so request a minimal snippet and skip computing thrown-away text.
			const roadmapSections = ['compact', 'roadmap'].includes(scope)
				? (await searchContext(ctx.cwd, {artifacts: ['roadmap'], maxResults: 50, snippetChars: 1})).results
				: undefined
			const planSections = ['compact', 'active_milestone', 'active_change'].includes(scope)
				? (await searchContext(ctx.cwd, {artifacts: ['plan'], maxResults: 80, snippetChars: 1})).results
				: undefined
			const activeWaveId = scope === 'active_wave'
				? (state.changeRequest ?? state.milestone)?.progress.active_wave_id
				: undefined
			const noteSections = activeWaveId
				? (await searchContext(ctx.cwd, {artifacts: ['notes'], kinds: ['worker', 'review'], waveId: activeWaveId, maxResults: 80, snippetChars: 1})).results
				: undefined
			const summary = summarizeState(state, scope, {
				...(roadmapSections !== undefined ? {roadmapSections} : {}),
				...(planSections !== undefined ? {planSections} : {}),
				...(noteSections !== undefined ? {noteSections} : {}),
				blockers,
			})
			return textResult(JSON.stringify(summary), summary)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_search_context',
		label: 'Search Roadmap Context',
		description: 'Search active-roadmap notes, decisions, risks, roadmap sections, and plan sections with compact snippet results.',
		approval: 'read',
		parameters: z.object({
			artifacts: z.array(contextArtifactSchema).optional(),
			query: z.string().optional(),
			useRegex: z.boolean().optional(),
			caseSensitive: z.boolean().optional(),
			maxResults: z.number().optional(),
			snippetChars: z.number().optional(),
			includeBodies: z.boolean().optional(),
			maxBodyChars: z.number().optional(),
			milestoneIds: z.array(z.string()).optional(),
			kinds: z.array(contextNoteKindSchema).optional(),
			statuses: z.array(contextNoteStatusSchema).optional(),
			blocking: z.boolean().optional(),
			waveId: z.string().optional(),
			taskId: z.string().optional(),
			workerId: z.string().optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await searchContext(ctx.cwd, params as SearchContextInput)
			return textResult(JSON.stringify(result), result)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_read_context',
		label: 'Read Roadmap Context',
		description: 'Read selected context entries returned by roadmap_engineer_search_context.',
		approval: 'read',
		parameters: z.object({
			ids: z.array(z.string()),
			maxBodyChars: z.number().optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await readContext(ctx.cwd, params as ReadContextInput)
			return textResult(JSON.stringify(result), result)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_read_events',
		label: 'Read Roadmap Events',
		description: 'Read capped append-only workflow events for the active or selected roadmap.',
		approval: 'read',
		parameters: z.object({
			roadmapId: z.string().optional(),
			milestoneId: z.string().optional(),
			changeRequestId: z.string().optional(),
			taskId: z.string().optional(),
			waveId: z.string().optional(),
			blockerId: z.string().optional(),
			type: z.array(z.string()).optional(),
			since: z.string().optional(),
			limit: z.number().optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await readRoadmapEvents(ctx.cwd, params as ReadRoadmapEventsInput)
			return textResult(JSON.stringify(result), result)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_list_quality_gates',
		label: 'List Quality Gates',
		description: 'Read the current quality gate state and durable quality_gate.recorded history.',
		approval: 'read',
		parameters: z.object({
			roadmapId: z.string().optional(),
			gate: z.enum(['roadmap_milestone_check', 'wave_flow_check']).optional(),
			status: z.enum(['pending', 'passed', 'failed']).optional(),
			limit: z.number().optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await listQualityGates(ctx.cwd, params as ListQualityGatesInput)
			return textResult(JSON.stringify(result), result)
		},
	} as ToolDefinition)
}
