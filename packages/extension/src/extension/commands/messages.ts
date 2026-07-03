import type {ExtensionAPI, ExtensionCommandContext} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {loadTransportResumeAttempts} from 'oh-my-roadmap-core/project-init'
import {renderReport} from 'oh-my-roadmap-core/report/index'
import {COMMAND_MESSAGE_TYPE} from './catalog'
import {commandPrompt} from './prompts'

export async function sendCommandPrompt(api: ExtensionAPI, name: string, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const report = await renderReport(ctx.cwd)
	const transportResumeAttempts = await loadTransportResumeAttempts(ctx.cwd)
	queueCommandPrompt(api, ctx, commandPrompt(name, args, report, transportResumeAttempts))
}

export function queueCommandPrompt(api: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string): void {
	if (ctx.isIdle()) {
		api.sendUserMessage(prompt)
		return
	}
	api.sendUserMessage(prompt, {deliverAs: 'followUp'})
}

export function sendCommandMessage(api: ExtensionAPI, content: string): void {
	api.sendMessage({
		customType: COMMAND_MESSAGE_TYPE,
		content,
		display: true,
		attribution: 'agent',
	})
}
