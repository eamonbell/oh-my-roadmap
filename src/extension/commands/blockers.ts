import type {ExtensionAPI, ExtensionCommandContext} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {deferBlocker, listBlockers, resolveBlocker} from '../../core/store/index'
import type {RoadmapBlocker} from '../../core/types'
import {validateRoadmapState} from '../../core/validation'
import {BLOCKER_COMMAND_REPORT_DELAY_MS} from './catalog'
import {sendCommandMessage} from './messages'

function sendBlockerCommandMessage(api: ExtensionAPI, content: string): void {
	setTimeout(() => sendCommandMessage(api, content), BLOCKER_COMMAND_REPORT_DELAY_MS)
}

function blockerScope(blocker: RoadmapBlocker): string {
	return [
		blocker.roadmap_id ? `roadmap=${blocker.roadmap_id}` : undefined,
		blocker.milestone_id ? `milestone=${blocker.milestone_id}` : undefined,
		blocker.change_request_id ? `change=${blocker.change_request_id}` : undefined,
		blocker.task_id ? `task=${blocker.task_id}` : undefined,
		blocker.wave_id ? `wave=${blocker.wave_id}` : undefined,
	].filter(Boolean).join(', ') || 'project'
}

function blockerLine(blocker: RoadmapBlocker): string {
	return `- ${blocker.id}: ${blocker.title} (${blocker.severity}, ${blocker.status}, ${blockerScope(blocker)}) - ${blocker.description}`
}

function blockerRecoveryCommands(): string {
	return [
		'Recovery commands:',
		'```text',
		'/blocker:resolve <id> <resolution>',
		'/blocker:defer <id> <reason>',
		'/roadmap:resume',
		'```',
	].join('\n')
}

async function reportOpenBlockers(api: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const result = await listBlockers(ctx.cwd, {status: 'open'})
	if (result.blockers.length === 0) {
		sendBlockerCommandMessage(api, `No open blockers.\n\n${blockerRecoveryCommands()}`)
		return
	}
	sendBlockerCommandMessage(api, `Open blockers:\n${result.blockers.map(blockerLine).join('\n')}\n\n${blockerRecoveryCommands()}`)
}

function splitBlockerActionArgs(args: string, valueLabel: string): { blockerId?: string; value?: string; error?: string } {
	const trimmed = args.trim()
	if (!trimmed) return {error: `Missing blocker ID and ${valueLabel}.`}
	const firstSpace = trimmed.search(/\s/)
	if (firstSpace === -1) return {blockerId: trimmed, error: `Missing ${valueLabel}.`}
	const blockerId = trimmed.slice(0, firstSpace).trim()
	const value = trimmed.slice(firstSpace + 1).trim()
	if (!blockerId || !value) return {blockerId, value, error: `Missing blocker ID or ${valueLabel}.`}
	return {blockerId, value}
}

async function validateSummary(cwd: string): Promise<string> {
	const validation = await validateRoadmapState(cwd)
	if (validation.valid) return 'Validation: passed.'
	return `Validation: ${validation.errors.length} error(s).\n${validation.errors.map(error => `- ${error.code}: ${error.message}`).join('\n')}`
}

async function resolveBlockerCommand(api: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = splitBlockerActionArgs(args, 'resolution')
	if (parsed.error || !parsed.blockerId || !parsed.value) {
		const result = await listBlockers(ctx.cwd, {status: 'open'})
		sendBlockerCommandMessage(
			api,
			`${parsed.error}\n\nOpen blockers:\n${result.blockers.length > 0 ? result.blockers.map(blockerLine).join('\n') : '(none)'}\n\nUsage: /blocker:resolve <id> <resolution>`,
		)
		return
	}
	const blocker = await resolveBlocker(ctx.cwd, {blockerId: parsed.blockerId, resolution: parsed.value})
	sendBlockerCommandMessage(api, `Resolved blocker:\n${blockerLine(blocker)}\n\n${await validateSummary(ctx.cwd)}\n\nRun /roadmap:resume to continue.`)
}

async function deferBlockerCommand(api: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = splitBlockerActionArgs(args, 'defer reason')
	if (parsed.error || !parsed.blockerId || !parsed.value) {
		const result = await listBlockers(ctx.cwd, {status: 'open'})
		sendBlockerCommandMessage(
			api,
			`${parsed.error}\n\nOpen blockers:\n${result.blockers.length > 0 ? result.blockers.map(blockerLine).join('\n') : '(none)'}\n\nUsage: /blocker:defer <id> <reason>`,
		)
		return
	}
	const blocker = await deferBlocker(ctx.cwd, {blockerId: parsed.blockerId, deferReason: parsed.value})
	sendBlockerCommandMessage(api, `Deferred blocker:\n${blockerLine(blocker)}\n\n${await validateSummary(ctx.cwd)}\n\nRun /roadmap:resume to continue.`)
}

export async function runBlockerCommand(api: ExtensionAPI, name: string, args: string, ctx: ExtensionCommandContext): Promise<boolean> {
	if (name === 'blocker:list' || name === 'blocker:status') {
		await reportOpenBlockers(api, ctx)
		return true
	}
	if (name === 'blocker:resolve') {
		await resolveBlockerCommand(api, args, ctx)
		return true
	}
	if (name === 'blocker:defer') {
		await deferBlockerCommand(api, args, ctx)
		return true
	}
	return false
}
