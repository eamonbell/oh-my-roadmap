import * as path from 'node:path'
import { computeConsumption } from './budget'
import type { BudgetDimension, BudgetOverride, BudgetScopeState, ConsumptionResult } from './budget'
import { getElapsedMs } from './elapsed-time'
import { evaluateThresholds } from './enforcement'
import type { BudgetScope, EnforcementLevel } from './enforcement'
import { fileExists } from './files'
import { roadmapsDir } from './paths'
import { loadConfig } from './project-init'
import type { BudgetThresholdPolicy } from './project-init'
import { loadMilestoneBudgetState, loadRoadmapBudgetState, loadState, nowIso } from './store/index'
import type { LoadedState } from './types'
import { emptyUsageTotals } from './usage'
import type { UsageTotals } from './usage'

const DIMENSIONS: readonly BudgetDimension[] = ['tokens', 'cost', 'time']
const TOKEN_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export interface BudgetDimensionSummary {
	dimension: BudgetDimension;
	spent: number;
	ceiling: number;
	remaining: number | undefined;
	percentage: number | undefined;
	level: EnforcementLevel | 'unknown';
	over_budget: boolean | undefined;
	unknown_cost: boolean;
}

export interface BudgetOverrideAuditSummary {
	type: BudgetOverride['type'];
	dimension?: BudgetDimension;
	reason: string;
	granted_by: string;
	granted_at: string;
	consumed?: boolean;
}

export interface BudgetOverrideSummary {
	total: number;
	available_one_shots: number;
	latest?: BudgetOverrideAuditSummary;
}

export interface BudgetScopeSummary {
	scope: BudgetScope;
	id: string;
	dimensions: BudgetDimensionSummary[];
	overrides: BudgetOverrideSummary;
}

export interface BudgetSummary {
	roadmap_id?: string;
	milestone_id?: string;
	scopes: BudgetScopeSummary[];
}

export interface LoadBudgetSummaryOptions {
	state?: LoadedState;
	now?: string;
}

export interface FormatBudgetSummaryOptions {
	scopes?: readonly BudgetScope[];
}

function hasReportableBudget(state: BudgetScopeState | undefined): state is BudgetScopeState {
	return state !== undefined && (
		DIMENSIONS.some((dimension) => state.ceilings[dimension] !== undefined) ||
		state.overrides.length > 0
	)
}

async function loadThresholdPolicy(cwd: string): Promise<BudgetThresholdPolicy> {
	const configPath = path.join(roadmapsDir(cwd), 'config.yml')
	if (!(await fileExists(configPath))) return {}
	return (await loadConfig(cwd)).budgets?.thresholds ?? {}
}

function latestOverride(overrides: readonly BudgetOverride[]): BudgetOverride | undefined {
	let latest: BudgetOverride | undefined
	for (const override of overrides) {
		if (!latest || override.granted_at >= latest.granted_at) latest = override
	}
	return latest
}

function summarizeOverrides(overrides: readonly BudgetOverride[]): BudgetOverrideSummary {
	const latest = latestOverride(overrides)
	const summary: BudgetOverrideSummary = {
		total: overrides.length,
		available_one_shots: overrides.filter(
			(override) => override.type === 'one_shot_continue' && override.consumed !== true,
		).length,
	}
	if (latest) {
		summary.latest = {
			type: latest.type,
			reason: latest.reason,
			granted_by: latest.granted_by,
			granted_at: latest.granted_at,
			...(latest.dimension ? { dimension: latest.dimension } : {}),
			...(latest.consumed !== undefined ? { consumed: latest.consumed } : {}),
		}
	}
	return summary
}

function summarizeDimension(
	result: ConsumptionResult,
	usage: UsageTotals,
	policy: BudgetThresholdPolicy,
): BudgetDimensionSummary | undefined {
	if (result.ceiling === undefined) return undefined
	if (result.dimension === 'cost' && usage.usd_unavailable) {
		return {
			dimension: 'cost',
			spent: usage.estimated_usd,
			ceiling: result.ceiling,
			remaining: undefined,
			percentage: undefined,
			level: 'unknown',
			over_budget: undefined,
			unknown_cost: true,
		}
	}
	return {
		dimension: result.dimension,
		spent: result.spent,
		ceiling: result.ceiling,
		remaining: result.remaining,
		percentage: result.percentage,
		level: evaluateThresholds([result], policy).levels[result.dimension],
		over_budget: result.over_budget,
		unknown_cost: false,
	}
}

function summarizeScope(
	scope: BudgetScope,
	id: string,
	budget: BudgetScopeState,
	usage: UsageTotals,
	policy: BudgetThresholdPolicy,
	now: string,
): BudgetScopeSummary {
	const consumption = computeConsumption(usage, getElapsedMs(budget.time_tracking, now), budget.ceilings)
	return {
		scope,
		id,
		dimensions: consumption
			.map((result) => summarizeDimension(result, usage, policy))
			.filter((result): result is BudgetDimensionSummary => result !== undefined),
		overrides: summarizeOverrides(budget.overrides),
	}
}

export async function loadBudgetSummary(cwd: string, options: LoadBudgetSummaryOptions = {}): Promise<BudgetSummary> {
	const state = options.state ?? await loadState(cwd)
	const active = state.active
	const roadmap = state.roadmap
	if (!active || !roadmap) return { scopes: [] }

	const roadmapId = active.roadmap_id
	const milestoneId = active.milestone_id ?? roadmap.active_milestone_id
	const [roadmapBudget, milestoneBudget] = await Promise.all([
		loadRoadmapBudgetState(cwd, roadmapId),
		milestoneId ? loadMilestoneBudgetState(cwd, roadmapId, milestoneId) : Promise.resolve(undefined),
	])
	const summary: BudgetSummary = {
		roadmap_id: roadmapId,
		...(milestoneId ? { milestone_id: milestoneId } : {}),
		scopes: [],
	}
	if (!hasReportableBudget(roadmapBudget) && !hasReportableBudget(milestoneBudget)) return summary

	const policy = await loadThresholdPolicy(cwd)
	const now = options.now ?? nowIso()
	const usage = state.usage
	if (hasReportableBudget(roadmapBudget)) {
		summary.scopes.push(summarizeScope(
			'roadmap',
			roadmapId,
			roadmapBudget,
			usage?.total ?? emptyUsageTotals(),
			policy,
			now,
		))
	}
	if (milestoneId && hasReportableBudget(milestoneBudget)) {
		summary.scopes.push(summarizeScope(
			'milestone',
			milestoneId,
			milestoneBudget,
			usage?.milestones[milestoneId]?.total ?? emptyUsageTotals(),
			policy,
			now,
		))
	}
	return summary
}

function formatTokens(value: number): string {
	return `${TOKEN_FORMATTER.format(value)} tokens`
}

function formatUsd(value: number): string {
	return `$${value.toFixed(4)}`
}

function formatDuration(value: number): string {
	const sign = value < 0 ? '-' : ''
	let remaining = Math.round(Math.abs(value))
	const days = Math.floor(remaining / 86_400_000)
	remaining %= 86_400_000
	const hours = Math.floor(remaining / 3_600_000)
	remaining %= 3_600_000
	const minutes = Math.floor(remaining / 60_000)
	remaining %= 60_000
	const seconds = Math.floor(remaining / 1_000)
	const milliseconds = remaining % 1_000
	const parts: string[] = []
	if (days) parts.push(`${days}d`)
	if (hours) parts.push(`${hours}h`)
	if (minutes) parts.push(`${minutes}m`)
	if (seconds) parts.push(`${seconds}s`)
	if (milliseconds) parts.push(`${milliseconds}ms`)
	return `${sign}${parts.join(' ') || '0s'}`
}

function formatDimensionValue(dimension: BudgetDimension, value: number): string {
	if (dimension === 'tokens') return formatTokens(value)
	if (dimension === 'cost') return formatUsd(value)
	return formatDuration(value)
}

function formatPercentage(value: number): string {
	if (!Number.isFinite(value)) return '∞%'
	const rounded = Math.round(value * 10) / 10
	return `${rounded}%`
}

function scopeLabel(scope: BudgetScopeSummary): string {
	return scope.scope === 'roadmap' ? 'roadmap' : `milestone ${scope.id}`
}

function formatDimensionLine(scope: BudgetScopeSummary, dimension: BudgetDimensionSummary): string {
	const label = `Budget ${scopeLabel(scope)} ${dimension.dimension}`
	if (dimension.unknown_cost) {
		return `${label}: spent ${formatUsd(dimension.spent)} + unknown; ceiling ${formatUsd(dimension.ceiling)}; remaining unknown; percentage unknown; level unknown (some request costs unavailable)`
	}
	const remaining = dimension.remaining === undefined
		? 'unknown'
		: formatDimensionValue(dimension.dimension, dimension.remaining)
	const percentage = dimension.percentage === undefined
		? 'percentage unknown'
		: `${formatPercentage(dimension.percentage)} used`
	return `${label}: spent ${formatDimensionValue(dimension.dimension, dimension.spent)}; ceiling ${formatDimensionValue(dimension.dimension, dimension.ceiling)}; remaining ${remaining}; ${percentage}; level ${dimension.level}${dimension.over_budget ? ', over budget' : ''}`
}

function formatOverrideLine(scope: BudgetScopeSummary): string | undefined {
	if (scope.overrides.total === 0) return undefined
	const totalLabel = `${scope.overrides.total} total`
	const available = scope.overrides.available_one_shots
	const oneShotLabel = `${available} one-shot${available === 1 ? '' : 's'} available`
	const latest = scope.overrides.latest
	if (!latest) return `Budget ${scopeLabel(scope)} overrides: ${totalLabel}; ${oneShotLabel}`
	const action = latest.type === 'raise_ceiling'
		? `raise ${latest.dimension ?? 'budget'} ceiling`
		: `one-shot continue${latest.consumed ? ' (consumed)' : ' (available)'}`
	return `Budget ${scopeLabel(scope)} overrides: ${totalLabel}; ${oneShotLabel}; latest ${action} by ${latest.granted_by} at ${latest.granted_at}: ${latest.reason}`
}

export function formatBudgetSummaryLines(
	summary: BudgetSummary,
	options: FormatBudgetSummaryOptions = {},
): string[] {
	const scopes = options.scopes ? new Set(options.scopes) : undefined
	const lines: string[] = []
	for (const scope of summary.scopes) {
		if (scopes && !scopes.has(scope.scope)) continue
		for (const dimension of scope.dimensions) lines.push(formatDimensionLine(scope, dimension))
		const overrideLine = formatOverrideLine(scope)
		if (overrideLine) lines.push(overrideLine)
	}
	return lines
}

export function formatBudgetSummaryMarkdown(
	summary: BudgetSummary,
	options: FormatBudgetSummaryOptions = {},
): string {
	const lines = formatBudgetSummaryLines(summary, options)
	if (lines.length === 0) return ''
	return ['## Budget', '', ...lines.map((line) => `- ${line}`)].join('\n')
}
