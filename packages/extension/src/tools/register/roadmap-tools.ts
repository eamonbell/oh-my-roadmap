import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {
	initRoadmap,
	type InitRoadmapInput,
	repairRoadmap,
	type RepairRoadmapInput,
	updateRoadmap,
	type UpdateRoadmapInput,
} from 'oh-my-roadmap-core/store/index'
import {textResult, type ToolRegistrationContext} from './shared'

export function registerRoadmapLifecycleTools(ctx: ToolRegistrationContext): void {
	const {z, register} = ctx
	const {roadmapMilestoneSchema} = ctx.schemas

	register({
		name: 'omr_init',
		label: 'Init Roadmap',
		description: 'Create .omr state and set a single active roadmap.',
		approval: 'write',
		parameters: z.object({
			roadmapId: z.string(),
			title: z.string(),
			summary: z.string().optional(),
			discovery: z
			.object({
				recorded: z.boolean().optional(),
				external_research_required: z.boolean().optional(),
				external_research_recorded: z.boolean().optional(),
				findings: z.array(z.string()).optional(),
			})
			.optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const state = await initRoadmap(ctx.cwd, params as InitRoadmapInput)
			return textResult(`Initialized roadmap ${state.roadmap_id}.`, state)
		},
	} as ToolDefinition)

	register({
		name: 'omr_update_roadmap',
		label: 'Update Roadmap',
		description: 'Finalize the structured roadmap outline and generate roadmap.md before roadmap approval.',
		approval: 'write',
		parameters: z.object({
			goal: z.string(),
			successCriteria: z.array(z.string()),
			constraints: z.array(z.string()),
			nonGoals: z.array(z.string()),
			context: z.array(z.string()),
			evidence: z.array(z.string()),
			risks: z.array(z.string()),
			milestones: z.array(roadmapMilestoneSchema),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const state = await updateRoadmap(ctx.cwd, params as UpdateRoadmapInput)
			return textResult(`Updated roadmap ${state.roadmap_id}.`, state)
		},
	} as ToolDefinition)

	register({
		name: 'omr_repair_roadmap',
		label: 'Repair Roadmap',
		description: 'Repair generated roadmap hash, roadmap.md, and roadmap-milestone check drift after manual state recovery.',
		approval: 'write',
		parameters: z.object({
			reason: z.string(),
			actor: z.string().optional(),
			summary: z.string().optional(),
			roadmapMilestoneCheck: z.object({
				status: z.literal('passed'),
				checkedBy: z.string().optional(),
				summary: z.string(),
				findings: z.array(z.string()).default([]),
			}).optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await repairRoadmap(ctx.cwd, params as RepairRoadmapInput)
			return textResult(`Repaired roadmap ${result.roadmap_id}.`, result)
		},
	} as ToolDefinition)
}
