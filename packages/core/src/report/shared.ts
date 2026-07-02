import type {TransitionInput} from '../store/index'
import type {ImplementationProgress, LoadedState, RoadmapBlocker, RoadmapState, TaskPlan, ValidationResult, WavePlan,} from '../types'
import type {RoadmapUsageSummary, UsageScopeSummary, UsageTotals} from '../usage'
import type {NextActionPlan, NextActionScope} from './types'

export function formatValidationIssues(result: ValidationResult): string[] {
	return [
		...result.errors.map((error) => `- ERROR ${error.code}: ${error.message}`),
		...result.warnings.map((warning) => `- WARN ${warning.code}: ${warning.message}`),
	]
}

export function progressLines(label: string, progress: ImplementationProgress, waves: WavePlan[], tasks: TaskPlan[]): string[] {
	const activeWave = progress.active_wave_id
		? waves.find((wave) => wave.id === progress.active_wave_id)
		: undefined
	const activeTasks = progress.active_task_ids
	.map((taskId) => tasks.find((task) => task.id === taskId)?.title ?? taskId)
	.join(', ')

	return [
		`${label} active wave: ${progress.active_wave_id ?? 'none'}${activeWave ? ` (${activeWave.status})` : ''}`,
		`${label} progress: ${progress.step}`,
		`${label} active tasks: ${activeTasks || 'none'}`,
		`${label} blocker: ${progress.blocked_reason ?? 'none'}`,
	]
}

export function totalTokens(usage: UsageTotals): number {
	return usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens
}

export function formatUsd(usage: UsageTotals): string {
	const value = `$${usage.estimated_usd.toFixed(4)}`
	return usage.usd_unavailable ? `${value} + unknown` : value
}

export function formatUsage(usage: UsageTotals): string {
	return [
		formatUsd(usage),
		`${usage.requests} req`,
		`${totalTokens(usage)} tok`,
		`in ${usage.input_tokens}`,
		`out ${usage.output_tokens}`,
		`cache ${usage.cache_read_tokens}/${usage.cache_write_tokens}`,
		`reasoning ${usage.reasoning_tokens}`,
	].join(', ')
}

export function topAgents(scope: UsageScopeSummary): string {
	const agents = Object.entries(scope.by_agent)
	.sort(([, left], [, right]) =>
		right.estimated_usd - left.estimated_usd ||
		totalTokens(right) - totalTokens(left),
	)
	.slice(0, 3)
	.map(([agent, usage]) => `${agent}: ${formatUsage(usage)}`)
	return agents.length > 0 ? agents.join(' | ') : 'none'
}

export function usageLines(stateUsage: RoadmapUsageSummary | undefined, milestoneId?: string, changeRequestId?: string): string[] {
	if (!stateUsage) return []
	const lines = [
		`Usage roadmap: ${formatUsage(stateUsage.total)}`,
		`Usage top agents: ${topAgents(stateUsage)}`,
	]
	if (milestoneId) {
		const milestone = stateUsage.milestones[milestoneId]
		lines.push(
			`Usage milestone ${milestoneId}: ${milestone ? formatUsage(milestone.total) : formatUsage({
				estimated_usd: 0,
				usd_unavailable: false,
				requests: 0,
				input_tokens: 0,
				output_tokens: 0,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
				reasoning_tokens: 0,
			})}`,
		)
		if (milestone) lines.push(`Usage milestone top agents: ${topAgents(milestone)}`)
		if (changeRequestId) {
			const change = milestone?.change_requests[changeRequestId]
			lines.push(`Usage change ${changeRequestId}: ${change ? formatUsage(change.total) : 'none'}`)
			if (change) lines.push(`Usage change top agents: ${topAgents(change)}`)
		}
	}
	return lines
}

export function hasPlannableMilestone(state: LoadedState): boolean {
	return state.roadmap?.milestones.some((milestone) => ['planned', 'blocked'].includes(milestone.status)) ?? false
}

export function roadmapMilestoneCheckLabel(roadmap: RoadmapState): string {
	const check = roadmap.roadmap_milestone_check
	const stale = check.status !== 'pending' && (
		check.roadmap_revision !== roadmap.roadmap_revision ||
		check.roadmap_content_hash !== roadmap.roadmap_content_hash
	)
	const status = stale ? 'stale' : check.status
	return `${status} (checked revision ${check.roadmap_revision}, current revision ${roadmap.roadmap_revision})`
}

export function scopeFromState(state: LoadedState): NextActionScope {
	return {
		...(state.roadmap ? {roadmap_id: state.roadmap.roadmap_id} : {}),
		...(state.active?.milestone_id ? {milestone_id: state.active.milestone_id} : {}),
		...(state.active?.change_request_id ? {change_request_id: state.active.change_request_id} : {}),
	}
}

export function plan(input: Omit<NextActionPlan, 'safe_to_apply' | 'blockers' | 'missing_inputs'> & {
	safe_to_apply?: boolean;
	blockers?: string[];
	missing_inputs?: string[];
}): NextActionPlan {
	return {
		...input,
		safe_to_apply: input.safe_to_apply ?? false,
		blockers: input.blockers ?? [],
		missing_inputs: input.missing_inputs ?? [],
	}
}

export function transitionTool(input: TransitionInput): NonNullable<NextActionPlan['tool']> {
	return {name: 'omr_transition', input: input as unknown as Record<string, unknown>}
}

export function blockerLabels(blockers: RoadmapBlocker[]): string[] {
	return blockers.map((blocker) => `${blocker.id}: ${blocker.title}`)
}
