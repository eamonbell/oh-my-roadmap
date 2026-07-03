import type {
	ActiveRoadmapDetailSummary,
	RoadmapDetailBlocker,
	RoadmapDetailControl,
	RoadmapDetailEvent,
	RoadmapDetailIssue,
	RoadmapDetailMilestone,
	RoadmapDetailPlanWave,
	RoadmapDetailTask,
	RoadmapDetailUsageAgent,
	RoadmapDetailUsageTotals,
} from 'oh-my-roadmap-core/roadmap-detail-summary/index'
import {arrowLines, bulletLines, keyValueLines, s, sectionHeader, styleValue, wrapWords} from './text'
import type {TabName} from './types'

export function renderTabContent(summary: ActiveRoadmapDetailSummary, tab: TabName, contentWidth: number): string[] {
	switch (tab) {
		case 'Overview':
			return renderOverviewTab(summary, contentWidth)
		case 'Plan':
			return renderPlanTab(summary, contentWidth)
		case 'Gates':
			return renderGatesTab(summary, contentWidth)
		case 'Usage':
			return renderUsageTab(summary, contentWidth)
		case 'Activity':
			return renderActivityTab(summary, contentWidth)
	}
}

function renderOverviewTab(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
	return [
		sectionHeader('Next Command'),
		...arrowLines(summary.nextCommand.label, contentWidth),
		...wrapWords(summary.nextCommand.description, contentWidth),
		'',
		sectionHeader('Next Action'),
		...keyValueLines('Status', summary.nextAction.status, contentWidth),
		...keyValueLines('Safe', summary.nextAction.safe_to_apply ? 'yes' : 'no', contentWidth),
		...(summary.nextAction.blockers.length > 0 ? keyValueLines('Blockers', summary.nextAction.blockers.join('; '), contentWidth) : []),
		...(summary.nextAction.missing_inputs.length > 0 ? keyValueLines('Missing', summary.nextAction.missing_inputs.join('; '), contentWidth) : []),
		'',
		sectionHeader('Context'),
		...keyValueLines('Roadmap', summary.roadmap.label, contentWidth),
		...keyValueLines('Milestone', summary.active.milestone?.label ?? 'none', contentWidth),
		...keyValueLines('Change', summary.active.changeRequest?.label ?? 'none', contentWidth),
		...keyValueLines('Bypass', summary.bypass.label, contentWidth),
		'',
		sectionHeader('Active Work'),
		...renderActiveWork(summary, contentWidth),
		'',
		sectionHeader('Actions'),
		...renderControls(summary.availableControls, contentWidth),
	]
}

function renderPlanTab(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
	if (summary.milestones.length === 0) return [`${s.dim}No roadmap milestones recorded.${s.reset}`]
	return summary.milestones.flatMap((milestone, index) => [
		...(index === 0 ? [] : ['']),
		...milestoneLines(milestone, contentWidth),
	])
}

function milestoneLines(milestone: RoadmapDetailMilestone, contentWidth: number): string[] {
	const lines = [
		`${s.bold}${milestone.id}${s.reset} ${styleValue(milestone.status)} ${milestone.title}`,
	]

	if (milestone.detail === 'outline') {
		lines.push(`${s.dim}outline only; run /omr:ms-plan when this milestone is active${s.reset}`)
		return lines
	}

	if (milestone.waves.length === 0) {
		lines.push(`${s.dim}No waves recorded.${s.reset}`)
		return lines
	}

	for (const wave of milestone.waves) {
		lines.push(...waveLines(wave, contentWidth))
	}

	return lines
}

function waveLines(wave: RoadmapDetailPlanWave, contentWidth: number): string[] {
	const lines = bulletLines(`${wave.id} [${wave.status}] ${wave.goal}`, contentWidth, s.cyan)
	if (wave.tasks.length === 0) {
		lines.push(`  ${s.dim}No tasks recorded.${s.reset}`)
		return lines
	}
	lines.push(...wave.tasks.flatMap((task) => taskLines(task, Math.max(1, contentWidth - 2)).map((line) => `  ${line}`)))
	return lines
}

function renderGatesTab(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
	return [
		sectionHeader('Quality Gate'),
		...renderQualityGate(summary, contentWidth),
		'',
		sectionHeader('Validation'),
		...keyValueLines('Status', summary.validation.status, contentWidth),
		'',
		sectionHeader('Implementation Gate'),
		...keyValueLines('Status', summary.gate.status, contentWidth),
		'',
		sectionHeader('Blockers'),
		...renderCanonicalBlockers(summary, contentWidth),
		'',
		sectionHeader('Issues'),
		...renderIssues(summary, contentWidth),
	]
}

function renderUsageTab(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
	if (!summary.usage) return [`${s.dim}No usage recorded.${s.reset}`]
	const scopes = [
		{label: 'Roadmap', totals: summary.usage.roadmap, agents: summary.usage.topAgents},
		...(summary.usage.milestone ? [{
			label: `Milestone ${summary.usage.milestone.id}`,
			totals: summary.usage.milestone.totals,
			agents: summary.usage.milestone.topAgents
		}] : []),
		...(summary.usage.changeRequest ? [{
			label: `Change ${summary.usage.changeRequest.id}`,
			totals: summary.usage.changeRequest.totals,
			agents: summary.usage.changeRequest.topAgents
		}] : []),
	]

	return scopes.flatMap((scope, index) => [
		...(index === 0 ? [] : ['']),
		`${s.bold}${scope.label}${s.reset}`,
		...usageTotalsLines(scope.totals, contentWidth),
		...usageAgentLines(scope.agents, contentWidth),
	])
}

function renderActivityTab(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
	return [
		sectionHeader('Recent Events'),
		...renderEvents(summary.recentEvents, contentWidth),
		'',
		sectionHeader('Metadata'),
		...keyValueLines('Roadmap', summary.roadmap.label, contentWidth),
		...keyValueLines('Active milestone', summary.active.milestone?.label ?? 'none', contentWidth),
		...keyValueLines('Active change', summary.active.changeRequest?.label ?? 'none', contentWidth),
		...keyValueLines('Bypass', summary.bypass.label, contentWidth),
	]
}

function renderActiveWork(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
	const lines = [
		...keyValueLines('Active wave', summary.waves.active?.label ?? 'none', contentWidth),
		...keyValueLines('Progress', summary.activeExecution?.progressStep ?? 'none', contentWidth),
		...keyValueLines('Wave counts', waveCountsLabel(summary), contentWidth),
		...keyValueLines('Task counts', taskCountsLabel(summary), contentWidth),
		...keyValueLines('Blockers', summary.blockers.length > 0 ? String(summary.blockers.length) : 'none', contentWidth),
	]

	if (summary.activeTasks.length === 0) {
		lines.push(`${s.dim}No active tasks.${s.reset}`)
	} else {
		lines.push(`${s.dim}Active tasks${s.reset}`)
		lines.push(...summary.activeTasks.flatMap((task) => taskLines(task, contentWidth)))
	}

	if (summary.blockers.length > 0) {
		lines.push(`${s.dim}Blockers${s.reset}`)
		lines.push(...summary.blockers.flatMap((blocker) => blockerLines(blocker, contentWidth)))
	}

	return lines
}

function renderQualityGate(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
	const gate = summary.qualityGate
	const lines = [
		...keyValueLines('Status', gate.status, contentWidth),
		...keyValueLines('Revision', `${gate.checkedRevision}/${gate.roadmapRevision}`, contentWidth),
		...keyValueLines('Event', gate.eventId ?? 'none', contentWidth),
	]

	if (gate.latestFinding) lines.push(...keyValueLines('Finding', gate.latestFinding, contentWidth))
	if (gate.history.length > 0) {
		lines.push(`${s.dim}History${s.reset}`)
		lines.push(...gate.history.flatMap((event) => eventLines(event, contentWidth)))
	}

	return lines
}

function renderControls(controls: RoadmapDetailControl[], contentWidth: number): string[] {
	if (controls.length === 0) return [`${s.dim}No controls available.${s.reset}`]
	return controls.flatMap((control) => {
		const status = control.enabled ? 'enabled' : `disabled: ${control.reason ?? 'unavailable'}`
		return bulletLines(`[${control.key}] ${control.label} (${status})`, contentWidth, control.enabled ? s.cyan : s.dim)
	})
}

function renderCanonicalBlockers(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
	const counts = summary.canonicalBlockers.counts
	const lines = [
		...keyValueLines('Counts', `open ${counts.open}, resolved ${counts.resolved}, deferred ${counts.deferred}`, contentWidth),
	]
	if (summary.canonicalBlockers.open.length === 0) {
		lines.push(`${s.green}ok${s.reset} No open canonical blockers.`)
		return lines
	}
	lines.push(...summary.canonicalBlockers.open.flatMap((blocker) =>
		bulletLines(`${blocker.label}; scope ${JSON.stringify(blocker.scope)}`, contentWidth, s.red)
	))
	return lines
}

function renderEvents(events: RoadmapDetailEvent[], contentWidth: number): string[] {
	if (events.length === 0) return [`${s.dim}No recent events.${s.reset}`]
	return events.flatMap((event) => eventLines(event, contentWidth))
}

function eventLines(event: RoadmapDetailEvent, contentWidth: number): string[] {
	return bulletLines(`${event.at} ${event.type} ${event.id}: ${event.summary}`, contentWidth, s.dim)
}

function renderIssues(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
	const issues: RoadmapDetailIssue[] = [
		...summary.validation.issues,
		...summary.gate.issues,
	]

	if (issues.length === 0) return [`${s.green}ok${s.reset} No validation or gate issues.`]

	return issues.flatMap((issue) => {
		const tone = issue.severity === 'warning' ? s.yellow : s.red
		const icon = issue.severity === 'warning' ? '!' : 'x'
		return wrapWords(`${issue.code}: ${issue.message}`, Math.max(1, contentWidth - 2)).map((line, index) =>
			`${index === 0 ? `${tone}${icon}${s.reset} ` : '  '}${tone}${line}${s.reset}`,
		)
	})
}

function usageTotalsLines(totals: RoadmapDetailUsageTotals, contentWidth: number): string[] {
	return [
		...keyValueLines('Cost', totals.costLabel, contentWidth),
		...keyValueLines('Requests', String(totals.raw.requests), contentWidth),
		...keyValueLines('Tokens', String(totals.totalTokens), contentWidth),
		...keyValueLines('Input', String(totals.raw.input_tokens), contentWidth),
		...keyValueLines('Output', String(totals.raw.output_tokens), contentWidth),
		...keyValueLines('Cache', `${totals.raw.cache_read_tokens} read / ${totals.raw.cache_write_tokens} write`, contentWidth),
		...keyValueLines('Reasoning', String(totals.raw.reasoning_tokens), contentWidth),
	]
}

function usageAgentLines(agents: RoadmapDetailUsageAgent[], contentWidth: number): string[] {
	if (agents.length === 0) return [`${s.dim}Top agents: none${s.reset}`]
	return [
		`${s.dim}Top agents${s.reset}`,
		...agents.flatMap((agent) => bulletLines(agent.label, contentWidth, s.dim)),
	]
}

function taskLines(task: RoadmapDetailTask, contentWidth: number): string[] {
	return bulletLines(`${task.id} [${task.status}, ${task.worker}] ${task.title}`, contentWidth, s.cyan)
}

function blockerLines(blocker: RoadmapDetailBlocker, contentWidth: number): string[] {
	return bulletLines(`${blocker.label}: ${blocker.message}`, contentWidth, s.red)
}

export function issueCountLabel(summary: ActiveRoadmapDetailSummary): string {
	const errors = summary.validation.errors.length + summary.gate.errors.length
	const warnings = summary.validation.warnings.length + summary.gate.warnings.length
	return `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`
}

function waveCountsLabel(summary: ActiveRoadmapDetailSummary): string {
	const {counts, total} = summary.waves
	if (total === 0) return 'none'
	return [
		`pending ${counts.pending}`,
		`running ${counts.running}`,
		`reviewing ${counts.reviewing}`,
		`blocked ${counts.blocked}`,
		`complete ${counts.complete}`,
	].join(', ')
}

function taskCountsLabel(summary: ActiveRoadmapDetailSummary): string {
	const counts = summary.activeExecution?.taskCounts
	if (!counts) return 'none'
	return [
		`assigned ${counts.assigned}`,
		`started ${counts.started}`,
		`done ${counts.done}`,
		`blocked ${counts.blocked}`,
	].join(', ')
}
