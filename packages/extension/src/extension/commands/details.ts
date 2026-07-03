import type {ExtensionAPI, ExtensionCommandContext} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {applyRoadmapDetailControl, buildAdhocDetailSummary, buildRoadmapDetailSummary} from 'oh-my-roadmap-core/roadmap-detail-summary/index'
import {withDiagnosticTiming} from 'oh-my-roadmap-core/diagnostics'
import {RoadmapDetailsView} from '../report-ui/index'
import {queueCommandPrompt, sendCommandMessage} from './messages'

export async function showRoadmapDetails(api: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const summary = await withDiagnosticTiming({
		component: 'command',
		operation: 'omr:rm-details.summary',
		cwd: ctx.cwd,
		slowMs: 1000,
	}, async () => await buildRoadmapDetailSummary(ctx.cwd))

	renderDetailsOverlay(api, ctx, summary)
}

// Ad-hoc plans have no applyable controls; render the same overlay read-only.
export async function showPlanDetails(api: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const summary = await withDiagnosticTiming({
		component: 'command',
		operation: 'omr:plan-details.summary',
		cwd: ctx.cwd,
		slowMs: 1000,
	}, async () => await buildAdhocDetailSummary(ctx.cwd))

	void ctx.ui
	.custom(
		(tui, _theme, _keybindings, done) => new RoadmapDetailsView(summary, tui, () => done(undefined)),
		{overlay: true},
	)
	.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error)
		sendCommandMessage(api, `omr:plan-details failed: ${message}`)
	})
}

function renderDetailsOverlay(api: ExtensionAPI, ctx: ExtensionCommandContext, summary: Awaited<ReturnType<typeof buildRoadmapDetailSummary>>): void {
	void ctx.ui
	.custom(
		(tui, _theme, _keybindings, done) => {
			const close = () => done(undefined)
			const view = new RoadmapDetailsView(summary, tui, close, (key, activeView) => {
				void withDiagnosticTiming({
					component: 'command',
					operation: 'omr:rm-details.control',
					cwd: ctx.cwd,
					slowMs: 1000,
					metadata: {control_key: key},
				}, async () => await applyRoadmapDetailControl(ctx.cwd, key))
				.then(async (result) => {
					if (result.action === 'applied_next_action') {
						sendCommandMessage(api, `Applied next action: ${result.result.plan.label}`)
						const refreshed = await buildRoadmapDetailSummary(ctx.cwd)
						activeView.setSummary(refreshed)
						activeView.showMessage(`Applied: ${result.result.plan.label}`)
					} else {
						queueCommandPrompt(api, ctx, result.prompt)
						close()
					}
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error)
					sendCommandMessage(api, `omr:rm-details control failed: ${message}`)
					activeView.showMessage(`Control failed: ${message}`)
				})
			})
			return view
		},
		{overlay: true},
	)
	.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error)
		sendCommandMessage(api, `omr:rm-details failed: ${message}`)
	})
}
