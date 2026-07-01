import type {ExtensionAPI} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {initProject} from '../../core/project-init'
import {withDiagnosticTiming} from '../../diagnostics'
import {BLOCKER_COMMANDS, COMMANDS, DETAILS_COMMAND, INIT_COMMAND} from './catalog'
import {runBlockerCommand} from './blockers'
import {showRoadmapDetails} from './details'
import {sendCommandMessage, sendCommandPrompt} from './messages'

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
					if (BLOCKER_COMMANDS.has(name) && await runBlockerCommand(api, name, args, ctx)) return
					await sendCommandPrompt(api, name, args, ctx)
				})
			},
		})
	}
}
