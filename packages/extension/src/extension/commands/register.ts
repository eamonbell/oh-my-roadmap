import type {ExtensionAPI, ExtensionCommandContext} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {withDiagnosticTiming} from '@oh-my-roadmap/core/diagnostics'
import {COMMANDS, DETAILS_COMMAND, FINDINGS_CLEAR_COMMAND, USAGE_COMMAND} from './catalog'
import {showRoadmapDetails} from './details'
import {sendCommandMessage, sendCommandPrompt} from './messages'
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
