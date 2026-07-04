import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type {AgentEndEvent, ExtensionAPI, ExtensionContext, ToolExecutionStartEvent} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {loadMoshiConfig, type MoshiConfig} from '@oh-my-roadmap/core/project-init'
import {nextActionPlan} from '@oh-my-roadmap/core/report/index'
import {loadAdhocActive, loadState} from '@oh-my-roadmap/core/store/index'

// Opt-in Moshi notifications. This module speaks Moshi's documented local-socket
// `session.update` protocol (newline-delimited JSON over a Unix socket, one logical
// exchange per connection). It never reads Moshi tokens/secrets, never falls back to
// any HTTP endpoint, and never fails or meaningfully delays an OMR tool result.

// How long to wait for the daemon to ack before giving up on a single frame.
const SEND_TIMEOUT_MS = 500
// Suppress an identical notification within this window.
const DEDUPE_WINDOW_MS = 5000
// Drop dedupe bookkeeping older than this on each send attempt.
const DEDUPE_PRUNE_MS = 60000

export type MoshiCategory =
	| 'approval_required'
	| 'task_complete'
	| 'session_started'
	| 'session_ended'
	| 'tool_running'
	| 'tool_finished';

// The exact frame written to the Moshi socket. Unknown fields are ignored by the
// daemon; we deliberately omit actionId/pendingActionId/expiresAt/hostId because this
// integration is notify-only and cannot route decisions back to the running host.
export interface MoshiSessionUpdateFrame {
	type: 'session.update';
	source: 'omp';
	sessionId: string;
	eventName: string;
	phase: string;
	category: MoshiCategory;
	cwd: string;
	projectName: string;
	title: string;
	message: string;
	requestedAt: string;
	modelName?: string;
	toolName?: string;
	contextPercent?: number;
}

// A resolved notification, independent of any session/socket concerns. Produced by the
// pure mapping functions and turned into a frame by buildMoshiSessionUpdate.
export interface MoshiNotificationEvent {
	eventName: string;
	category: MoshiCategory;
	phase: string;
	title: string;
	message: string;
	toolName?: string;
}

// Minimal shape of the runtime context this module reads. Kept structural so tests can
// pass a plain object without depending on OMP session internals.
export interface MoshiContextLike {
	cwd: string;
	sessionManager?: {
		getSessionFile?: () => string | null | undefined;
		getSessionId?: () => string | null | undefined;
	};
	getContextUsage?: () => {percent?: number} | undefined;
	model?: unknown;
}

interface MoshiLogger {
	debug?: (message: string) => void;
	warn?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Frame construction (pure)
// ---------------------------------------------------------------------------

function firstNonEmptyString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === 'string' && value.trim() !== '') return value
	}
	return undefined
}

function safeString(fn: (() => string | null | undefined) | undefined, self: unknown): string | undefined {
	if (typeof fn !== 'function') return undefined
	try {
		const value = fn.call(self)
		return typeof value === 'string' && value !== '' ? value : undefined
	} catch {
		return undefined
	}
}

// Defensive session-id strategy: prefer the on-disk session file, then the session id,
// then fall back to cwd so a frame always carries a stable key.
function resolveSessionId(ctx: MoshiContextLike): string {
	const sm = ctx.sessionManager
	const file = safeString(sm?.getSessionFile, sm)
	if (file) return file
	const id = safeString(sm?.getSessionId, sm)
	if (id) return id
	return ctx.cwd
}

function resolveModelName(model: unknown): string | undefined {
	if (!model || typeof model !== 'object') return undefined
	const obj = model as Record<string, unknown>
	return firstNonEmptyString(obj.displayName, obj.display_name, obj.name, obj.id, obj.modelId)
}

function resolveContextPercent(ctx: MoshiContextLike): number | undefined {
	if (typeof ctx.getContextUsage !== 'function') return undefined
	let usage: {percent?: number} | undefined
	try {
		usage = ctx.getContextUsage()
	} catch {
		return undefined
	}
	const percent = usage?.percent
	if (typeof percent === 'number' && Number.isFinite(percent)) return Math.round(percent)
	return undefined
}

export function buildMoshiSessionUpdate(ctx: MoshiContextLike, event: MoshiNotificationEvent): MoshiSessionUpdateFrame {
	const cwd = ctx.cwd
	const projectName = path.basename(cwd) || cwd
	const frame: MoshiSessionUpdateFrame = {
		type: 'session.update',
		source: 'omp',
		sessionId: resolveSessionId(ctx),
		eventName: event.eventName,
		phase: event.phase,
		category: event.category,
		cwd,
		projectName,
		title: event.title,
		message: event.message,
		requestedAt: new Date().toISOString(),
	}
	const modelName = resolveModelName(ctx.model)
	if (modelName) frame.modelName = modelName
	if (event.toolName) frame.toolName = event.toolName
	const contextPercent = resolveContextPercent(ctx)
	if (contextPercent !== undefined) frame.contextPercent = contextPercent
	return frame
}

// ---------------------------------------------------------------------------
// Socket transport
// ---------------------------------------------------------------------------

// Write one frame over a fresh connection and resolve on the first ack (`data`/`end`),
// on timeout, or on any error. Never rejects: Moshi being absent or unresponsive must
// not surface to the OMR turn.
export function sendMoshiFrame(socketPath: string, frame: MoshiSessionUpdateFrame, timeoutMs: number = SEND_TIMEOUT_MS): Promise<void> {
	return new Promise<void>((resolve) => {
		let settled = false
		let timer: ReturnType<typeof setTimeout> | undefined
		let socket: net.Socket
		const finish = () => {
			if (settled) return
			settled = true
			if (timer) clearTimeout(timer)
			try {
				socket?.destroy()
			} catch {
				// ignore teardown failures
			}
			resolve()
		}

		try {
			socket = net.createConnection(socketPath)
		} catch {
			resolve()
			return
		}

		timer = setTimeout(finish, timeoutMs)
		timer.unref?.()
		socket.setTimeout(timeoutMs)
		socket.on('connect', () => {
			try {
				socket.write(`${JSON.stringify(frame)}\n`)
			} catch {
				finish()
			}
		})
		socket.on('data', finish)
		socket.on('end', finish)
		socket.on('timeout', finish)
		socket.on('error', finish)
	})
}

// Socket path resolution: explicit config, then env override, then the documented
// platform default. Returns undefined when none can be resolved (Linux without
// XDG_RUNTIME_DIR) — the caller then sends nothing rather than inventing a path.
export function resolveMoshiSocketPath(config: MoshiConfig): string | undefined {
	const configured = config.socket_path?.trim()
	if (configured) return configured
	const env = process.env.MOSHI_SOCKET_PATH?.trim()
	if (env) return env
	if (process.platform === 'darwin') {
		return path.join(os.homedir(), 'Library/Application Support/Moshi/moshi-hook.sock')
	}
	if (process.platform === 'linux') {
		const runtime = process.env.XDG_RUNTIME_DIR?.trim()
		if (runtime) return path.join(runtime, 'moshi-hook.sock')
	}
	return undefined
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

const recentSends = new Map<string, number>()

function shouldSuppress(key: string): boolean {
	const now = Date.now()
	for (const [existing, ts] of recentSends) {
		if (now - ts > DEDUPE_PRUNE_MS) recentSends.delete(existing)
	}
	const last = recentSends.get(key)
	if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return true
	recentSends.set(key, now)
	return false
}

async function deliver(ctx: MoshiContextLike, config: MoshiConfig, event: MoshiNotificationEvent, logger?: MoshiLogger): Promise<void> {
	if (config.enabled !== true) return
	const frame = buildMoshiSessionUpdate(ctx, event)
	const key = [frame.sessionId, frame.eventName, frame.title, frame.message].join(' ')
	if (shouldSuppress(key)) return
	const socketPath = resolveMoshiSocketPath(config)
	if (!socketPath) return
	try {
		await sendMoshiFrame(socketPath, frame, SEND_TIMEOUT_MS)
	} catch (error) {
		logger?.debug?.(`moshi notification failed: ${String(error)}`)
	}
}

// ---------------------------------------------------------------------------
// OMR tool-result mapping (pure)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	return value as Record<string, unknown>
}

function detailsOf(result: unknown): Record<string, unknown> | undefined {
	const record = asRecord(result)
	if (!record) return undefined
	return asRecord(record.details)
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

// Compose a compact "k: v" message from labelled parts, dropping empties.
function joinParts(parts: Array<[string, unknown]>): string {
	const rendered: string[] = []
	for (const [label, value] of parts) {
		if (value === undefined || value === null) continue
		if (Array.isArray(value)) {
			if (value.length === 0) continue
			rendered.push(`${label}: ${value.join(', ')}`)
			continue
		}
		const text = typeof value === 'string' ? value.trim() : String(value)
		if (text === '') continue
		rendered.push(`${label}: ${text}`)
	}
	return rendered.join(' | ')
}

function scopeIds(scope: Record<string, unknown> | undefined): Array<[string, unknown]> {
	if (!scope) return []
	return [
		['roadmap', str(scope.roadmap_id)],
		['milestone', str(scope.milestone_id)],
		['change', str(scope.change_request_id)],
	]
}

function mapPrepareWaveDispatch(details: Record<string, unknown>): MoshiNotificationEvent {
	const assignments = Array.isArray(details.assignments) ? details.assignments : []
	const activeRuns = Array.isArray(details.active_runs) ? details.active_runs : []
	return {
		eventName: 'omr.wave.dispatch_prepared',
		category: 'tool_running',
		phase: 'omr_wave_dispatch',
		title: 'OMR wave dispatch ready',
		message: joinParts([
			['roadmap', str(details.roadmap_id)],
			['milestone', str(details.milestone_id)],
			['change', str(details.change_request_id)],
			['wave', str(details.wave_id)],
			['assignments', assignments.length],
			['active_runs', activeRuns.length],
		]),
	}
}

function mapRecordWorkerDispatch(details: Record<string, unknown>): MoshiNotificationEvent | undefined {
	const run = asRecord(details.run)
	if (!run) return undefined
	const replaces = str(run.replaces_agent_id)
	const base: Array<[string, unknown]> = [
		['task', str(details.task_id)],
		['wave', str(details.wave_id)],
		['worker', str(run.worker)],
		['agent', str(run.agent_id)],
		['job', str(run.job_id)],
	]
	if (replaces) {
		return {
			eventName: 'omr.worker.respawned',
			category: 'tool_running',
			phase: 'omr_workers_running',
			title: 'OMR worker respawned',
			message: joinParts([...base, ['replaces', replaces]]),
		}
	}
	return {
		eventName: 'omr.worker.spawned',
		category: 'tool_running',
		phase: 'omr_workers_running',
		title: 'OMR worker spawned',
		message: joinParts(base),
	}
}

function mapPrepareWorkerRedispatch(details: Record<string, unknown>): MoshiNotificationEvent {
	const assignment = asRecord(details.assignment)
	const priorRun = asRecord(details.prior_run)
	return {
		eventName: 'omr.worker.redispatch_prepared',
		category: 'tool_running',
		phase: 'omr_worker_redispatch',
		title: 'OMR worker redispatch ready',
		message: joinParts([
			['task', str(assignment?.task_id)],
			['wave', str(details.wave_id)],
			['prior_agent', str(priorRun?.agent_id)],
			['transport_failures', typeof priorRun?.transport_failures === 'number' ? priorRun.transport_failures : undefined],
		]),
	}
}

function mapRecordWaveResult(details: Record<string, unknown>): MoshiNotificationEvent {
	const blocker = asRecord(details.blocker)
	const status = str(details.status)
	const yielded = status === 'done' && !blocker
	if (yielded) {
		return {
			eventName: 'omr.worker.yielded',
			category: 'tool_finished',
			phase: 'omr_worker_yield',
			title: 'OMR worker yielded',
			message: joinParts([
				['task', str(details.task_id)],
				['wave', str(details.wave_id)],
				['status', status],
				['progress', str(details.progress_step)],
				['summary', str(details.summary)],
			]),
		}
	}
	return {
		eventName: 'omr.worker.blocked',
		category: 'approval_required',
		phase: 'omr_needs_input',
		title: 'OMR worker needs attention',
		message: joinParts([
			['task', str(details.task_id)],
			['wave', str(details.wave_id)],
			['status', status],
			['blocker', str(blocker?.id)],
			['blocker_title', str(blocker?.title)],
			['summary', str(details.summary)],
		]),
	}
}

function mapPrepareWaveReview(details: Record<string, unknown>): MoshiNotificationEvent {
	const tasks = Array.isArray(details.tasks) ? details.tasks : []
	return {
		eventName: 'omr.wave.review_started',
		category: 'tool_running',
		phase: 'omr_wave_review',
		title: 'OMR wave review starting',
		message: joinParts([
			['wave', str(details.wave_id)],
			['tasks', tasks.length],
			['reviewer', str(details.reviewer)],
		]),
	}
}

function blockerLabels(blockers: unknown): string[] {
	if (!Array.isArray(blockers)) return []
	return blockers
		.map((entry) => {
			const record = asRecord(entry)
			if (!record) return undefined
			const id = str(record.id)
			const title = str(record.title)
			if (id && title) return `${id} (${title})`
			return id ?? title
		})
		.filter((label): label is string => Boolean(label))
}

function mapRecordWaveReview(details: Record<string, unknown>): MoshiNotificationEvent | undefined {
	const waveStatus = str(details.wave_status)
	const blockers = blockerLabels(details.blockers)
	if (waveStatus === 'complete') {
		const nextActions = Array.isArray(details.next_actions) ? details.next_actions : []
		const nextLabel = str(asRecord(nextActions[0])?.label)
		return {
			eventName: 'omr.wave.review_passed',
			category: 'task_complete',
			phase: 'omr_wave_review',
			title: 'OMR wave passed review',
			message: joinParts([
				['wave', str(details.wave_id)],
				['progress', str(details.progress_step)],
				['next', nextLabel],
			]),
		}
	}
	if (blockers.length > 0) {
		return {
			eventName: 'omr.wave.review_blocked',
			category: 'approval_required',
			phase: 'omr_needs_input',
			title: 'OMR wave review blocked',
			message: joinParts([
				['wave', str(details.wave_id)],
				['blockers', blockers],
			]),
		}
	}
	return undefined
}

// Progress steps that represent a completed unit of work (vs ongoing running state).
const PROGRESS_COMPLETE_STEPS = new Set(['ready_for_next_wave', 'closeout_ready'])

function mapTransition(details: Record<string, unknown>, params: unknown): MoshiNotificationEvent | undefined {
	const operation = str(details.operation)
	if (!operation) return undefined
	const scope = asRecord(details.scope)
	const summary = str(details.summary)

	if (operation === 'update_implementation_progress') {
		const after = asRecord(details.after)
		const step = str(after?.step)
		const category: MoshiCategory = step && PROGRESS_COMPLETE_STEPS.has(step) ? 'task_complete' : 'tool_running'
		const activeTaskIds = Array.isArray(after?.active_task_ids) ? (after?.active_task_ids as unknown[]) : []
		return {
			eventName: 'omr.progress.updated',
			category,
			phase: 'omr_progress',
			title: 'OMR progress updated',
			message: joinParts([
				['step', step],
				['wave', str(after?.active_wave_id)],
				['tasks', activeTaskIds.map((id) => String(id))],
				['blocked_reason', str(after?.blocked_reason)],
			]),
		}
	}

	if (operation === 'request_bypass') {
		const reason = str(asRecord(params)?.reason)
		return {
			eventName: 'omr.bypass.requested',
			category: 'approval_required',
			phase: 'omr_needs_input',
			title: 'OMR bypass requested',
			message: joinParts([['summary', summary], ['reason', reason], ...scopeIds(scope)]),
		}
	}

	if (operation === 'record_closeout' || operation === 'start_closeout' || operation === 'complete_milestone') {
		const isMilestoneComplete = operation === 'complete_milestone'
		return {
			eventName: isMilestoneComplete ? 'omr.milestone.completed' : 'omr.closeout.updated',
			category: 'task_complete',
			phase: 'omr_closeout',
			title: isMilestoneComplete ? 'OMR milestone complete' : 'OMR closeout updated',
			message: joinParts([['summary', summary], ...scopeIds(scope)]),
		}
	}

	return undefined
}

// Inspect a successful OMR tool result and return the notification it maps to, or
// undefined for tools/results that are not high-signal state changes.
export function mapRoadmapToolResult(toolName: string, params: unknown, result: unknown): MoshiNotificationEvent | undefined {
	const details = detailsOf(result)
	if (!details) return undefined
	switch (toolName) {
		case 'omr_prepare_wave_dispatch':
			return mapPrepareWaveDispatch(details)
		case 'omr_record_worker_dispatch':
			return mapRecordWorkerDispatch(details)
		case 'omr_prepare_worker_redispatch':
			return mapPrepareWorkerRedispatch(details)
		case 'omr_record_wave_result':
			return mapRecordWaveResult(details)
		case 'omr_prepare_wave_review':
			return mapPrepareWaveReview(details)
		case 'omr_record_wave_review':
			return mapRecordWaveReview(details)
		case 'omr_transition':
			return mapTransition(details, params)
		default:
			return undefined
	}
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

// Called from the universal tool wrapper after a successful tool result. Loads the
// merged OMR config, maps the result to a notification, and delivers it. All failures
// are swallowed; a non-throwing tool error result is ignored.
export async function notifyMoshiForRoadmapToolResult(
	ctx: ExtensionContext,
	toolName: string,
	params: unknown,
	result: unknown,
	logger?: MoshiLogger,
): Promise<void> {
	try {
		if (asRecord(result)?.isError === true) return
		const event = mapRoadmapToolResult(toolName, params, result)
		if (!event) return
		const config = await loadMoshiConfig(ctx.cwd)
		if (config.enabled !== true) return
		await deliver(ctx, config, event, logger)
	} catch {
		// Notification must never affect the tool result.
	}
}

async function hasActiveOmrContext(cwd: string): Promise<boolean> {
	try {
		const state = await loadState(cwd)
		if (state.active && state.roadmap) return true
		return Boolean(await loadAdhocActive(cwd))
	} catch {
		return false
	}
}

function firstQuestionText(args: unknown): string | undefined {
	const questions = asRecord(args)?.questions
	if (!Array.isArray(questions)) return undefined
	return str(asRecord(questions[0])?.question)
}

async function notifyAsk(api: ExtensionAPI, ctx: ExtensionContext, event: ToolExecutionStartEvent): Promise<void> {
	try {
		const config = await loadMoshiConfig(ctx.cwd)
		if (config.enabled !== true) return
		if (!(await hasActiveOmrContext(ctx.cwd))) return
		await deliver(
			ctx,
			config,
			{
				eventName: 'omr.ask.input_required',
				category: 'approval_required',
				phase: 'omr_needs_input',
				title: 'OMR needs input',
				message: firstQuestionText(event.args) ?? 'OMR asked the user for input.',
				toolName: 'ask',
			},
			api.logger,
		)
	} catch {
		// notify-only; ignore failures
	}
}

const NEEDS_INPUT_STATUSES = new Set(['blocked', 'needs_input', 'approval_required'])

async function notifyAgentStop(api: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	try {
		const config = await loadMoshiConfig(ctx.cwd)
		if (config.enabled !== true) return
		if (!(await hasActiveOmrContext(ctx.cwd))) return
		const next = await nextActionPlan(ctx.cwd)
		if (NEEDS_INPUT_STATUSES.has(next.status)) {
			const parts = [next.description]
			if (next.blockers.length > 0) parts.push(`Blockers: ${next.blockers.join(', ')}`)
			if (next.missing_inputs.length > 0) parts.push(`Missing: ${next.missing_inputs.join(', ')}`)
			await deliver(
				ctx,
				config,
				{
					eventName: 'omr.agent.stopped_needs_input',
					category: 'approval_required',
					phase: 'omr_needs_input',
					title: `OMR stopped: ${next.label}`,
					message: parts.filter((part) => part && part.trim() !== '').join(' '),
				},
				api.logger,
			)
			return
		}
		await deliver(
			ctx,
			config,
			{
				eventName: 'omr.agent.stopped',
				category: 'task_complete',
				phase: 'omr_agent_stopped',
				title: 'OMR agent stopped',
				message: `Next action: ${next.label} (${next.status}). ${next.description}`,
			},
			api.logger,
		)
	} catch {
		// notify-only; ignore failures
	}
}

// Register OMR-specific Moshi notifications for `ask` prompts and main-agent stops.
// Only fires when Moshi is enabled in the merged OMR config and an OMR roadmap/ad-hoc
// plan is active. This coexists with Moshi's generic OMP AgentEnd hook: that says a
// turn ended, this says what OMR needs next.
export function registerRoadmapMoshiNotifications(api: ExtensionAPI): void {
	api.on('tool_execution_start', async (event: ToolExecutionStartEvent, ctx) => {
		if (event.toolName !== 'ask') return
		await notifyAsk(api, ctx, event)
	})
	api.on('agent_end', async (_event: AgentEndEvent, ctx) => {
		await notifyAgentStop(api, ctx)
	})
}
