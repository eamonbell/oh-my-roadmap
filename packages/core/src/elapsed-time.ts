// Pure pause-aware elapsed-time tracking per scope.
//
// The clock starts at first wave dispatch, pauses on soft-limit or manual
// disable (stopping the clock), and resumes from the prior accumulated total.
// State is a plain serializable object so it survives session resume without
// losing or double-counting time: pause freezes the running interval into
// `accumulated_ms` and drops `started_at`; resume stamps a fresh `started_at`
// without touching `accumulated_ms`.
//
// All functions are PURE: they take state as input and return a new state
// object, performing no I/O and never mutating the input argument. Timestamps
// are ISO 8601 strings (consistent with nowIso() from store/shared.ts); elapsed
// computation uses Date.parse() for the difference.

export interface TimeTracking {
	started_at?: string
	paused_at?: string
	accumulated_ms: number
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

export function emptyTimeTracking(): TimeTracking {
	return { accumulated_ms: 0 }
}

// Start the clock. If state is undefined or not running (started_at undefined),
// stamp a fresh `started_at = now` without resetting `accumulated_ms`. Idempotent:
// an already-running clock (started_at set, no paused_at) is returned unchanged.
export function startTimeClock(state: TimeTracking | undefined, now: string): TimeTracking {
	if (state === undefined || state.started_at === undefined) {
		return { started_at: now, accumulated_ms: state?.accumulated_ms ?? 0 }
	}
	return { ...state }
}

// Stop the clock and fold the running interval into `accumulated_ms`. Only acts
// on a running clock (started_at set, paused_at undefined); an already-paused or
// stopped clock is returned unchanged. A new object is returned with started_at
// dropped and paused_at stamped, so the paused interval contributes no further
// time until resume.
export function pauseTimeClock(state: TimeTracking, now: string): TimeTracking {
	if (state.started_at === undefined || state.paused_at !== undefined) {
		return { ...state }
	}
	const elapsed = Date.parse(now) - Date.parse(state.started_at)
	return {
		accumulated_ms: state.accumulated_ms + elapsed,
		paused_at: now,
	}
}

// Resume the clock from a paused state by stamping a fresh `started_at = now`
// and dropping `paused_at`, leaving `accumulated_ms` untouched. An already-
// running or stopped clock is returned unchanged.
export function resumeTimeClock(state: TimeTracking, now: string): TimeTracking {
	if (state.paused_at === undefined) {
		return { ...state }
	}
	return {
		started_at: now,
		accumulated_ms: state.accumulated_ms,
	}
}

// Total elapsed milliseconds at `now`. Zero for no state. For a running clock,
// accumulated_ms plus the current open interval. For a paused or stopped clock,
// just accumulated_ms (the paused interval contributes nothing).
export function getElapsedMs(state: TimeTracking | undefined, now: string): number {
	if (state === undefined) return 0
	if (state.started_at !== undefined && state.paused_at === undefined) {
		return state.accumulated_ms + (Date.parse(now) - Date.parse(state.started_at))
	}
	return state.accumulated_ms
}

// Deserialize a TimeTracking from a raw (YAML-loaded) value. undefined/null
// yields an empty state. accumulated_ms must be a non-negative finite number
// (defaults to 0); started_at/paused_at must be strings when present. Unknown
// keys are rejected so a schema drift fails loudly.
export function normalizeTimeTracking(value: unknown): TimeTracking {
	if (value === undefined || value === null) return emptyTimeTracking()
	const obj = requirePlainObject(value, 'time_tracking')
	rejectUnknownKeys(obj, ['started_at', 'paused_at', 'accumulated_ms'], 'time_tracking')

	let accumulated_ms = 0
	if (obj.accumulated_ms !== undefined) {
		if (typeof obj.accumulated_ms !== 'number' || !Number.isFinite(obj.accumulated_ms) || obj.accumulated_ms < 0) {
			throw new Error('time_tracking.accumulated_ms must be a non-negative finite number')
		}
		accumulated_ms = obj.accumulated_ms
	}

	const result: TimeTracking = { accumulated_ms }
	if (obj.started_at !== undefined) {
		if (typeof obj.started_at !== 'string') throw new Error('time_tracking.started_at must be a string')
		result.started_at = obj.started_at
	}
	if (obj.paused_at !== undefined) {
		if (typeof obj.paused_at !== 'string') throw new Error('time_tracking.paused_at must be a string')
		result.paused_at = obj.paused_at
	}
	return result
}
