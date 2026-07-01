import {activePointerPath, changeRequestPath, roadmapStatePath, roadmapUsagePath,} from './paths'
import {withDiagnosticTiming} from '../diagnostics'
import {fileExists, readMarkdownData, readYamlFile, writeYamlFile} from './files'
import {withStoreWriteLock} from './lock'
import type {ActivePointer, ChangeRequest, RoadmapState} from './types'

export interface UsageTotals {
	estimated_usd: number;
	usd_unavailable: boolean;
	requests: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	reasoning_tokens: number;
}

export interface UsageScopeSummary {
	total: UsageTotals;
	by_agent: Record<string, UsageTotals>;
}

export interface MilestoneUsageSummary extends UsageScopeSummary {
	change_requests: Record<string, UsageScopeSummary>;
}

export interface RoadmapUsageSummary extends UsageScopeSummary {
	roadmap_id: string;
	updated_at?: string;
	dedupe_keys: string[];
	milestones: Record<string, MilestoneUsageSummary>;
}

export type WorkflowUsageAgent =
	| 'roadmap_planning'
	| 'milestone_planning'
	| 'implementation_orchestrator'
	| 'review'
	| 'closeout'
	| 'change_planning'
	| 'change_implementation';

interface UsageScope {
	roadmapId: string;
	milestoneId?: string;
	changeRequestId?: string;
}

interface UsageDelta {
	agent: string;
	dedupeKey: string;
	scope: UsageScope;
	totals: UsageTotals;
}

interface UsageLike {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	reasoningTokens?: unknown;
	cost?: {
		total?: unknown;
	};
}

interface TaskResultLike {
	id?: unknown;
	agent?: unknown;
	requests?: unknown;
	usage?: UsageLike;
	extractedToolData?: Record<string, unknown[]>;
}

interface TaskToolDetailsLike {
	results?: unknown;
}

export function emptyUsageTotals(): UsageTotals {
	return {
		estimated_usd: 0,
		usd_unavailable: false,
		requests: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		reasoning_tokens: 0,
	}
}

function emptyScopeSummary(): UsageScopeSummary {
	return {
		total: emptyUsageTotals(),
		by_agent: {},
	}
}

export function emptyRoadmapUsageSummary(roadmapId: string): RoadmapUsageSummary {
	return {
		roadmap_id: roadmapId,
		dedupe_keys: [],
		total: emptyUsageTotals(),
		by_agent: {},
		milestones: {},
	}
}

function emptyMilestoneSummary(): MilestoneUsageSummary {
	return {
		...emptyScopeSummary(),
		change_requests: {},
	}
}

function numberValue(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function boolValue(value: unknown): boolean {
	return typeof value === 'boolean' ? value : false
}

function normalizeTotals(value: unknown): UsageTotals {
	const raw = value && typeof value === 'object' && !Array.isArray(value)
		? value as Partial<UsageTotals>
		: {}
	return {
		estimated_usd: numberValue(raw.estimated_usd),
		usd_unavailable: boolValue(raw.usd_unavailable),
		requests: numberValue(raw.requests),
		input_tokens: numberValue(raw.input_tokens),
		output_tokens: numberValue(raw.output_tokens),
		cache_read_tokens: numberValue(raw.cache_read_tokens),
		cache_write_tokens: numberValue(raw.cache_write_tokens),
		reasoning_tokens: numberValue(raw.reasoning_tokens),
	}
}

function normalizeByAgent(value: unknown): Record<string, UsageTotals> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	const agents: Record<string, UsageTotals> = {}
	for (const [agent, totals] of Object.entries(value)) {
		if (agent.trim()) agents[agent] = normalizeTotals(totals)
	}
	return agents
}

function normalizeScope(value: unknown): UsageScopeSummary {
	const raw = value && typeof value === 'object' && !Array.isArray(value)
		? value as Partial<UsageScopeSummary>
		: {}
	return {
		total: normalizeTotals(raw.total),
		by_agent: normalizeByAgent(raw.by_agent),
	}
}

function normalizeMilestone(value: unknown): MilestoneUsageSummary {
	const scope = normalizeScope(value)
	const raw = value && typeof value === 'object' && !Array.isArray(value)
		? value as Partial<MilestoneUsageSummary>
		: {}
	const change_requests: Record<string, UsageScopeSummary> = {}
	if (raw.change_requests && typeof raw.change_requests === 'object' && !Array.isArray(raw.change_requests)) {
		for (const [changeId, change] of Object.entries(raw.change_requests)) {
			if (changeId.trim()) change_requests[changeId] = normalizeScope(change)
		}
	}
	return {...scope, change_requests}
}

function normalizeSummary(value: unknown, roadmapId: string): RoadmapUsageSummary {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Roadmap usage summary must be an object')
	}
	const raw = value as Partial<RoadmapUsageSummary>
	const milestones: Record<string, MilestoneUsageSummary> = {}
	if (raw.milestones && typeof raw.milestones === 'object' && !Array.isArray(raw.milestones)) {
		for (const [milestoneId, milestone] of Object.entries(raw.milestones)) {
			if (milestoneId.trim()) milestones[milestoneId] = normalizeMilestone(milestone)
		}
	}
	return {
		roadmap_id: typeof raw.roadmap_id === 'string' && raw.roadmap_id ? raw.roadmap_id : roadmapId,
		...(typeof raw.updated_at === 'string' ? {updated_at: raw.updated_at} : {}),
		dedupe_keys: Array.isArray(raw.dedupe_keys)
			? raw.dedupe_keys.filter((key): key is string => typeof key === 'string')
			: [],
		total: normalizeTotals(raw.total),
		by_agent: normalizeByAgent(raw.by_agent),
		milestones,
	}
}

export async function loadUsageSummary(cwd: string, roadmapId: string): Promise<RoadmapUsageSummary> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'usage.loadUsageSummary',
		cwd,
		slowMs: 250,
		metadata: {roadmap_id: roadmapId},
	}, async () => {
		const filePath = roadmapUsagePath(cwd, roadmapId)
		if (!(await fileExists(filePath))) return emptyRoadmapUsageSummary(roadmapId)
		return normalizeSummary(await readYamlFile<unknown>(filePath), roadmapId)
	})
}

export async function writeUsageSummary(cwd: string, summary: RoadmapUsageSummary): Promise<void> {
	await withDiagnosticTiming({
		component: 'core',
		operation: 'usage.writeUsageSummary',
		cwd,
		slowMs: 250,
		metadata: {roadmap_id: summary.roadmap_id},
	}, async () => {
		await writeYamlFile(roadmapUsagePath(cwd, summary.roadmap_id), summary)
	})
}

function addTotals(target: UsageTotals, delta: UsageTotals): void {
	target.estimated_usd += delta.estimated_usd
	target.usd_unavailable = target.usd_unavailable || delta.usd_unavailable
	target.requests += delta.requests
	target.input_tokens += delta.input_tokens
	target.output_tokens += delta.output_tokens
	target.cache_read_tokens += delta.cache_read_tokens
	target.cache_write_tokens += delta.cache_write_tokens
	target.reasoning_tokens += delta.reasoning_tokens
}

function addToScope(scope: UsageScopeSummary, agent: string, totals: UsageTotals): void {
	addTotals(scope.total, totals)
	scope.by_agent[agent] ??= emptyUsageTotals()
	addTotals(scope.by_agent[agent], totals)
}

function hasBillableUsage(totals: UsageTotals): boolean {
	return totals.requests > 0 ||
		totals.input_tokens > 0 ||
		totals.output_tokens > 0 ||
		totals.cache_read_tokens > 0 ||
		totals.cache_write_tokens > 0 ||
		totals.reasoning_tokens > 0 ||
		totals.estimated_usd > 0 ||
		totals.usd_unavailable
}

function totalsFromUsage(usage: UsageLike | undefined, requests: number): UsageTotals {
	const costTotal = usage?.cost && typeof usage.cost === 'object'
		? numberValue(usage.cost.total)
		: 0
	const hasCost = usage?.cost &&
		typeof usage.cost === 'object' &&
		typeof usage.cost.total === 'number' &&
		Number.isFinite(usage.cost.total)
	const totals: UsageTotals = {
		estimated_usd: hasCost ? costTotal : 0,
		usd_unavailable: false,
		requests,
		input_tokens: numberValue(usage?.input),
		output_tokens: numberValue(usage?.output),
		cache_read_tokens: numberValue(usage?.cacheRead),
		cache_write_tokens: numberValue(usage?.cacheWrite),
		reasoning_tokens: numberValue(usage?.reasoningTokens),
	}
	totals.usd_unavailable = !hasCost && hasBillableUsage(totals)
	return totals
}

function applyDelta(summary: RoadmapUsageSummary, delta: UsageDelta): boolean {
	if (!hasBillableUsage(delta.totals)) return false
	if (summary.dedupe_keys.includes(delta.dedupeKey)) return false
	summary.dedupe_keys.push(delta.dedupeKey)
	summary.updated_at = new Date().toISOString()
	addToScope(summary, delta.agent, delta.totals)

	if (delta.scope.milestoneId) {
		summary.milestones[delta.scope.milestoneId] ??= emptyMilestoneSummary()
		const milestone = summary.milestones[delta.scope.milestoneId] as MilestoneUsageSummary
		addToScope(milestone, delta.agent, delta.totals)

		if (delta.scope.changeRequestId) {
			milestone.change_requests[delta.scope.changeRequestId] ??= emptyScopeSummary()
			addToScope(milestone.change_requests[delta.scope.changeRequestId] as UsageScopeSummary, delta.agent, delta.totals)
		}
	}
	return true
}

async function readActiveScope(cwd: string): Promise<{ scope?: UsageScope; roadmap?: RoadmapState; change?: ChangeRequest }> {
	if (!(await fileExists(activePointerPath(cwd)))) return {}
	const active = await readYamlFile<ActivePointer>(activePointerPath(cwd))
	const roadmap = await readYamlFile<RoadmapState>(roadmapStatePath(cwd, active.roadmap_id))
	const milestoneId = active.milestone_id ?? roadmap.active_milestone_id
	const changeRequestId = active.change_request_id ?? roadmap.active_change_request_id
	const scope: UsageScope = {
		roadmapId: roadmap.roadmap_id,
		...(milestoneId ? {milestoneId} : {}),
		...(changeRequestId ? {changeRequestId} : {}),
	}
	const change = milestoneId && changeRequestId && (await fileExists(changeRequestPath(cwd, roadmap.roadmap_id, milestoneId, changeRequestId)))
		? await readMarkdownData<ChangeRequest>(changeRequestPath(cwd, roadmap.roadmap_id, milestoneId, changeRequestId))
		: undefined
	return {
		scope,
		roadmap,
		...(change ? {change} : {}),
	}
}

export function workflowUsageAgent(roadmap: RoadmapState, change?: ChangeRequest): WorkflowUsageAgent {
	if (change) {
		return change.status === 'draft' ? 'change_planning' : 'change_implementation'
	}
	switch (roadmap.phase) {
		case 'discovery':
		case 'roadmap_draft':
		case 'roadmap_approved':
			return 'roadmap_planning'
		case 'milestone_planning':
		case 'milestone_approved':
			return 'milestone_planning'
		case 'implementing':
			return 'implementation_orchestrator'
		case 'reviewing':
			return 'review'
		case 'closeout':
		case 'complete':
			return 'closeout'
	}
}

async function recordDeltas(cwd: string, deltas: UsageDelta[]): Promise<void> {
	if (deltas.length === 0) return
	await withStoreWriteLock(cwd, async () => {
		const summary = await loadUsageSummary(cwd, deltas[0]?.scope.roadmapId ?? '')
		let changed = false
		for (const delta of deltas) changed = applyDelta(summary, delta) || changed
		if (changed) await writeUsageSummary(cwd, summary)
	})
}

function messageDedupeKey(message: Record<string, unknown>): string {
	const responseId = typeof message.responseId === 'string' ? message.responseId : undefined
	if (responseId) return `message:${responseId}`
	return [
		'message',
		String(message.timestamp ?? ''),
		String(message.provider ?? ''),
		String(message.model ?? ''),
		String((message.usage as { totalTokens?: unknown } | undefined)?.totalTokens ?? ''),
	].join(':')
}

export async function recordMainUsage(cwd: string, message: unknown): Promise<void> {
	await withDiagnosticTiming({
		component: 'core',
		operation: 'usage.recordMainUsage',
		cwd,
		slowMs: 250,
	}, async () => {
		if (!message || typeof message !== 'object' || Array.isArray(message)) return
		const raw = message as Record<string, unknown>
		if (raw.role !== 'assistant') return
		const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage as UsageLike : undefined
		if (!usage) return
		const totals = totalsFromUsage(usage, 1)
		if (!hasBillableUsage(totals)) return

		await withStoreWriteLock(cwd, async () => {
			const {scope, roadmap, change} = await readActiveScope(cwd)
			if (!scope || !roadmap) return
			await recordDeltas(cwd, [{
				agent: workflowUsageAgent(roadmap, change),
				dedupeKey: messageDedupeKey(raw),
				scope,
				totals,
			}])
		})
	})
}

function isTaskToolDetails(value: unknown): value is TaskToolDetailsLike {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as TaskToolDetailsLike).results))
}

function taskDetailsFromToolResult(result: unknown): TaskToolDetailsLike | undefined {
	if (isTaskToolDetails(result)) return result
	if (result && typeof result === 'object' && !Array.isArray(result)) {
		const details = (result as { details?: unknown }).details
		if (isTaskToolDetails(details)) return details
	}
	return undefined
}

function nestedTaskDetails(result: TaskResultLike): TaskToolDetailsLike[] {
	const values = result.extractedToolData?.task ?? []
	return values.filter(isTaskToolDetails)
}

function collectTaskDeltas(
	details: TaskToolDetailsLike,
	scope: UsageScope,
	toolCallId: string,
	path: string,
	deltas: UsageDelta[],
): void {
	const results = Array.isArray(details.results) ? details.results : []
	results.forEach((item, index) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return
		const result = item as TaskResultLike
		const agent = typeof result.agent === 'string' && result.agent.trim() ? result.agent : 'subagent'
		const requests = numberValue(result.requests)
		const totals = totalsFromUsage(result.usage, requests)
		const resultId = typeof result.id === 'string' && result.id ? result.id : String(index)
		deltas.push({
			agent,
			dedupeKey: `task:${toolCallId}:${path}${resultId}`,
			scope,
			totals,
		})
		nestedTaskDetails(result).forEach((nested, nestedIndex) => {
			collectTaskDeltas(nested, scope, toolCallId, `${path}${resultId}.nested${nestedIndex}.`, deltas)
		})
	})
}

export async function recordTaskUsage(cwd: string, toolCallId: string, toolResult: unknown): Promise<void> {
	await withDiagnosticTiming({
		component: 'core',
		operation: 'usage.recordTaskUsage',
		cwd,
		slowMs: 250,
		metadata: {tool_call_id: toolCallId},
	}, async () => {
		const details = taskDetailsFromToolResult(toolResult)
		if (!details) return

		await withStoreWriteLock(cwd, async () => {
			const {scope} = await readActiveScope(cwd)
			if (!scope) return
			const deltas: UsageDelta[] = []
			collectTaskDeltas(details, scope, toolCallId, '', deltas)
			await recordDeltas(cwd, deltas)
		})
	})
}
