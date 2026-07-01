import type {ExtensionAPI, ExtensionCommandContext} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {renderReport} from '../../core/report/index'
import {COMMAND_MESSAGE_TYPE} from './catalog'
import {commandPrompt} from './prompts'

export async function sendCommandPrompt(api: ExtensionAPI, name: string, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const report = await renderReport(ctx.cwd)
	queueCommandPrompt(api, ctx, commandPrompt(name, args, report))
}

export function queueCommandPrompt(api: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string): void {
	api.sendUserMessage(prompt, {
		deliverAs: ctx.isIdle() ? 'steer' : 'followUp',
	})
}

export function sendCommandMessage(api: ExtensionAPI, content: string): void {
	api.sendMessage({
		customType: COMMAND_MESSAGE_TYPE,
		content,
		display: true,
		attribution: 'agent',
	})
}
