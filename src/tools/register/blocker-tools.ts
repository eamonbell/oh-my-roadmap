import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {
	appendNote,
	type AppendNoteInput,
	deferBlocker,
	type DeferBlockerInput,
	listBlockers,
	type ListBlockersInput,
	openBlocker,
	type OpenBlockerInput,
	resolveBlocker,
	type ResolveBlockerInput,
} from '../../core/store/index'
import {textResult, type ToolRegistrationContext} from './shared'

export function registerBlockerTools(ctx: ToolRegistrationContext): void {
	const {z, register} = ctx
	const {blockerSeveritySchema, blockerStatusSchema} = ctx.schemas

	register({
		name: 'roadmap_engineer_append_note',
		label: 'Append Roadmap Note',
		description: 'Append an immutable scoped note to the active milestone log.',
		approval: 'write',
		parameters: z.object({
			kind: z.enum(['worker', 'review', 'orchestrator', 'decision', 'issue']),
			roadmapId: z.string().optional(),
			milestoneId: z.string().optional(),
			waveId: z.string().optional(),
			taskId: z.string().optional(),
			workerId: z.string().optional(),
			blocking: z.boolean().optional(),
			status: z.enum(['open', 'resolved', 'deferred']).optional(),
			title: z.string(),
			body: z.string(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const filePath = await appendNote(ctx.cwd, params as AppendNoteInput)
			return textResult(`Appended note to ${filePath}.`, {filePath})
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_open_blocker',
		label: 'Open Blocker',
		description: 'Open a canonical scoped roadmap blocker.',
		approval: 'write',
		parameters: z.object({
			roadmapId: z.string().optional(),
			milestoneId: z.string().optional(),
			changeRequestId: z.string().optional(),
			taskId: z.string().optional(),
			waveId: z.string().optional(),
			severity: blockerSeveritySchema.default('blocking'),
			title: z.string(),
			description: z.string(),
			createdBy: z.string().optional(),
			notePath: z.string().optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const blocker = await openBlocker(ctx.cwd, params as OpenBlockerInput)
			return textResult(`Opened blocker ${blocker.id}.`, blocker)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_resolve_blocker',
		label: 'Resolve Blocker',
		description: 'Resolve an open canonical roadmap blocker.',
		approval: 'write',
		parameters: z.object({
			roadmapId: z.string().optional(),
			blockerId: z.string(),
			resolvedBy: z.string().optional(),
			resolution: z.string(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const blocker = await resolveBlocker(ctx.cwd, params as ResolveBlockerInput)
			return textResult(`Resolved blocker ${blocker.id}.`, blocker)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_defer_blocker',
		label: 'Defer Blocker',
		description: 'Defer an open canonical roadmap blocker.',
		approval: 'write',
		parameters: z.object({
			roadmapId: z.string().optional(),
			blockerId: z.string(),
			deferredBy: z.string().optional(),
			deferReason: z.string(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const blocker = await deferBlocker(ctx.cwd, params as DeferBlockerInput)
			return textResult(`Deferred blocker ${blocker.id}.`, blocker)
		},
	} as ToolDefinition)

	register({
		name: 'roadmap_engineer_list_blockers',
		label: 'List Blockers',
		description: 'List canonical roadmap blockers by scope, status, and severity.',
		approval: 'read',
		parameters: z.object({
			roadmapId: z.string().optional(),
			milestoneId: z.string().optional(),
			changeRequestId: z.string().optional(),
			taskId: z.string().optional(),
			waveId: z.string().optional(),
			status: blockerStatusSchema.optional(),
			severity: blockerSeveritySchema.optional(),
			limit: z.number().optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await listBlockers(ctx.cwd, params as ListBlockersInput)
			return textResult(JSON.stringify(result), result)
		},
	} as ToolDefinition)
}
