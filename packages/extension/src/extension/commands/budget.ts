import type { ExtensionAPI, ExtensionCommandContext } from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {
	parseCost,
	parseTimeDuration,
	parseTokenCount,
} from '@oh-my-roadmap/core/budget'
import type { BudgetDimension } from '@oh-my-roadmap/core/budget'
import {
	applyBudgetRaiseCeiling,
	grantBudgetOneShot,
	setActiveBudgetCeiling,
} from '@oh-my-roadmap/core/enforcement'
import type { BudgetScope } from '@oh-my-roadmap/core/enforcement'
import { formatBudgetSummaryLines, loadBudgetSummary } from '@oh-my-roadmap/core/budget-report'
import { sendCommandMessage } from './messages'

const BUDGET_SCOPES = new Set<BudgetScope>(['roadmap', 'milestone'])
const BUDGET_DIMENSIONS = new Set<BudgetDimension>(['tokens', 'cost', 'time'])

export interface BudgetSetArgs {
	scope: BudgetScope
	dimension: BudgetDimension
	value: string
}

export interface BudgetOverrideArgs {
	type: 'raise' | 'one-shot'
	scope: BudgetScope
	dimension?: BudgetDimension
	value?: number
	grantedBy: string
	reason: string
}

function usage(message: string): Error {
	return new Error(message)
}

function parseScope(value: string): BudgetScope {
	if (BUDGET_SCOPES.has(value as BudgetScope)) return value as BudgetScope
	throw usage(`Invalid budget scope "${value}"; expected roadmap or milestone.`)
}

function parseDimension(value: string): BudgetDimension {
	if (BUDGET_DIMENSIONS.has(value as BudgetDimension)) return value as BudgetDimension
	throw usage(`Invalid budget dimension "${value}"; expected tokens, cost, or time.`)
}

function parseBudgetValue(dimension: BudgetDimension, value: string): number | undefined {
	if (value === 'unlimited') return undefined
	switch (dimension) {
		case 'tokens':
			return parseTokenCount(value)
		case 'cost':
			return parseCost(value)
		case 'time':
			return parseTimeDuration(value)
	}
}

function splitRequired(args: string, count: number): { tokens: string[]; rest: string } {
	const trimmed = args.trim()
	if (!trimmed) return { tokens: [], rest: '' }
	const tokens: string[] = []
	let rest = trimmed
	while (tokens.length < count && rest) {
		const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest)
		if (!match) break
		tokens.push(match[1]!)
		rest = match[2] ?? ''
	}
	return { tokens, rest }
}

function hasOptionToken(value: string): boolean {
	return /(?:^|\s)--\S+/.test(value)
}

function parseActorAndReason(rest: string): Pick<BudgetOverrideArgs, 'grantedBy' | 'reason'> {
	const trimmed = rest.trim()
	if (!trimmed) {
		throw usage('A non-empty override reason is required.')
	}
	if (trimmed === '--by' || trimmed.startsWith('--by ')) {
		const match = /^--by\s+(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
		if (!match) {
			throw usage('The --by option requires an actor followed by a non-empty override reason.')
		}
		const actor = match[1]!
		if (actor.startsWith('--')) {
			throw usage('The --by option requires a non-option actor name.')
		}
		const reason = match[2]?.trim()
		if (!reason) {
			throw usage('A non-empty override reason is required after --by <actor>.')
		}
		if (hasOptionToken(reason)) {
			throw usage('Unknown override option. Only --by <actor> is supported before the reason.')
		}
		return { grantedBy: actor, reason }
	}
	if (hasOptionToken(trimmed)) {
		throw usage('Unknown override option. Only --by <actor> is supported before the reason.')
	}
	return { grantedBy: 'user', reason: trimmed }
}

export function parseBudgetShowArgs(args: string): BudgetScope | undefined {
	const tokens = args.trim() ? args.trim().split(/\s+/) : []
	if (tokens.length === 0) return undefined
	if (tokens.length !== 1) {
		throw usage('Usage: /omr:budget-show [roadmap|milestone].')
	}
	return parseScope(tokens[0]!)
}

export function parseBudgetSetArgs(args: string): BudgetSetArgs {
	const tokens = args.trim() ? args.trim().split(/\s+/) : []
	if (tokens.length !== 3) {
		throw usage('Usage: /omr:budget-set <roadmap|milestone> <tokens|cost|time> <value|unlimited>.')
	}
	const scope = parseScope(tokens[0]!)
	const dimension = parseDimension(tokens[1]!)
	const value = tokens[2]!
	parseBudgetValue(dimension, value)
	return { scope, dimension, value }
}

export function parseBudgetOverrideArgs(args: string): BudgetOverrideArgs {
	const action = splitRequired(args, 1)
	const type = action.tokens[0]
	if (type !== 'raise' && type !== 'one-shot') {
		throw usage('Usage: /omr:budget-override <raise|one-shot> <roadmap|milestone> [dimension value] [--by <actor>] <reason>.')
	}
	const required = splitRequired(action.rest, type === 'raise' ? 3 : 1)
	if (required.tokens.length !== (type === 'raise' ? 3 : 1)) {
		throw usage(type === 'raise'
			? 'Usage: /omr:budget-override raise <roadmap|milestone> <tokens|cost|time> <value> [--by <actor>] <reason>.'
			: 'Usage: /omr:budget-override one-shot <roadmap|milestone> [--by <actor>] <reason>.')
	}
	const scope = parseScope(required.tokens[0]!)
	const { grantedBy, reason } = parseActorAndReason(required.rest)
	if (type === 'one-shot') return { type, scope, grantedBy, reason }

	const dimension = parseDimension(required.tokens[1]!)
	const valueToken = required.tokens[2]!
	if (valueToken === 'unlimited') {
		throw usage('A raise override requires a finite budget value; unlimited is only valid for /omr:budget-set.')
	}
	const value = parseBudgetValue(dimension, valueToken)
	if (value === undefined) throw usage('A raise override requires a finite budget value.')
	return { type, scope, dimension, value, grantedBy, reason }
}

async function summaryLines(cwd: string, scope?: BudgetScope): Promise<string[]> {
	return formatBudgetSummaryLines(
		await loadBudgetSummary(cwd),
		scope ? { scopes: [scope] } : {},
	)
}

function formattedSummary(lines: string[]): string {
	return lines.length > 0 ? lines.join('\n') : 'No active budget ceilings or overrides.'
}

export async function showBudget(api: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const scope = parseBudgetShowArgs(args)
	sendCommandMessage(api, formattedSummary(await summaryLines(ctx.cwd, scope)))
}

export async function setBudget(api: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const command = parseBudgetSetArgs(args)
	const result = await setActiveBudgetCeiling(ctx.cwd, command.scope, command.dimension, command.value)
	const action = result.newCeiling === undefined ? 'Cleared' : 'Set'
	sendCommandMessage(
		api,
		`${action} ${command.scope} ${command.dimension} budget ceiling.${'\n'}${formattedSummary(await summaryLines(ctx.cwd, command.scope))}`,
	)
}

export async function overrideBudget(api: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const command = parseBudgetOverrideArgs(args)
	if (command.type === 'raise') {
		await applyBudgetRaiseCeiling(
			ctx.cwd,
			command.scope,
			command.dimension!,
			command.value!,
			command.grantedBy,
			command.reason,
		)
		sendCommandMessage(
			api,
			`Raised ${command.scope} ${command.dimension} budget ceiling.${'\n'}${formattedSummary(await summaryLines(ctx.cwd, command.scope))}`,
		)
		return
	}

	await grantBudgetOneShot(ctx.cwd, command.scope, command.grantedBy, command.reason)
	sendCommandMessage(
		api,
		`Granted a ${command.scope} one-shot continue.${'\n'}${formattedSummary(await summaryLines(ctx.cwd, command.scope))}`,
	)
}

export async function handleBudgetCommand(
	api: ExtensionAPI,
	ctx: ExtensionCommandContext,
	name: 'omr:budget-show' | 'omr:budget-set' | 'omr:budget-override',
	args: string,
): Promise<void> {
	try {
		switch (name) {
			case 'omr:budget-show':
				await showBudget(api, ctx, args)
				return
			case 'omr:budget-set':
				await setBudget(api, ctx, args)
				return
			case 'omr:budget-override':
				await overrideBudget(api, ctx, args)
				return
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		sendCommandMessage(api, `${name} failed: ${message}`)
	}
}
