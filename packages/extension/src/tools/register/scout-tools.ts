import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {
	listScoutFindings,
	type ListScoutFindingsInput,
	recordScoutFinding,
	type RecordScoutFindingInput,
} from '@oh-my-roadmap/core/store/scout-findings'
import {textResult, type ToolRegistrationContext} from './shared'

export function registerScoutTools(ctx: ToolRegistrationContext): void {
	const {z, register} = ctx

	register({
		name: 'omr_record_scout_finding',
		label: 'Record Scout Finding',
		description: 'Persist a compact, reusable scout finding for a subsystem into the active roadmap so later planning can reuse it instead of re-scouting.',
		approval: 'write',
		parameters: z.object({
			subsystem: z.string().describe('Subsystem or area the finding covers, e.g. "auth", "billing".'),
			milestoneIds: z.array(z.string()).optional().describe('Milestone IDs this finding is relevant to.'),
			sourcePaths: z.array(z.string()).optional().describe('Key source paths inspected for this finding.'),
			summary: z.string().describe('One-line summary of the finding.'),
			findings: z.array(z.string()).optional().describe('Durable, compact findings worth reusing.'),
			createdBy: z.string().optional().describe('Author of the finding; defaults to orchestrator.'),
			stale: z.boolean().optional().describe('Mark the finding stale so it is excluded from default reads.'),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const finding = await recordScoutFinding(ctx.cwd, params as RecordScoutFindingInput)
			return textResult(`Recorded scout finding ${finding.id} for ${finding.subsystem}.`, finding)
		},
	} as ToolDefinition)

	register({
		name: 'omr_list_scout_findings',
		label: 'List Scout Findings',
		description: 'List reusable scout findings for the active or selected roadmap, filtered by subsystem, milestone, source path, and staleness.',
		approval: 'read',
		parameters: z.object({
			roadmapId: z.string().optional(),
			subsystem: z.string().optional(),
			milestoneId: z.string().optional(),
			sourcePath: z.string().optional(),
			includeStale: z.boolean().optional(),
			limit: z.number().optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await listScoutFindings(ctx.cwd, params as ListScoutFindingsInput)
			return textResult(JSON.stringify(result), result)
		},
	} as ToolDefinition)
}
