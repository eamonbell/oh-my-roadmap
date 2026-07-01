import type {NextActionPlan} from '../report/index'
import type {ChangeRequest, LoadedState, MilestonePlan, RoadmapBlocker, RoadmapEvent, TaskPlan, ValidationIssue, ValidationResult,} from '../types'
import type {RoadmapUsageSummary, UsageScopeSummary, UsageTotals} from '../usage'
import type {PlanContext} from './summary'
import type {
	ActiveRoadmapDetailSummary,
	RoadmapDetailActiveExecution,
	RoadmapDetailBlocker,
	RoadmapDetailCanonicalBlocker,
	RoadmapDetailCanonicalBlockers,
	RoadmapDetailCheck,
	RoadmapDetailEvent,
	RoadmapDetailHealth,
	RoadmapDetailIssue,
	RoadmapDetailNextCommand,
	RoadmapDetailQualityGate,
	RoadmapDetailReference,
	RoadmapDetailTask,
	RoadmapDetailUsage,
	RoadmapDetailUsageAgent,
	RoadmapDetailUsageTotals,
	RoadmapDetailWaves,
} from './types'

export function qualityGateSummary(
	roadmap: LoadedState['roadmap'],
	history: RoadmapDetailEvent[],
): RoadmapDetailQualityGate {
	if (!roadmap) throw new Error('Expected active roadmap')
	const check = roadmap.roadmap_milestone_check
	const stale = check.status !== 'pending' && (
		check.roadmap_revision !== roadmap.roadmap_revision ||
		check.roadmap_content_hash !== roadmap.roadmap_content_hash
	)
	const status = stale ? 'stale' : check.status
	return {
		gate: 'roadmap_milestone_check',
		status,
		label: `${status} (checked revision ${check.roadmap_revision}, current revision ${roadmap.roadmap_revision})`,
		roadmapRevision: roadmap.roadmap_revision,
		checkedRevision: check.roadmap_revision,
		roadmapContentHash: roadmap.roadmap_content_hash,
		checkedContentHash: check.roadmap_content_hash,
		...(check.findings[0] ? {latestFinding: check.findings[0]} : {}),
		...(check.event_id ? {eventId: check.event_id} : {}),
		history,
	}
}

export function referenceFromPlan(
	id: string | undefined,
	plan: MilestonePlan | ChangeRequest | undefined,
): RoadmapDetailReference | null {
	if (!id) return null
	if (!plan) {
		return {
			id,
			title: 'missing',
			status: 'missing',
			label: `${id} (missing)`,
		}
	}
	return {
		id,
		title: plan.title,
		status: plan.status,
		label: `${id} - ${plan.title} (${plan.status})`,
	}
}

export function bypassSummary(state: LoadedState): ActiveRoadmapDetailSummary['bypass'] {
	const bypass = state.roadmap?.bypass
	if (!bypass?.active) return {active: false, label: 'inactive'}
	return {
		active: true,
		label: bypass.reason,
		reason: bypass.reason,
		requestedBy: bypass.requested_by,
	}
}

export function checkSummary(
	result: ValidationResult,
	status: RoadmapDetailCheck['status'],
): RoadmapDetailCheck {
	const errors = result.errors.map((issue) => issueSummary('error', issue))
	const warnings = result.warnings.map((issue) => issueSummary('warning', issue))
	return {
		valid: result.valid,
		status,
		errors,
		warnings,
		issues: [...errors, ...warnings],
	}
}

export function roadmapHealthSummary(
	state: LoadedState,
	qualityGate: RoadmapDetailQualityGate,
	validation: RoadmapDetailCheck,
	gate: RoadmapDetailCheck,
	openBlockerCount: number,
): RoadmapDetailHealth {
	const status = openBlockerCount > 0 || gate.errors.length > 0
		? 'blocked'
		: validation.status === 'invalid' || qualityGate.status !== 'passed'
			? 'attention'
			: 'healthy'
	return {
		status,
		label: `${status}; ${openBlockerCount} open blocker${openBlockerCount === 1 ? '' : 's'}`,
		activePhase: state.roadmap?.phase ?? 'none',
		validationStatus: validation.status,
		implementationGateStatus: gate.status,
		qualityGateStatus: qualityGate.status,
		openBlockerCount,
	}
}

export function issueSummary(severity: RoadmapDetailIssue['severity'], issue: ValidationIssue): RoadmapDetailIssue {
	return {
		severity,
		code: issue.code,
		message: issue.message,
		label: `${severity.toUpperCase()} ${issue.code}: ${issue.message}`,
		...(issue.path ? {path: issue.path} : {}),
	}
}

export function wavesSummary(context: PlanContext | undefined): RoadmapDetailWaves {
	const counts = {
		pending: 0,
		running: 0,
		reviewing: 0,
		blocked: 0,
		complete: 0,
	}
	if (!context) return {total: 0, counts, active: null}

	for (const wave of context.waves) counts[wave.status] += 1
	const activeWave = context.plan.progress.active_wave_id
		? context.waves.find((wave) => wave.id === context.plan.progress.active_wave_id)
		: undefined

	return {
		total: context.waves.length,
		counts,
		active: activeWave
			? {
				id: activeWave.id,
				status: activeWave.status,
				goal: activeWave.goal,
				label: `${activeWave.id} (${activeWave.status})`,
			}
			: null,
	}
}

export function activeTasksSummary(context: PlanContext | undefined): RoadmapDetailTask[] {
	if (!context) return []
	return context.plan.progress.active_task_ids.map((taskId) => {
		const task = context.tasks.find((candidate) => candidate.id === taskId)
		return taskDetail(taskId, task)
	})
}

export function taskDetail(taskId: string, task: TaskPlan | undefined): RoadmapDetailTask {
	return {
		id: taskId,
		worker: task?.worker ?? 'unknown',
		status: task?.status ?? 'missing',
		title: task?.title ?? taskId,
		label: task ? `${task.id} [${task.status}, ${task.worker}] ${task.title}` : `${taskId} (missing)`,
	}
}

export function activeExecutionSummary(
	context: PlanContext | undefined,
	waves: RoadmapDetailWaves,
	activeTasks: RoadmapDetailTask[],
): RoadmapDetailActiveExecution | null {
	if (!context) return null
	const taskCounts = {
		assigned: 0,
		started: 0,
		done: 0,
		blocked: 0,
	}
	for (const task of context.tasks) taskCounts[task.status] += 1
	return {
		activeWave: waves.active,
		progressStep: context.plan.progress.step,
		activeTasks,
		waveCounts: waves.counts,
		taskCounts,
	}
}

export function blockerSummary(context: PlanContext | undefined, canonicalBlockers: RoadmapBlocker[]): RoadmapDetailBlocker[] {
	const blockers: RoadmapDetailBlocker[] = []
	for (const blocker of canonicalBlockers) {
		if (blocker.status !== 'open') continue
		blockers.push({
			source: 'canonical',
			id: blocker.id,
			label: `Open ${blocker.severity} blocker ${blocker.id}`,
			message: blocker.title,
			status: blocker.status,
			severity: blocker.severity,
		})
	}

	if (!context) return blockers

	if (context.plan.progress.blocked_reason) {
		blockers.push({
			source: 'progress',
			label: 'Progress blocker',
			message: context.plan.progress.blocked_reason,
		})
	}

	for (const wave of context.waves) {
		if (wave.status !== 'blocked') continue
		blockers.push({
			source: 'wave',
			id: wave.id,
			label: `Blocked wave ${wave.id}`,
			message: wave.goal,
		})
	}

	for (const task of context.tasks) {
		if (task.status !== 'blocked') continue
		blockers.push({
			source: 'task',
			id: task.id,
			label: `Blocked task ${task.id}`,
			message: task.title,
		})
	}

	return blockers
}

export function canonicalBlockersSummary(blockers: RoadmapBlocker[]): RoadmapDetailCanonicalBlockers {
	const counts = {
		open: 0,
		resolved: 0,
		deferred: 0,
	}
	for (const blocker of blockers) counts[blocker.status] += 1
	return {
		counts,
		open: blockers.filter((blocker) => blocker.status === 'open').map(canonicalBlockerSummary),
	}
}

export function canonicalBlockerSummary(blocker: RoadmapBlocker): RoadmapDetailCanonicalBlocker {
	return {
		id: blocker.id,
		title: blocker.title,
		status: blocker.status,
		severity: blocker.severity,
		scope: {
			roadmapId: blocker.roadmap_id,
			...(blocker.milestone_id ? {milestoneId: blocker.milestone_id} : {}),
			...(blocker.change_request_id ? {changeRequestId: blocker.change_request_id} : {}),
			...(blocker.task_id ? {taskId: blocker.task_id} : {}),
			...(blocker.wave_id ? {waveId: blocker.wave_id} : {}),
		},
		label: `${blocker.id} ${blocker.severity}: ${blocker.title}`,
	}
}

export function eventSummary(event: RoadmapEvent): RoadmapDetailEvent {
	return {
		id: event.id,
		at: event.at,
		type: event.type,
		actor: event.actor,
		summary: event.summary,
		label: `${event.type} ${event.id}: ${event.summary}`,
	}
}

export function nextCommandSummary(next: NextActionPlan, state: LoadedState): RoadmapDetailNextCommand {
	const command = nextCommandForAction(next, state)
	return {
		command,
		description: next.description,
		label: `${command} - ${next.label}`,
	}
}

export function nextCommandForAction(next: NextActionPlan, state: LoadedState): string {
	const id = next.id
	if (id === 'roadmap:create') return '/roadmap:new <goal>'
	if (id.includes(':blockers:open') || next.blockers.length > 0) return '/blocker:list'
	if (id.includes('milestone-check')) return '/roadmap:new'
	if (id.includes('wave-flow-check')) return state.changeRequest ? '/change:request' : '/milestone:plan'
	if (id.startsWith('change:') && id.includes(':approve')) return '/change:request'
	if (id.startsWith('milestone:') && id.includes(':approve')) return '/milestone:plan'
	if (id.includes(':record-discovery') || id.startsWith('roadmap:') && id.includes(':approve')) return '/roadmap:new'
	if (id.includes(':start-milestone-planning') || id.includes(':start-next-milestone-planning')) return '/milestone:plan'
	if (id.includes(':start-implementation') || id.startsWith('progress:')) return '/milestone:implement'
	if (id.includes(':record-closeout') || id.includes(':start-closeout')) return '/milestone:close'
	if (id.startsWith('change:') && (id.includes(':review') || id.includes(':closed'))) return '/change:close'
	if (id.includes(':complete')) return '/change:request <requested change>'
	if (id.includes(':validation:')) return '/roadmap:status'
	return '/roadmap:resume'
}

export function usageSummary(
	usage: RoadmapUsageSummary | undefined,
	milestoneId: string | undefined,
	changeRequestId: string | undefined,
): RoadmapDetailUsage | null {
	if (!usage) return null

	const summary: RoadmapDetailUsage = {
		roadmap: usageTotalsSummary(usage.total),
		topAgents: topAgents(usage),
		topAgentsLabel: topAgentsLabel(usage),
	}

	if (milestoneId) {
		const milestone = usage.milestones[milestoneId]
		if (milestone) {
			summary.milestone = {
				id: milestoneId,
				totals: usageTotalsSummary(milestone.total),
				topAgents: topAgents(milestone),
				topAgentsLabel: topAgentsLabel(milestone),
			}
			if (changeRequestId) {
				const change = milestone.change_requests[changeRequestId]
				if (change) {
					summary.changeRequest = {
						id: changeRequestId,
						totals: usageTotalsSummary(change.total),
						topAgents: topAgents(change),
						topAgentsLabel: topAgentsLabel(change),
					}
				}
			}
		}
	}

	return summary
}

export function usageTotalsSummary(totals: UsageTotals): RoadmapDetailUsageTotals {
	return {
		raw: totals,
		label: formatUsage(totals),
		costLabel: formatUsd(totals),
		totalTokens: totalTokens(totals),
	}
}

export function topAgents(scope: UsageScopeSummary): RoadmapDetailUsageAgent[] {
	return Object.entries(scope.by_agent)
	.sort(([, left], [, right]) =>
		right.estimated_usd - left.estimated_usd ||
		totalTokens(right) - totalTokens(left),
	)
	.slice(0, 3)
	.map(([agent, totals]) => ({
		agent,
		totals: usageTotalsSummary(totals),
		label: `${agent}: ${formatUsage(totals)}`,
	}))
}

export function topAgentsLabel(scope: UsageScopeSummary): string {
	const agents = topAgents(scope)
	return agents.length > 0 ? agents.map((agent) => agent.label).join(' | ') : 'none'
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
