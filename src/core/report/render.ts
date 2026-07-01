import {withDiagnosticTiming} from '../../diagnostics'
import {loadRoadmapBlockers, loadState} from '../store/index'
import {validateImplementationGate, validateRoadmapState} from '../validation'
import {nextAction} from './next-action'
import {progressLines, roadmapMilestoneCheckLabel, usageLines} from './shared'

async function renderReportImpl(cwd: string): Promise<string> {
	const state = await loadState(cwd)
	if (!state.active || !state.roadmap) {
		return 'No active roadmap. Run /roadmap:new to start a gated roadmap workflow.'
	}

	const validation = await validateRoadmapState(cwd)
	const gate = await validateImplementationGate(cwd)
	const blockers = await loadRoadmapBlockers(cwd, state.roadmap.roadmap_id)
	const openBlockers = blockers.filter((blocker) => blocker.status === 'open')
	const lines = [
		`# roadmap-engineer status`,
		``,
		`Roadmap: ${state.roadmap.roadmap_id} (${state.roadmap.title})`,
		`Phase: ${state.roadmap.phase}`,
		`Roadmap milestone check: ${roadmapMilestoneCheckLabel(state.roadmap)}`,
		`Active milestone: ${state.active.milestone_id ?? 'none'}`,
		`Active change request: ${state.active.change_request_id ?? 'none'}`,
		`Bypass: ${state.roadmap.bypass?.active ? state.roadmap.bypass.reason : 'inactive'}`,
		`Open blockers: ${openBlockers.length > 0 ? openBlockers.map((blocker) => `${blocker.id}:${blocker.severity}`).join(', ') : 'none'}`,
	]

	if (state.milestone) {
		lines.push(
			`Milestone status: ${state.milestone.status}`,
			`Waves: ${state.milestone.waves.map((wave) => `${wave.id}:${wave.status}`).join(', ') || 'none'}`,
			...progressLines('Milestone', state.milestone.progress, state.milestone.waves, state.milestone.tasks),
		)
	}
	if (state.changeRequest) {
		lines.push(
			`Change status: ${state.changeRequest.status}`,
			`Change waves: ${state.changeRequest.waves.map((wave) => `${wave.id}:${wave.status}`).join(', ') || 'none'}`,
			...progressLines('Change', state.changeRequest.progress, state.changeRequest.waves, state.changeRequest.tasks),
			`Change closeout: ${state.changeRequest.closeout?.status ?? 'not recorded'}`,
		)
	}
	if (state.closeout) lines.push(`Milestone closeout: ${state.closeout.status}`)
	lines.push(...usageLines(state.usage, state.active.milestone_id, state.active.change_request_id))

	lines.push(``, `Validation: ${validation.valid ? 'valid' : 'invalid'}`)

	for (const error of validation.errors) lines.push(`- ERROR ${error.code}: ${error.message}`)
	for (const warning of validation.warnings) lines.push(`- WARN ${warning.code}: ${warning.message}`)

	lines.push(``, `Implementation gate: ${gate.valid ? 'open' : 'closed'}`)
	for (const error of gate.errors) lines.push(`- ${error.message}`)
	lines.push(``, `Next action: ${await nextAction(cwd)}`)

	return lines.join('\n')
}

export async function renderReport(cwd: string): Promise<string> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'report.renderReport',
		cwd,
		slowMs: 250,
	}, async () => await renderReportImpl(cwd))
}
