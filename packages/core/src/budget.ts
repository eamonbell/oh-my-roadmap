import * as crypto from 'node:crypto'
import { emptyTimeTracking, normalizeTimeTracking } from './elapsed-time'
import type { TimeTracking } from './elapsed-time'
import { totalTokens } from './report/shared'
import type { UsageTotals } from './usage'

export type BudgetDimension = 'tokens' | 'cost' | 'time'

export interface BudgetCeiling {
	tokens?: number
	cost?: number
	time?: number
}

export type BudgetOverrideType = 'raise_ceiling' | 'one_shot_continue'

export interface BudgetOverride {
	id: string
	type: BudgetOverrideType
	dimension?: BudgetDimension
	old_ceiling?: number
	new_ceiling?: number
	reason: string
	granted_by: string
	granted_at: string
	consumed?: boolean
}

export interface BudgetScopeState {
	ceilings: BudgetCeiling
	overrides: BudgetOverride[]
	time_tracking: TimeTracking
}

export interface ConsumptionResult {
	dimension: BudgetDimension
	spent: number
	ceiling: number | undefined
	remaining: number | undefined
	percentage: number | undefined
	over_budget: boolean
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must be an object`)
	}
	return value as Record<string, unknown>
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedSet = new Set(allowed)
	const unknown = Object.keys(value).sort((a, b) => a.localeCompare(b)).filter((key) => !allowedSet.has(key))
	if (unknown.length > 0) {
		throw new Error(`${label} contains unsupported key${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
	}
}

function newOverrideId(): string {
	return `ovr_${crypto.randomUUID()}`
}

function assertString(value: unknown, label: string): string {
	if (typeof value !== 'string') {
		throw new Error(`${label} must be a string`)
	}
	return value
}

function assertBoolean(value: unknown, label: string): boolean {
	if (typeof value !== 'boolean') {
		throw new Error(`${label} must be a boolean`)
	}
	return value
}

function assertBudgetDimension(value: unknown, label: string): BudgetDimension {
	if (value === 'tokens' || value === 'cost' || value === 'time') {
		return value
	}
	throw new Error(`${label} must be one of: tokens, cost, time`)
}

function assertNonNegativeFiniteNumber(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a non-negative finite number`)
	}
	return value
}

export function parseTimeDuration(value: string): number {
	const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value)
	if (!match || (!match[1] && !match[2] && !match[3])) {
		throw new Error(`Invalid time duration "${value}"; expected formats like 30m, 1h, 2h30m, or 90s`)
	}
	return Number(match[1] ?? 0) * 3_600_000 + Number(match[2] ?? 0) * 60_000 + Number(match[3] ?? 0) * 1_000
}

export function parseCost(value: string): number {
	if (!/^\d+(?:\.\d+)?$/.test(value)) {
		throw new Error(`Invalid cost "${value}"; expected a non-negative decimal like 5.00`)
	}
	return Number.parseFloat(value)
}

export function parseTokenCount(value: string): number {
	if (!/^\d+$/.test(value)) {
		throw new Error(`Invalid token count "${value}"; expected a non-negative integer`)
	}
	return Number.parseInt(value, 10)
}

export function parseBudgetCeiling(value: unknown): BudgetCeiling {
	const raw = requirePlainObject(value, 'budget ceiling')
	rejectUnknownKeys(raw, ['tokens', 'cost', 'time'], 'budget ceiling')
	const ceiling: BudgetCeiling = {}
	if (raw.tokens !== undefined) ceiling.tokens = parseTokenCount(assertString(raw.tokens, 'budget ceiling.tokens'))
	if (raw.cost !== undefined) ceiling.cost = parseCost(assertString(raw.cost, 'budget ceiling.cost'))
	if (raw.time !== undefined) ceiling.time = parseTimeDuration(assertString(raw.time, 'budget ceiling.time'))
	return ceiling
}

function consumptionResult(dimension: BudgetDimension, spent: number, ceiling: number | undefined): ConsumptionResult {
	if (ceiling === undefined) {
		return { dimension, spent, ceiling: undefined, remaining: undefined, percentage: undefined, over_budget: false }
	}
	return {
		dimension,
		spent,
		ceiling,
		remaining: ceiling - spent,
		percentage: ceiling === 0 ? (spent === 0 ? 0 : Infinity) : spent / ceiling * 100,
		over_budget: spent > ceiling,
	}
}

export function computeConsumption(totals: UsageTotals, elapsedMs: number, ceiling: BudgetCeiling): ConsumptionResult[] {
	return [
		consumptionResult('tokens', totalTokens(totals), ceiling.tokens),
		consumptionResult('cost', totals.usd_unavailable ? 0 : totals.estimated_usd, ceiling.cost),
		consumptionResult('time', elapsedMs, ceiling.time),
	]
}

export function emptyBudgetScopeState(): BudgetScopeState {
	return { ceilings: {}, overrides: [], time_tracking: emptyTimeTracking() }
}
export function isEmptyBudgetScopeState(state: BudgetScopeState): boolean {
	return Object.keys(state.ceilings).length === 0 &&
		state.overrides.length === 0 &&
		state.time_tracking.accumulated_ms === 0 &&
		state.time_tracking.started_at === undefined &&
		state.time_tracking.paused_at === undefined
}

function normalizeBudgetCeilings(value: unknown): BudgetCeiling {
	if (value === undefined || value === null) {
		return {}
	}
	const raw = requirePlainObject(value, 'budget ceilings')
	rejectUnknownKeys(raw, ['tokens', 'cost', 'time'], 'budget ceilings')
	const ceilings: BudgetCeiling = {}
	if (raw.tokens !== undefined) ceilings.tokens = assertNonNegativeFiniteNumber(raw.tokens, 'budget ceilings.tokens')
	if (raw.cost !== undefined) ceilings.cost = assertNonNegativeFiniteNumber(raw.cost, 'budget ceilings.cost')
	if (raw.time !== undefined) ceilings.time = assertNonNegativeFiniteNumber(raw.time, 'budget ceilings.time')
	return ceilings
}

function normalizeBudgetOverride(value: unknown): BudgetOverride {
	const raw = requirePlainObject(value, 'budget override')
	rejectUnknownKeys(raw, ['id', 'type', 'dimension', 'old_ceiling', 'new_ceiling', 'reason', 'granted_by', 'granted_at', 'consumed'], 'budget override')
	const type = assertString(raw.type, 'budget override.type')
	if (type !== 'raise_ceiling' && type !== 'one_shot_continue') {
		throw new Error('budget override.type must be one of: raise_ceiling, one_shot_continue')
	}
	const dimension = raw.dimension === undefined ? undefined : assertBudgetDimension(raw.dimension, 'budget override.dimension')
	const oldCeiling = raw.old_ceiling === undefined ? undefined : assertNonNegativeFiniteNumber(raw.old_ceiling, 'budget override.old_ceiling')
	const newCeiling = raw.new_ceiling === undefined ? undefined : assertNonNegativeFiniteNumber(raw.new_ceiling, 'budget override.new_ceiling')
	if (type === 'raise_ceiling' && dimension === undefined) {
		throw new Error('budget override.dimension is required for raise_ceiling')
	}
	const id = raw.id === undefined ? newOverrideId() : assertString(raw.id, 'budget override.id')
	const override: BudgetOverride = {
		id,
		type: type as BudgetOverrideType,
		reason: assertString(raw.reason, 'budget override.reason'),
		granted_by: assertString(raw.granted_by, 'budget override.granted_by'),
		granted_at: assertString(raw.granted_at, 'budget override.granted_at'),
	}
	if (dimension !== undefined) override.dimension = dimension
	if (oldCeiling !== undefined) override.old_ceiling = oldCeiling
	if (newCeiling !== undefined) override.new_ceiling = newCeiling
	if (raw.consumed !== undefined) override.consumed = assertBoolean(raw.consumed, 'budget override.consumed')
	return override
}

function normalizeBudgetOverrides(value: unknown): BudgetOverride[] {
	if (value === undefined || value === null) {
		return []
	}
	if (!Array.isArray(value)) {
		throw new Error('budget overrides must be an array')
	}
	return value.map((item) => normalizeBudgetOverride(item))
}

export function normalizeBudgetScopeState(value: unknown): BudgetScopeState {
	if (value === undefined || value === null) {
		return emptyBudgetScopeState()
	}
	const raw = requirePlainObject(value, 'budget scope state')
	rejectUnknownKeys(raw, ['ceilings', 'overrides', 'time_tracking'], 'budget scope state')
	return {
		ceilings: normalizeBudgetCeilings(raw.ceilings),
		overrides: normalizeBudgetOverrides(raw.overrides),
		time_tracking: normalizeTimeTracking(raw.time_tracking),
	}
}

export function applyRaiseCeiling(
	state: BudgetScopeState,
	dimension: BudgetDimension,
	newCeiling: number,
	grantedBy: string,
	reason: string,
	now: string,
): BudgetScopeState {
	const oldCeiling = state.ceilings[dimension]
	const override: BudgetOverride = {
		id: newOverrideId(),
		type: 'raise_ceiling',
		dimension,
		new_ceiling: newCeiling,
		reason,
		granted_by: grantedBy,
		granted_at: now,
	}
	if (oldCeiling !== undefined) override.old_ceiling = oldCeiling
	return {
		...state,
		ceilings: { ...state.ceilings, [dimension]: newCeiling },
		overrides: [...state.overrides, override],
	}
}

export function grantOneShotContinue(state: BudgetScopeState, grantedBy: string, reason: string, now: string): BudgetScopeState {
	return {
		...state,
		overrides: [...state.overrides, {
			id: newOverrideId(),
			type: 'one_shot_continue',
			reason,
			granted_by: grantedBy,
			granted_at: now,
			consumed: false,
		}],
	}
}

export function hasAvailableOneShot(state: BudgetScopeState): boolean {
	return state.overrides.some((override) => override.type === 'one_shot_continue' && override.consumed !== true)
}

export function consumeOneShot(state: BudgetScopeState): BudgetScopeState {
	let index = -1
	for (let i = state.overrides.length - 1; i >= 0; i -= 1) {
		const override = state.overrides[i]
		if (override?.type === 'one_shot_continue' && override.consumed !== true) {
			index = i
			break
		}
	}
	if (index < 0) return state
	return {
		...state,
		overrides: state.overrides.map((override, i) => i === index ? { ...override, consumed: true } : override),
	}
}
