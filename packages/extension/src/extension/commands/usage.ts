import type {ExtensionAPI, ExtensionCommandContext} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {usageLines} from '@oh-my-roadmap/core/report/shared'
import {loadState} from '@oh-my-roadmap/core/store/index'
import type {RoadmapUsageSummary} from '@oh-my-roadmap/core/usage'
import {sendCommandMessage} from './messages'

export interface UsageCommandOptions {
	format: 'markdown' | 'json';
	exportPath?: string;
}

const FORMAT_TOKENS = new Set(['json', 'markdown', 'md'])

export function parseUsageArgs(args: string): UsageCommandOptions {
	const tokens = args.trim() ? args.trim().split(/\s+/) : []
	// Consume the first format keyword as the format flag; the first remaining token is the
	// export path. This way a path token that happens to equal a format word (e.g. a file
	// literally named "md") is still treated as a path once a format has been consumed.
	let format: 'markdown' | 'json' = 'markdown'
	let formatConsumed = false
	const rest: string[] = []
	for (const token of tokens) {
		const lower = token.toLowerCase()
		if (!formatConsumed && FORMAT_TOKENS.has(lower)) {
			format = lower === 'json' ? 'json' : 'markdown'
			formatConsumed = true
			continue
		}
		rest.push(token)
	}
	const exportPath = rest[0]
	return {format, ...(exportPath ? {exportPath} : {})}
}

export function renderUsageReport(
	usage: RoadmapUsageSummary,
	options: { format: 'markdown' | 'json'; milestoneId?: string; changeRequestId?: string },
): string {
	if (options.format === 'json') return JSON.stringify(usage, null, 2)
	const lines = usageLines(usage, options.milestoneId, options.changeRequestId)
	return [`# Roadmap usage: ${usage.roadmap_id}`, ...lines.map((line) => `- ${line}`)].join('\n')
}

export async function showRoadmapUsage(api: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const state = await loadState(ctx.cwd)
	if (!state.usage) {
		sendCommandMessage(api, 'No roadmap usage recorded yet.')
		return
	}
	const {format, exportPath} = parseUsageArgs(args)
	const content = renderUsageReport(state.usage, {
		format,
		...(state.active?.milestone_id ? {milestoneId: state.active.milestone_id} : {}),
		...(state.active?.change_request_id ? {changeRequestId: state.active.change_request_id} : {}),
	})
	if (exportPath) {
		const target = path.isAbsolute(exportPath) ? exportPath : path.join(ctx.cwd, exportPath)
		await fs.writeFile(target, `${content}\n`, 'utf8')
		sendCommandMessage(api, `Exported ${format} roadmap usage to ${target}.`)
		return
	}
	sendCommandMessage(api, content)
}
