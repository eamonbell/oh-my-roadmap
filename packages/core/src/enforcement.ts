// Budget enforcement evaluation and active-scope operator controls. Evaluation
// is read-only and deterministic for a given loaded state; control mutations
// serialize complete budget read-modify-write sequences under the store lock.

import * as path from 'node:path'
import { applyRaiseCeiling, computeConsumption, emptyBudgetScopeState, grantOneShotContinue, hasAvailableOneShot, parseCost, parseTimeDuration, parseTokenCount } from './budget'
import type { BudgetCeiling, BudgetDimension, BudgetScopeState, ConsumptionResult } from './budget'
import { getElapsedMs } from './elapsed-time'
import { fileExists } from './files'
import { withStoreWriteLock } from './lock'
import { roadmapsDir } from './paths'
import { loadConfig } from './project-init'
import type { BudgetThresholdPolicy } from './project-init'
import { emptyUsageTotals } from './usage'
import { loadMilestoneBudgetState, loadRoadmapBudgetState, loadState, nowIso, writeMilestoneBudgetState, writeRoadmapBudgetState } from './store/index'

export type EnforcementLevel = 'none' | 'warn' | 'soft' | 'hard'

export type BudgetScope = 'roadmap' | 'milestone'

export interface BudgetWarning {
	scope: BudgetScope
	dimension: BudgetDimension
	spent: number
	ceiling: number
	percentage: number
}

export interface ThresholdEvaluation {
	levels: Record<BudgetDimension, EnforcementLevel>
	level: EnforcementLevel
}

export interface ScopeEnforcement {
	scope: BudgetScope
	consumption: ConsumptionResult[]
	levels: Record<BudgetDimension, EnforcementLevel>
	level: EnforcementLevel
	warnings: BudgetWarning[]
	softBreached: boolean
	hardBreached: boolean
	hasAvailableOneShot: boolean
}

export interface EnforcementState {
	level: EnforcementLevel
	scopes: ScopeEnforcement[]
	warnings: BudgetWarning[]
	softBreached: boolean
	hardBreached: boolean
}

const SEVERITY: Record<EnforcementLevel, number> = { none: 0, warn: 1, soft: 2, hard: 3 }

const DEFAULT_WARN = 75
const DEFAULT_HARD = 100

function mostSevere(a: EnforcementLevel, b: EnforcementLevel): EnforcementLevel {
	return SEVERITY[a] >= SEVERITY[b] ? a : b
}

// Evaluate per-dimension breach levels against a threshold policy. A dimension
// whose ceiling is undefined is never breached (unlimited). over_budget implies
// hard. Defaults (warn 75, soft disabled, hard 100) apply when a policy level
// is undefined.
export function evaluateThresholds(
	consumption: ConsumptionResult[],
	policy: BudgetThresholdPolicy,
): ThresholdEvaluation {
	const warn = policy.warn ?? DEFAULT_WARN
	const soft = policy.soft
	const hard = policy.hard ?? DEFAULT_HARD

	const levels = {} as Record<BudgetDimension, EnforcementLevel>
	let overall: EnforcementLevel = 'none'

	for (const result of consumption) {
		let level: EnforcementLevel
		if (result.ceiling === undefined) {
			level = 'none'
		} else if (result.over_budget) {
			level = 'hard'
		} else {
			const pct = result.percentage ?? 0
			if (pct >= hard) level = 'hard'
			else if (soft !== undefined && pct >= soft) level = 'soft'
			else if (pct >= warn) level = 'warn'
			else level = 'none'
		}
		levels[result.dimension] = level
		overall = mostSevere(overall, level)
	}

	return { levels, level: overall }
}

// Actionable block reason consumed by the gate and dispatch path: which limit,
// scope, dimension, spent vs ceiling, and how to override.
export function formatBudgetBlockReason(
	level: EnforcementLevel,
	scope: BudgetScope,
	dimension: BudgetDimension,
	spent: number,
	ceiling: number,
	percentage: number,
): string {
	const limit = level === 'hard' ? 'hard limit' : 'soft limit'
	const pct = Number.isFinite(percentage) ? `${Math.round(percentage)}%` : 'over budget'
	return (
		`Budget ${limit} reached for ${scope} ${dimension}: ` +
		`${spent} spent of ${ceiling} ceiling (${pct}). ` +
		`To override, raise the ${scope} ${dimension} ceiling or grant a one-shot continue.`
	)
}

// Human-readable one-line summary of a budget warning (scope, dimension,
// spent vs ceiling, percentage). Consumed by the report and next-action
// surfaces to surface WARN notices without interrupting the run.
export function formatBudgetWarning(warning: BudgetWarning): string {
	const pct = Number.isFinite(warning.percentage) ? `${Math.round(warning.percentage)}%` : 'over budget'
	return `${warning.scope} ${warning.dimension} ${warning.spent}/${warning.ceiling} (${pct})`
}

function hasCeilings(ceilings: BudgetCeiling): boolean {
	return ceilings.tokens !== undefined || ceilings.cost !== undefined || ceilings.time !== undefined
}

function evaluateScope(
	scope: BudgetScope,
	consumption: ConsumptionResult[],
	policy: BudgetThresholdPolicy,
	budget: BudgetScopeState,
): ScopeEnforcement {
	const evaluation = evaluateThresholds(consumption, policy)
	const warnings: BudgetWarning[] = []
	for (const result of consumption) {
		if (result.ceiling === undefined) continue
		if (evaluation.levels[result.dimension] !== 'none') {
			warnings.push({
				scope,
				dimension: result.dimension,
				spent: result.spent,
				ceiling: result.ceiling,
				percentage: result.percentage ?? 0,
			})
		}
	}
	return {
		scope,
		consumption,
		levels: evaluation.levels,
		level: evaluation.level,
		warnings,
		softBreached: SEVERITY[evaluation.level] >= SEVERITY.soft,
		hardBreached: evaluation.level === 'hard',
		hasAvailableOneShot: hasAvailableOneShot(budget),
	}
}

function noopEnforcementState(): EnforcementState {
	return { level: 'none', scopes: [], warnings: [], softBreached: false, hardBreached: false }
}

// Load the budget threshold policy from project config, falling back to the
// empty policy (defaults: warn 75, soft disabled, hard 100) when config.yml
// is absent — matching the fileExists guard in loadMergedConfig.
async function loadThresholdPolicy(cwd: string): Promise<BudgetThresholdPolicy> {
	if (!(await fileExists(path.join(roadmapsDir(cwd), 'config.yml')))) return {}
	const config = await loadConfig(cwd)
	return config.budgets?.thresholds ?? {}
}

// Load active state, config, per-scope budget state, and usage; evaluate
// thresholds for each scope that has ceilings. Returns a no-op state when
// there is no active roadmap/milestone or no ceilings are configured.
export async function evaluateBudgetEnforcement(cwd: string): Promise<EnforcementState> {
	const state = await loadState(cwd)
	const active = state.active
	const roadmap = state.roadmap
	const usage = state.usage
	if (!active || !roadmap || !usage) return noopEnforcementState()

	const roadmapId = active.roadmap_id
	const policy = await loadThresholdPolicy(cwd)
	const now = nowIso()

	const scopes: ScopeEnforcement[] = []

	const roadmapBudget = await loadRoadmapBudgetState(cwd, roadmapId)
	if (roadmapBudget && hasCeilings(roadmapBudget.ceilings)) {
		const consumption = computeConsumption(
			usage.total,
			getElapsedMs(roadmapBudget.time_tracking, now),
			roadmapBudget.ceilings,
		)
		scopes.push(evaluateScope('roadmap', consumption, policy, roadmapBudget))
	}

	const milestoneId = active.milestone_id ?? roadmap.active_milestone_id
	if (milestoneId) {
		const milestoneBudget = await loadMilestoneBudgetState(cwd, roadmapId, milestoneId)
		if (milestoneBudget && hasCeilings(milestoneBudget.ceilings)) {
			const milestoneUsage = usage.milestones[milestoneId]?.total ?? emptyUsageTotals()
			const consumption = computeConsumption(
				milestoneUsage,
				getElapsedMs(milestoneBudget.time_tracking, now),
				milestoneBudget.ceilings,
			)
			scopes.push(evaluateScope('milestone', consumption, policy, milestoneBudget))
		}
	}

	if (scopes.length === 0) return noopEnforcementState()

	const warnings = scopes.flatMap((s) => s.warnings)
	const level = scopes.reduce<EnforcementLevel>((max, s) => mostSevere(max, s.level), 'none')

	return {
		level,
		scopes,
		warnings,
		softBreached: scopes.some((s) => s.softBreached),
		hardBreached: scopes.some((s) => s.hardBreached),
	}
}

// --- Budget controls (operator-surface core) ---

export interface BudgetCeilingMutationResult {
	scope: BudgetScope
	dimension: BudgetDimension
	previousCeiling: number | undefined
	newCeiling: number | undefined
	state: BudgetScopeState
}

export interface BudgetOneShotMutationResult {
	scope: BudgetScope
	state: BudgetScopeState
}

interface ActiveBudgetMutation<T> {
	state: BudgetScopeState
	result: T
}

function parseCeilingValue(dimension: BudgetDimension, value: string): number | undefined {
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

// Serialize the complete active-scope read-modify-write sequence. The budget
// persistence functions also take this lock, and withStoreWriteLock is
// intentionally re-entrant for those nested writes.
async function persistActiveBudgetMutation<T>(
	cwd: string,
	scope: BudgetScope,
	mutate: (state: BudgetScopeState, now: string) => ActiveBudgetMutation<T>,
): Promise<T> {
	return await withStoreWriteLock(cwd, async () => {
		const loaded = await loadState(cwd)
		const active = loaded.active
		const roadmap = loaded.roadmap
		if (!active || !roadmap) {
			throw new Error('Cannot modify budget: no active roadmap.')
		}

		const roadmapId = active.roadmap_id
		const now = nowIso()
		if (scope === 'milestone') {
			const milestoneId = active.milestone_id ?? roadmap.active_milestone_id
			if (!milestoneId) {
				throw new Error('Cannot modify milestone budget: no active milestone.')
			}
			const current = await loadMilestoneBudgetState(cwd, roadmapId, milestoneId)
			const mutation = mutate(current ?? emptyBudgetScopeState(), now)
			await writeMilestoneBudgetState(cwd, roadmapId, milestoneId, mutation.state)
			return mutation.result
		}

		const current = await loadRoadmapBudgetState(cwd, roadmapId)
		const mutation = mutate(current ?? emptyBudgetScopeState(), now)
		await writeRoadmapBudgetState(cwd, roadmapId, mutation.state)
		return mutation.result
	})
}

// Set, lower, or clear one ceiling on the active roadmap or milestone. An
// ordinary set may not increase an existing finite ceiling; audited raises
// must use applyBudgetRaiseCeiling.
export async function setActiveBudgetCeiling(
	cwd: string,
	scope: BudgetScope,
	dimension: BudgetDimension,
	value: string,
): Promise<BudgetCeilingMutationResult> {
	const newCeiling = parseCeilingValue(dimension, value)
	return await persistActiveBudgetMutation(cwd, scope, (state) => {
		const previousCeiling = state.ceilings[dimension]
		if (newCeiling !== undefined && previousCeiling !== undefined && newCeiling > previousCeiling) {
			throw new Error(
				`Cannot increase the ${scope} ${dimension} budget ceiling from ${previousCeiling} to ${newCeiling} with an ordinary set. Use the audited raise override instead.`,
			)
		}

		const ceilings = { ...state.ceilings }
		if (newCeiling === undefined) {
			delete ceilings[dimension]
		} else {
			ceilings[dimension] = newCeiling
		}
		const next = { ...state, ceilings }
		return {
			state: next,
			result: { scope, dimension, previousCeiling, newCeiling, state: next },
		}
	})
}

// Raise one ceiling and append its full audit record.
export async function applyBudgetRaiseCeiling(
	cwd: string,
	scope: BudgetScope,
	dimension: BudgetDimension,
	newCeiling: number,
	grantedBy: string,
	reason: string,
): Promise<BudgetCeilingMutationResult> {
	return await persistActiveBudgetMutation(cwd, scope, (state, now) => {
		const previousCeiling = state.ceilings[dimension]
		const next = applyRaiseCeiling(state, dimension, newCeiling, grantedBy, reason, now)
		return {
			state: next,
			result: { scope, dimension, previousCeiling, newCeiling, state: next },
		}
	})
}

// Grant one unconsumed one-shot continue and append its full audit record.
export async function grantBudgetOneShot(
	cwd: string,
	scope: BudgetScope,
	grantedBy: string,
	reason: string,
): Promise<BudgetOneShotMutationResult> {
	return await persistActiveBudgetMutation(cwd, scope, (state, now) => {
		const next = grantOneShotContinue(state, grantedBy, reason, now)
		return { state: next, result: { scope, state: next } }
	})
}
