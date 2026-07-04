import type {ExtensionAPI, ExtensionCommandContext} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {loadTransportResumeAttempts} from '@oh-my-roadmap/core/project-init'
import {renderReport} from '@oh-my-roadmap/core/report/index'
import {clearActivePauseMarkers, loadActive} from '@oh-my-roadmap/core/store/index'
import {COMMAND_MESSAGE_TYPE} from './catalog'
import {commandPrompt} from './prompts'

// When a paused roadmap is resumed, surface a one-time drift check and clear the markers.
async function resumeDriftNote(name: string, cwd: string): Promise<string> {
	if (name !== 'omr:rm-resume') return ''
	const active = await loadActive(cwd)
	if (!active?.paused_at) return ''
	const reenabled = active.resumed_at ? ` and re-enabled (at ${active.resumed_at})` : ''
	await clearActivePauseMarkers(cwd)
	return `\nThis roadmap was paused (at ${active.paused_at})${reenabled} via the omr lockout. Before doing any roadmap work, inspect the codebase and recent changes for anything done while paused that affects the active plan (moved, renamed, or edited files, changed APIs, or new work). If you find material drift, stop and resolve it with the user using the built-in ask tool before continuing.`
}

export async function sendCommandPrompt(api: ExtensionAPI, name: string, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const report = await renderReport(ctx.cwd)
	const transportResumeAttempts = await loadTransportResumeAttempts(ctx.cwd)
	const resumeNote = await resumeDriftNote(name, ctx.cwd)
	queueCommandPrompt(api, ctx, commandPrompt(name, args, report, transportResumeAttempts, resumeNote))
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
