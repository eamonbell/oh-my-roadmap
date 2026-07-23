import type { ToolDefinition } from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import { readRoadmapEvents, type ReadRoadmapEventsInput } from '@oh-my-roadmap/core/events'
import { readContext, type ReadContextInput, searchContext, type SearchContextInput, } from '@oh-my-roadmap/core/context'
import { listQualityGates, type ListQualityGatesInput, loadRoadmapBlockers, loadState, } from '@oh-my-roadmap/core/store/index'
import { refreshRepoPrimer, renderRepoPrimer } from '@oh-my-roadmap/core/repo-primer'
import { type StateReadScope, type StateSummaryRepoPrimer, summarizeState } from '@oh-my-roadmap/core/state-summary'
import { buildTaskBriefing, type TaskBriefingResponseFormat } from '@oh-my-roadmap/core/task-briefing'
import { textResult, type ToolRegistrationContext } from './shared'

const PLANNER_PRIMER_SCOPES = new Set<StateReadScope>([
	'roadmap',
	'active_milestone',
	'active_change',
	'roadmap_checker_package',
	'wave_flow_checker_package',
])
const PLANNER_PRIMER_MAX_BYTES = 12 * 1024

async function plannerPrimerContext(cwd: string): Promise<{
	repoPrimer?: StateSummaryRepoPrimer
	repoPrimerWarnings: string[]
}> {
	try {
		const refreshed = await refreshRepoPrimer(cwd)
		if (refreshed.status === 'unavailable') {
			return { repoPrimerWarnings: refreshed.warnings }
		}
		const rendered = renderRepoPrimer(refreshed.primer, PLANNER_PRIMER_MAX_BYTES)
		const warnings = [...refreshed.warnings]
		if (rendered.truncated) {
			warnings.push(`Repository primer was truncated to ${PLANNER_PRIMER_MAX_BYTES} bytes.`)
		}
		return {
			repoPrimer: {
				...rendered,
				generated_at: refreshed.primer.generated_at,
				source_fingerprint: refreshed.primer.source_fingerprint,
			},
			repoPrimerWarnings: warnings,
		}
	} catch (error) {
		return { repoPrimerWarnings: [`Repository primer refresh failed: ${(error as Error).message}`] }
	}
}

export function registerContextTools(ctx: ToolRegistrationContext): void {
	const { z, register } = ctx
	const { contextArtifactSchema, contextNoteKindSchema, contextNoteStatusSchema } = ctx.schemas

	register({
		name: 'omr_read_state',
		label: 'Read Roadmap State',
		description: 'Read compact active roadmap, milestone, and change-request state. Full detail is available through omr_search_context and omr_read_context.',
		approval: 'read',
		parameters: z.object({
			scope: z.enum(['compact', 'roadmap', 'active_milestone', 'active_wave', 'active_change', 'usage', 'phase', 'progress', 'quality_gates', 'milestone_outlines', 'closeout_requirements', 'roadmap_checker_package', 'wave_flow_checker_package']).optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const scope = ((params as { scope?: StateReadScope }).scope ?? 'compact') as StateReadScope
			const state = await loadState(ctx.cwd)
			const blockers = state.roadmap ? await loadRoadmapBlockers(ctx.cwd, state.roadmap.roadmap_id) : []
			// sectionRefs discards snippet bodies, so request a minimal snippet and skip computing thrown-away text.
			const roadmapSections = ['compact', 'roadmap'].includes(scope)
				? (await searchContext(ctx.cwd, { artifacts: ['roadmap'], maxResults: 50, snippetChars: 1 })).results
				: undefined
			const planSections = ['compact', 'active_milestone', 'active_change'].includes(scope)
				? (await searchContext(ctx.cwd, { artifacts: ['plan'], maxResults: 80, snippetChars: 1 })).results
				: undefined
			const activePlan = state.adhoc ?? state.changeRequest ?? state.milestone
			const activeWaveId = scope === 'active_wave' ? activePlan?.progress.active_wave_id : undefined
			const activeWaveTasks = activeWaveId
				? activePlan?.waves.find((wave) => wave.id === activeWaveId)?.tasks ?? []
				: []
			// Worker notes are matched by the wave's task IDs (waveId is optional on
			// append and often omitted); review notes are wave-level and matched by waveId.
			const noteSections = activeWaveId
				? [
					...(activeWaveTasks.length > 0
						? (await searchContext(ctx.cwd, {
							artifacts: ['notes'],
							kinds: ['worker'],
							taskIds: activeWaveTasks,
							maxResults: 80,
							snippetChars: 1
						})).results
						: []),
					...(await searchContext(ctx.cwd, {
						artifacts: ['notes'],
						kinds: ['review'],
						waveId: activeWaveId,
						maxResults: 80,
						snippetChars: 1
					})).results,
				]
				: undefined
			const primerContext = PLANNER_PRIMER_SCOPES.has(scope)
				? await plannerPrimerContext(ctx.cwd)
				: undefined
			const summary = summarizeState(state, scope, {
				...(roadmapSections !== undefined ? { roadmapSections } : {}),
				...(planSections !== undefined ? { planSections } : {}),
				...(noteSections !== undefined ? { noteSections } : {}),
				...(primerContext ?? {}),
				blockers,
			})
			return textResult(JSON.stringify(summary), summary)
		},
	} as ToolDefinition)

	register({
		name: 'omr_search_context',
		label: 'Search Roadmap Context',
		description: 'Search active-roadmap notes, decisions, risks, roadmap sections, and plan sections with compact snippet results. Use mode=count or mode=ids before snippets/bodies for broad discovery.',
		approval: 'read',
		parameters: z.object({
			artifacts: z.array(contextArtifactSchema).optional(),
			query: z.string().optional(),
			useRegex: z.boolean().optional(),
			caseSensitive: z.boolean().optional(),
			mode: z.enum(['count', 'ids', 'snippets', 'bodies']).optional(),
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
		name: 'omr_read_context',
		label: 'Read Roadmap Context',
		description: 'Read selected context entries returned by omr_search_context.',
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
		name: 'omr_read_events',
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
		name: 'omr_list_quality_gates',
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

	register({
		name: 'omr_task_briefing',
		label: 'Task Briefing',
		description: 'One-call context pack for your owned + dependency files: sizes, truncated head excerpts, and a one-hop import graph. Call this ONCE at the start of a task instead of dozens of exploratory reads, e.g. omr_task_briefing({ owned_paths: ["packages/core/src/foo.ts"], dependency_paths: ["packages/core/src/bar.ts"], response_format: "concise" }). Symbol outlines and diagnostics are out of scope here — use your own xd://lsp for those on files you touch.',
		approval: 'read',
		parameters: z.object({
			owned_paths: z.array(z.string()),
			dependency_paths: z.array(z.string()).optional(),
			response_format: z.enum(['concise', 'detailed']).optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const input = params as { owned_paths: string[]; dependency_paths?: string[]; response_format?: TaskBriefingResponseFormat }
			const result = await buildTaskBriefing(ctx.cwd, {
				ownedPaths: input.owned_paths,
				...(input.dependency_paths !== undefined ? { dependencyPaths: input.dependency_paths } : {}),
				...(input.response_format !== undefined ? { responseFormat: input.response_format } : {}),
			})
			return textResult(JSON.stringify(result), result)
		},
	} as ToolDefinition)
}
