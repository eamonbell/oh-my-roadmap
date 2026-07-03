import type {ExtensionAPI, ExtensionCommandContext} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {withDiagnosticTiming} from 'oh-my-roadmap-core/diagnostics'
import {setProjectDisabled} from 'oh-my-roadmap-core/project-init'
import {loadState, markActivePaused, markActiveResumed, nowIso} from 'oh-my-roadmap-core/store/index'
import {ADHOC_COMMANDS, COMMANDS, DETAILS_COMMAND, DISABLE_COMMAND, ENABLE_COMMAND, FINDINGS_CLEAR_COMMAND, LEARN_STYLE_COMMAND, PLAN_DETAILS_COMMAND, USAGE_COMMAND} from './catalog'
import {showPlanDetails, showRoadmapDetails} from './details'
import {adhocCommandPrompt, learnStylePrompt} from './prompts'
import {queueCommandPrompt, sendCommandMessage, sendCommandPrompt} from './messages'

async function adhocSummary(cwd: string): Promise<string> {
	const state = await loadState(cwd)
	const plan = state.adhoc
	if (!plan) return '(no active ad-hoc plan)'
	const done = plan.tasks.filter((task) => task.status === 'done').length
	return [
		`${plan.adhoc_id} — ${plan.title}`,
		`Status: ${plan.status}; wave-flow-check: ${plan.wave_flow_check.status}`,
		`Tasks ${done}/${plan.tasks.length} done across ${plan.waves.length} wave(s); step ${plan.progress.step}`,
	].join('\n')
}
import {showRoadmapUsage} from './usage'
import {clearFindingsReportTile} from '../../findings.ts'
import {AutocompleteItem} from '@oh-my-pi/pi-tui'

import type {CustomCommandAPI} from '@oh-my-pi/pi-coding-agent'


export function registerRoadmapCommands(api: ExtensionAPI): void {
	api.registerCommand(DETAILS_COMMAND, {
		description: 'View current roadmap state without prompting the model',
		handler: async (_args, ctx) => {
			await withDiagnosticTiming({
				component: 'command',
				operation: DETAILS_COMMAND,
				cwd: ctx.cwd,
				slowMs: 1000,
			}, async () => {
				await showRoadmapDetails(api, ctx)
			})
		},
	})

	api.registerCommand(PLAN_DETAILS_COMMAND, {
		description: 'View the active ad-hoc plan state without prompting the model',
		handler: async (_args, ctx) => {
			await withDiagnosticTiming({
				component: 'command',
				operation: PLAN_DETAILS_COMMAND,
				cwd: ctx.cwd,
				slowMs: 1000,
			}, async () => {
				await showPlanDetails(api, ctx)
			})
		},
	})

	api.registerCommand(USAGE_COMMAND, {
		description: 'Report roadmap usage totals without prompting the model (append "json" and/or an export path)',
		handler: async (args, ctx) => {
			await withDiagnosticTiming({
				component: 'command',
				operation: USAGE_COMMAND,
				cwd: ctx.cwd,
				slowMs: 1000,
			}, async () => {
				try {
					await showRoadmapUsage(api, ctx, args)
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					sendCommandMessage(api, `omr:rm-usage failed: ${message}`)
					throw error
				}
			})
		},
	})

	api.registerCommand(FINDINGS_CLEAR_COMMAND, {
		description: 'Clear the active findings report tile',
		handler: async (_args, ctx) => {
			await withDiagnosticTiming({
				component: 'command',
				operation: FINDINGS_CLEAR_COMMAND,
				cwd: ctx.cwd,
				slowMs: 1000,
			}, async () => {
				const cleared = clearFindingsReportTile(ctx)
				sendCommandMessage(
					api,
					cleared
						? 'Findings report tile cleared.'
						: 'Findings report tile not cleared: UI unavailable.',
				)
			})
		},
	})

	api.registerCommand(DISABLE_COMMAND, {
		description: 'Pause oh-my-roadmap: block omr tools and agents until re-enabled',
		handler: async (_args, ctx) => {
			await withDiagnosticTiming({
				component: 'command',
				operation: DISABLE_COMMAND,
				cwd: ctx.cwd,
				slowMs: 1000,
			}, async () => {
				await setProjectDisabled(ctx.cwd, true)
				const paused = await markActivePaused(ctx.cwd, nowIso())
				sendCommandMessage(
					api,
					paused
						? 'oh-my-roadmap paused. The active roadmap is marked paused and omr tools/agents are blocked. Run /omr:enable to resume.'
						: 'oh-my-roadmap paused. omr tools and agents are blocked. Run /omr:enable to resume.',
				)
			})
		},
	})

	api.registerCommand(ENABLE_COMMAND, {
		description: 'Resume oh-my-roadmap after a pause',
		handler: async (_args, ctx) => {
			await withDiagnosticTiming({
				component: 'command',
				operation: ENABLE_COMMAND,
				cwd: ctx.cwd,
				slowMs: 1000,
			}, async () => {
				await setProjectDisabled(ctx.cwd, false)
				const resumed = await markActiveResumed(ctx.cwd, nowIso())
				sendCommandMessage(
					api,
					resumed
						? 'oh-my-roadmap enabled. Before resuming roadmap work, inspect the codebase for changes made while paused and resolve any that affect the plan with the user. Run /omr:rm-resume to continue.'
						: 'oh-my-roadmap enabled.',
				)
			})
		},
	})

	api.registerCommand(LEARN_STYLE_COMMAND, {
		description: 'Learn this codebase\'s per-language code style into .omr/config.yml',
		handler: async (args, ctx) => {
			await withDiagnosticTiming({
				component: 'command',
				operation: LEARN_STYLE_COMMAND,
				cwd: ctx.cwd,
				slowMs: 1000,
			}, async () => {
				queueCommandPrompt(api, ctx, learnStylePrompt(args))
			})
		},
	})

	for (const [name, description] of ADHOC_COMMANDS) {
		api.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				await withDiagnosticTiming({
					component: 'command',
					operation: name,
					cwd: ctx.cwd,
					slowMs: 1000,
				}, async () => {
					const summary = await adhocSummary(ctx.cwd)
					queueCommandPrompt(api, ctx, adhocCommandPrompt(name, args, summary))
				})
			},
		})
	}

	for (const [name, description] of COMMANDS) {
		api.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				await withDiagnosticTiming({
					component: 'command',
					operation: name,
					cwd: ctx.cwd,
					slowMs: 1000,
				}, async () => {
					await sendCommandPrompt(api, name, args, ctx)
				})
			},
		})
	}
}
