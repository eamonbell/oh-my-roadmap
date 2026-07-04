import {spawnSync} from 'node:child_process'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type {AgentEndEvent, ExtensionAPI, ExtensionContext, ToolExecutionStartEvent} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {loadMoshiConfig, type MoshiConfig} from '@oh-my-roadmap/core/project-init'
import {nextActionPlan} from '@oh-my-roadmap/core/report/index'
import {loadAdhocActive, loadAdhocPlan, loadState} from '@oh-my-roadmap/core/store/index'

// Opt-in Moshi notifications. This module speaks Moshi's documented local-socket
// `session.update` protocol (newline-delimited JSON over a Unix socket, one logical
// exchange per connection). A "live activity" in Moshi is the single mutable inbox row
// per sessionId: frames sharing one sessionId collapse into one continuously-updating
// row. This module walks that row through each OMR workflow's phases. It never reads
// Moshi tokens/secrets, never falls back to any HTTP endpoint, and never fails or
// meaningfully delays an OMR tool result.

// How long to wait for the daemon to ack before giving up on a single frame.
const SEND_TIMEOUT_MS = 500
// Suppress an identical notification within this window.
const DEDUPE_WINDOW_MS = 5000
// Drop dedupe bookkeeping older than this on each send attempt.
const DEDUPE_PRUNE_MS = 60000
// Best-effort budget for each terminal-context shell-out (resolved once, cached).
const TERMINAL_SHELL_TIMEOUT_MS = 250

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
// Terminal-correlation fields bind the row to the physical pane in the Moshi app.
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
	// Percent of context window remaining (matches Moshi's `contextRemaining` wire field).
	contextRemaining?: number;
	terminalKind?: string;
	tmuxSession?: string;
	tmuxWindow?: string;
	tmuxPane?: string;
	tmuxSocket?: string;
	zellijSession?: string;
	zellijPane?: string;
	herdrSession?: string;
	herdrPane?: string;
	herdrWorkspaceId?: string;
	herdrWorkspace?: string;
	herdrTabId?: string;
	herdrTab?: string;
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
// Terminal correlation (resolved once, cached)
// ---------------------------------------------------------------------------

interface TerminalContext {
	terminalKind: string;
	tmuxSession: string;
	tmuxWindow: string;
	tmuxPane: string;
	tmuxSocket: string;
	zellijSession: string;
	zellijPane: string;
	herdrSession: string;
	herdrPane: string;
	herdrWorkspaceId: string;
	herdrWorkspace: string;
	herdrTabId: string;
	herdrTab: string;
}

const EMPTY_TERMINAL_CONTEXT: TerminalContext = {
	terminalKind: '', tmuxSession: '', tmuxWindow: '', tmuxPane: '', tmuxSocket: '',
	zellijSession: '', zellijPane: '', herdrSession: '', herdrPane: '',
	herdrWorkspaceId: '', herdrWorkspace: '', herdrTabId: '', herdrTab: '',
}

let cachedTerminalContext: TerminalContext | undefined

function tmuxSocketFromEnv(value: string | undefined): string {
	if (!value) return ''
	const idx = value.indexOf(',')
	return idx > 0 ? value.slice(0, idx) : ''
}

function safeSpawn(command: string, args: string[]): string {
	try {
		const result = spawnSync(command, args, {encoding: 'utf8', timeout: TERMINAL_SHELL_TIMEOUT_MS})
		return typeof result.stdout === 'string' ? result.stdout : ''
	} catch {
		return ''
	}
}

function herdrFocusedPane(session: string): string {
	const args: string[] = []
	if (session) args.push('--session', session)
	args.push('pane', 'list')
	const text = safeSpawn('herdr', args)
	if (!text) return ''
	try {
		const payload = JSON.parse(text) as {result?: {panes?: Array<{pane_id?: string; focused?: boolean}>}}
		return payload.result?.panes?.find((pane) => pane.focused && pane.pane_id)?.pane_id ?? ''
	} catch {
		return ''
	}
}

function herdrPaneIds(session: string, paneId: string): {paneId: string; workspaceId: string; tabId: string} {
	if (!paneId) return {paneId: '', workspaceId: '', tabId: ''}
	const args: string[] = []
	if (session) args.push('--session', session)
	args.push('pane', 'get', paneId)
	const text = safeSpawn('herdr', args)
	if (!text) return {paneId, workspaceId: '', tabId: ''}
	try {
		const payload = JSON.parse(text) as {result?: {pane?: {pane_id?: string; workspace_id?: string; tab_id?: string}}}
		const pane = payload.result?.pane
		return {paneId: pane?.pane_id ?? paneId, workspaceId: pane?.workspace_id ?? '', tabId: pane?.tab_id ?? ''}
	} catch {
		return {paneId, workspaceId: '', tabId: ''}
	}
}

// Detect the enclosing terminal multiplexer once. Best-effort: any failure yields empty
// fields (the row still updates by sessionId, it just loses pane attachment).
function resolveTerminalContext(): TerminalContext {
	try {
		const tmuxPane = process.env.TMUX_PANE ?? ''
		const tmuxSocket = tmuxSocketFromEnv(process.env.TMUX)
		let tmuxSession = ''
		let tmuxWindow = ''
		if (process.env.TMUX) {
			const args = ['display-message', '-p']
			if (tmuxPane) args.push('-t', tmuxPane)
			args.push('#S\t#I')
			const text = safeSpawn('tmux', args).trim()
			if (text) {
				const [session, window] = text.split('\t', 2)
				tmuxSession = session ?? ''
				tmuxWindow = window ?? ''
			}
		}
		const zellijSession = process.env.ZELLIJ_SESSION_NAME ?? ''
		const zellijPane = process.env.ZELLIJ_PANE_ID ?? ''
		const herdrOn = process.env.HERDR_ENV === '1'
		const herdrSession = herdrOn ? process.env.HERDR_SESSION ?? '' : ''
		const herdr = herdrOn
			? herdrPaneIds(herdrSession, process.env.HERDR_PANE_ID ?? herdrFocusedPane(herdrSession))
			: {paneId: '', workspaceId: '', tabId: ''}
		let terminalKind = ''
		if (tmuxSession) terminalKind = 'tmux'
		else if (herdrOn) terminalKind = 'herdr'
		else if (process.env.ZELLIJ || zellijSession || zellijPane) terminalKind = 'zellij'
		return {
			terminalKind, tmuxSession, tmuxWindow, tmuxPane, tmuxSocket,
			zellijSession, zellijPane, herdrSession, herdrPane: herdr.paneId,
			herdrWorkspaceId: herdr.workspaceId, herdrWorkspace: '', herdrTabId: herdr.tabId, herdrTab: '',
		}
	} catch {
		return EMPTY_TERMINAL_CONTEXT
	}
}

function terminalContext(): TerminalContext {
	if (!cachedTerminalContext) cachedTerminalContext = resolveTerminalContext()
	return cachedTerminalContext
}

// Exposed for tests: drop the cached terminal context so a fresh env is re-read.
export function resetTerminalContextCache(): void {
	cachedTerminalContext = undefined
}

function applyTerminalContext(frame: MoshiSessionUpdateFrame): void {
	const tc = terminalContext()
	if (tc.terminalKind) frame.terminalKind = tc.terminalKind
	if (tc.tmuxSession) frame.tmuxSession = tc.tmuxSession
	if (tc.tmuxWindow) frame.tmuxWindow = tc.tmuxWindow
	if (tc.tmuxPane) frame.tmuxPane = tc.tmuxPane
	if (tc.tmuxSocket) frame.tmuxSocket = tc.tmuxSocket
	if (tc.zellijSession) frame.zellijSession = tc.zellijSession
	if (tc.zellijPane) frame.zellijPane = tc.zellijPane
	if (tc.herdrSession) frame.herdrSession = tc.herdrSession
	if (tc.herdrPane) frame.herdrPane = tc.herdrPane
	if (tc.herdrWorkspaceId) frame.herdrWorkspaceId = tc.herdrWorkspaceId
	if (tc.herdrWorkspace) frame.herdrWorkspace = tc.herdrWorkspace
	if (tc.herdrTabId) frame.herdrTabId = tc.herdrTabId
	if (tc.herdrTab) frame.herdrTab = tc.herdrTab
}

// ---------------------------------------------------------------------------
// Frame construction (pure aside from cached terminal context)
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

// Percent of context window REMAINING (Moshi's wire semantics), from percent used.
function resolveContextRemaining(ctx: MoshiContextLike): number | undefined {
	if (typeof ctx.getContextUsage !== 'function') return undefined
	let usage: {percent?: number} | undefined
	try {
		usage = ctx.getContextUsage()
	} catch {
		return undefined
	}
	const percent = usage?.percent
	if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined
	const remaining = 100 - Math.round(percent)
	return remaining <= 0 ? 1 : remaining
}

// Prefer the terminal session name over the cwd basename, matching Moshi's own client.
function resolveProjectName(cwd: string): string {
	const tc = terminalContext()
	return tc.tmuxSession || tc.herdrSession || tc.zellijSession || path.basename(cwd) || cwd
}

export function buildMoshiSessionUpdate(ctx: MoshiContextLike, event: MoshiNotificationEvent): MoshiSessionUpdateFrame {
	const cwd = ctx.cwd
	const frame: MoshiSessionUpdateFrame = {
		type: 'session.update',
		source: 'omp',
		sessionId: resolveSessionId(ctx),
		eventName: event.eventName,
		// Only `waitingForApproval` drives daemon state; other phase labels are cosmetic.
		phase: event.category === 'approval_required' ? 'waitingForApproval' : event.phase,
		category: event.category,
		cwd,
		projectName: resolveProjectName(cwd),
		title: event.title,
		message: event.message,
		requestedAt: new Date().toISOString(),
	}
	const modelName = resolveModelName(ctx.model)
	if (modelName) frame.modelName = modelName
	if (event.toolName) frame.toolName = event.toolName
	const contextRemaining = resolveContextRemaining(ctx)
	if (contextRemaining !== undefined) frame.contextRemaining = contextRemaining
	applyTerminalContext(frame)
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
	const key = [frame.sessionId, frame.eventName, frame.title, frame.message].join(' ')
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

function gateStatus(params: unknown, key: string): string | undefined {
	return str(asRecord(asRecord(params)?.[key])?.status)
}

// --- roadmap creation ---

function mapInitRoadmap(details: Record<string, unknown>): MoshiNotificationEvent {
	return {
		eventName: 'omr.roadmap.created',
		category: 'session_started',
		phase: 'omr_roadmap',
		title: 'OMR roadmap created',
		message: joinParts([
			['roadmap', str(details.roadmap_id)],
			['title', str(details.title)],
			['phase', str(details.phase)],
		]),
	}
}

function mapUpdateRoadmap(details: Record<string, unknown>): MoshiNotificationEvent {
	return {
		eventName: 'omr.roadmap.finalized',
		category: 'tool_running',
		phase: 'omr_roadmap',
		title: 'OMR roadmap finalized',
		message: joinParts([
			['roadmap', str(details.roadmap_id)],
			['milestones', Array.isArray(details.milestones) ? details.milestones.length : undefined],
		]),
	}
}

// --- wave / worker loop ---

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

// --- roadmap / milestone transitions ---

// Quiet (tool_running) informational transitions: eventName + title only.
const QUIET_TRANSITIONS: Record<string, {eventName: string; title: string}> = {
	record_discovery: {eventName: 'omr.roadmap.discovery_recorded', title: 'OMR discovery recorded'},
	approve_roadmap: {eventName: 'omr.roadmap.approved', title: 'OMR roadmap approved'},
	reopen_roadmap: {eventName: 'omr.roadmap.reopened', title: 'OMR roadmap reopened'},
	start_milestone_planning: {eventName: 'omr.milestone.planning_started', title: 'OMR milestone planning'},
	create_milestone_plan: {eventName: 'omr.milestone.plan_created', title: 'OMR milestone plan created'},
	update_milestone_plan: {eventName: 'omr.milestone.plan_updated', title: 'OMR milestone plan revised'},
	approve_milestone: {eventName: 'omr.milestone.approved', title: 'OMR milestone approved'},
	start_implementation: {eventName: 'omr.implementation.started', title: 'OMR implementation started'},
	start_reviewing: {eventName: 'omr.milestone.reviewing', title: 'OMR reviewing'},
	start_closeout: {eventName: 'omr.closeout.started', title: 'OMR closeout started'},
	record_closeout: {eventName: 'omr.closeout.recorded', title: 'OMR closeout recorded'},
	clear_bypass: {eventName: 'omr.bypass.cleared', title: 'OMR bypass cleared'},
	approve_change: {eventName: 'omr.change.approved', title: 'OMR change approved'},
	update_change_request_plan: {eventName: 'omr.change.plan_updated', title: 'OMR change plan revised'},
}

function mapTransition(details: Record<string, unknown>, params: unknown): MoshiNotificationEvent | undefined {
	const operation = str(details.operation)
	if (!operation) return undefined
	const scope = asRecord(details.scope)
	const summary = str(details.summary)
	const scopeMessage = () => joinParts([['summary', summary], ...scopeIds(scope)])

	if (operation === 'update_implementation_progress') {
		const after = asRecord(details.after)
		const activeTaskIds = Array.isArray(after?.active_task_ids) ? (after?.active_task_ids as unknown[]) : []
		return {
			eventName: 'omr.progress.updated',
			category: 'tool_running',
			phase: 'omr_progress',
			title: 'OMR progress updated',
			message: joinParts([
				['step', str(after?.step)],
				['wave', str(after?.active_wave_id)],
				['tasks', activeTaskIds.map((id) => String(id))],
				['blocked_reason', str(after?.blocked_reason)],
			]),
		}
	}

	if (operation === 'record_roadmap_milestone_check' || operation === 'record_wave_flow_check') {
		const isRoadmap = operation === 'record_roadmap_milestone_check'
		const status = gateStatus(params, isRoadmap ? 'roadmapMilestoneCheck' : 'waveFlowCheck')
		const failed = status === 'failed'
		return {
			eventName: isRoadmap
				? failed ? 'omr.gate.roadmap_failed' : 'omr.gate.roadmap_passed'
				: failed ? 'omr.gate.wave_flow_failed' : 'omr.gate.wave_flow_passed',
			category: failed ? 'approval_required' : 'tool_running',
			phase: failed ? 'omr_needs_input' : 'omr_gate',
			title: isRoadmap
				? failed ? 'OMR roadmap gate failed' : 'OMR roadmap gate passed'
				: failed ? 'OMR wave-flow gate failed' : 'OMR wave-flow gate passed',
			message: joinParts([['status', status], ['summary', summary], ...scopeIds(scope)]),
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

	if (operation === 'complete_milestone' || operation === 'close_change') {
		const milestone = operation === 'complete_milestone'
		return {
			eventName: milestone ? 'omr.milestone.completed' : 'omr.change.closed',
			category: 'task_complete',
			phase: 'omr_complete',
			title: milestone ? 'OMR milestone complete' : 'OMR change request closed',
			message: scopeMessage(),
		}
	}

	const quiet = QUIET_TRANSITIONS[operation]
	if (quiet) {
		return {
			eventName: quiet.eventName,
			category: 'tool_running',
			phase: 'omr_progress',
			title: quiet.title,
			message: scopeMessage(),
		}
	}

	return undefined
}

// --- ad-hoc plans ---

const ADHOC_TRANSITION_LABELS: Record<string, {eventName: string; title: string}> = {
	approve: {eventName: 'omr.adhoc.approved', title: 'OMR ad-hoc approved'},
	start_implementing: {eventName: 'omr.adhoc.implementing', title: 'OMR ad-hoc implementing'},
	start_reviewing: {eventName: 'omr.adhoc.reviewing', title: 'OMR ad-hoc reviewing'},
	record_closeout: {eventName: 'omr.adhoc.closeout', title: 'OMR ad-hoc closeout'},
}

function adhocMessage(details: Record<string, unknown>): string {
	return joinParts([
		['adhoc', str(details.adhoc_id)],
		['title', str(details.title)],
		['status', str(details.status)],
	])
}

function mapInitAdhoc(details: Record<string, unknown>): MoshiNotificationEvent {
	return {eventName: 'omr.adhoc.created', category: 'session_started', phase: 'omr_adhoc', title: 'OMR ad-hoc plan created', message: adhocMessage(details)}
}

function mapUpdateAdhoc(details: Record<string, unknown>): MoshiNotificationEvent {
	return {eventName: 'omr.adhoc.plan_updated', category: 'tool_running', phase: 'omr_adhoc', title: 'OMR ad-hoc plan revised', message: adhocMessage(details)}
}

// `details` is undefined for the cancel operation (the tool returns null details).
function mapAdhocTransition(details: Record<string, unknown> | undefined, params: unknown): MoshiNotificationEvent | undefined {
	const operation = str(asRecord(params)?.operation)
	if (operation === 'cancel') {
		return {eventName: 'omr.adhoc.cancelled', category: 'task_complete', phase: 'omr_complete', title: 'OMR ad-hoc plan cancelled', message: 'Ad-hoc plan cancelled.'}
	}
	if (!details) return undefined
	if (operation === 'record_wave_flow_check') {
		const status = str(asRecord(details.wave_flow_check)?.status)
		const failed = status === 'failed'
		return {
			eventName: failed ? 'omr.adhoc.wave_flow_failed' : 'omr.adhoc.wave_flow_passed',
			category: failed ? 'approval_required' : 'tool_running',
			phase: failed ? 'omr_needs_input' : 'omr_adhoc',
			title: failed ? 'OMR ad-hoc gate failed' : 'OMR ad-hoc gate passed',
			message: joinParts([['adhoc', str(details.adhoc_id)], ['status', status]]),
		}
	}
	if (operation === 'complete') {
		return {eventName: 'omr.adhoc.completed', category: 'task_complete', phase: 'omr_complete', title: 'OMR ad-hoc plan complete', message: adhocMessage(details)}
	}
	const label = operation ? ADHOC_TRANSITION_LABELS[operation] : undefined
	if (label) {
		return {eventName: label.eventName, category: 'tool_running', phase: 'omr_adhoc', title: label.title, message: adhocMessage(details)}
	}
	return undefined
}

// Inspect a successful OMR tool result and return the notification it maps to, or
// undefined for tools/results that are not high-signal state changes.
export function mapRoadmapToolResult(toolName: string, params: unknown, result: unknown): MoshiNotificationEvent | undefined {
	// omr_adhoc_transition returns null details on cancel — handle before the guard.
	if (toolName === 'omr_adhoc_transition') return mapAdhocTransition(detailsOf(result), params)

	const details = detailsOf(result)
	if (!details) return undefined
	switch (toolName) {
		case 'omr_init':
			return mapInitRoadmap(details)
		case 'omr_update_roadmap':
			return mapUpdateRoadmap(details)
		case 'omr_init_adhoc':
			return mapInitAdhoc(details)
		case 'omr_update_adhoc_plan':
			return mapUpdateAdhoc(details)
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

// Which OMR workflow (if any) is active in this project.
async function activeOmrContext(cwd: string): Promise<'roadmap' | 'adhoc' | undefined> {
	try {
		const state = await loadState(cwd)
		if (state.active && state.roadmap) return 'roadmap'
		return (await loadAdhocActive(cwd)) ? 'adhoc' : undefined
	} catch {
		return undefined
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
		if (!(await activeOmrContext(ctx.cwd))) return
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

// Stop summary for the roadmap/change-request path, driven by nextActionPlan.
async function roadmapStopEvent(cwd: string): Promise<MoshiNotificationEvent> {
	const next = await nextActionPlan(cwd)
	if (NEEDS_INPUT_STATUSES.has(next.status)) {
		const parts = [next.description]
		if (next.blockers.length > 0) parts.push(`Blockers: ${next.blockers.join(', ')}`)
		if (next.missing_inputs.length > 0) parts.push(`Missing: ${next.missing_inputs.join(', ')}`)
		return {
			eventName: 'omr.agent.stopped_needs_input',
			category: 'approval_required',
			phase: 'omr_needs_input',
			title: `OMR stopped: ${next.label}`,
			message: parts.filter((part) => part && part.trim() !== '').join(' '),
		}
	}
	return {
		eventName: 'omr.agent.stopped',
		category: 'task_complete',
		phase: 'omr_agent_stopped',
		title: 'OMR agent stopped',
		message: `Next action: ${next.label} (${next.status}). ${next.description}`,
	}
}

// The subset of an AdhocPlan the stop summary reads. Structural so tests can pass a
// fabricated plan without constructing a full store fixture.
interface AdhocStopPlanLike {
	adhoc_id?: string;
	status?: string;
	progress?: {step?: string; blocked_reason?: string};
	wave_flow_check?: {status?: string};
}

// Pure stop summary for the ad-hoc path. nextActionPlan has no ad-hoc branch (it would
// return a bogus "Create roadmap"), so derive the summary from the plan's own state.
export function adhocStopEventFromPlan(plan: AdhocStopPlanLike): MoshiNotificationEvent {
	const status = plan.status ?? 'unknown'
	const blockedReason = plan.progress?.blocked_reason
	const gateFailed = plan.wave_flow_check?.status === 'failed'
	if (blockedReason || gateFailed) {
		return {
			eventName: 'omr.adhoc.stopped_needs_input',
			category: 'approval_required',
			phase: 'omr_needs_input',
			title: 'OMR ad-hoc needs attention',
			message: joinParts([
				['adhoc', str(plan.adhoc_id)],
				['status', status],
				['blocked', str(blockedReason)],
				['gate', gateFailed ? 'failed' : undefined],
			]),
		}
	}
	const done = status === 'complete'
	return {
		eventName: done ? 'omr.adhoc.stopped_complete' : 'omr.adhoc.stopped',
		category: done ? 'task_complete' : 'tool_running',
		phase: done ? 'omr_complete' : 'omr_adhoc',
		title: done ? 'OMR ad-hoc plan complete' : `OMR ad-hoc stopped: ${status}`,
		message: joinParts([['adhoc', str(plan.adhoc_id)], ['status', status], ['step', str(plan.progress?.step)]]),
	}
}

async function adhocStopEvent(cwd: string): Promise<MoshiNotificationEvent | undefined> {
	const pointer = await loadAdhocActive(cwd)
	if (!pointer) return undefined
	const plan = await loadAdhocPlan(cwd, pointer.adhoc_id)
	if (!plan) return undefined
	return adhocStopEventFromPlan(plan)
}

async function notifyAgentStop(api: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	try {
		const config = await loadMoshiConfig(ctx.cwd)
		if (config.enabled !== true) return
		const kind = await activeOmrContext(ctx.cwd)
		if (!kind) return
		const event = kind === 'adhoc' ? await adhocStopEvent(ctx.cwd) : await roadmapStopEvent(ctx.cwd)
		if (!event) return
		await deliver(ctx, config, event, api.logger)
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
