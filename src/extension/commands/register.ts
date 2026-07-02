import type {ExtensionAPI, ExtensionCommandContext} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {initProject} from '../../core/project-init'
import {withDiagnosticTiming} from '../../diagnostics'
import {COMMANDS, DETAILS_COMMAND, FINDINGS_CLEAR_COMMAND, INIT_COMMAND} from './catalog'
import {showRoadmapDetails} from './details'
import {sendCommandMessage, sendCommandPrompt} from './messages'
import {clearFindingsReportTile} from '../../core/findings.ts'
import {AutocompleteItem} from '@oh-my-pi/pi-tui'

import type {CustomCommandAPI} from '@oh-my-pi/pi-coding-agent'


export function registerRoadmapCommands(api: ExtensionAPI): void {
	api.registerCommand(INIT_COMMAND, {
		description: 'Scaffold roadmap-engineer project config and local generated agents',
		handler: async (_args, ctx) => {
			await withDiagnosticTiming({
				component: 'command',
				operation: INIT_COMMAND,
				cwd: ctx.cwd,
				slowMs: 1000,
			}, async () => {
				try {
					const result = await initProject(ctx.cwd)
					sendCommandMessage(
						api,
						`Initialized roadmap-engineer project files: ${result.configPath}, ${Object.values(result.agentPaths).join(', ')}`,
					)
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					sendCommandMessage(api, `roadmap:init failed: ${message}`)
					throw error
				}
			})
		},
	})

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
