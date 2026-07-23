import { describe, expect, test } from 'bun:test'
import {
	type TimeTracking,
	emptyTimeTracking,
	startTimeClock,
	pauseTimeClock,
	resumeTimeClock,
	getElapsedMs,
	normalizeTimeTracking,
} from '@oh-my-roadmap/core/elapsed-time'

// Fixed ISO timestamps (10s / 30s / 60s / 120s after T0).
const T0 = '2026-07-22T00:00:00.000Z'
const T1 = '2026-07-22T00:00:10.000Z'
const T2 = '2026-07-22T00:00:30.000Z'
const T3 = '2026-07-22T00:01:00.000Z'
const T4 = '2026-07-22T00:02:00.000Z'

describe('emptyTimeTracking', () => {
	test('returns a fresh state with zero accumulated time', () => {
		expect(emptyTimeTracking()).toEqual({ accumulated_ms: 0 })
	})

	test('returns a new object each call (no shared reference)', () => {
		const a = emptyTimeTracking()
		const b = emptyTimeTracking()
		expect(a).not.toBe(b)
		expect(a).toEqual(b)
	})
})

describe('startTimeClock', () => {
	test('starts the clock from no state, stamping started_at', () => {
		expect(startTimeClock(undefined, T0)).toEqual({ started_at: T0, accumulated_ms: 0 })
	})

	test('does not reset accumulated_ms when starting from a non-running state', () => {
		const prior: TimeTracking = { accumulated_ms: 5000 }
		expect(startTimeClock(prior, T0)).toEqual({ started_at: T0, accumulated_ms: 5000 })
	})

	test('is idempotent: a second call while running is a no-op', () => {
		const running = startTimeClock(undefined, T0)
		const again = startTimeClock(running, T1)
		expect(again).toEqual({ started_at: T0, accumulated_ms: 0 })
		// starting_at must not advance to the second `now`.
		expect(again.started_at).toBe(T0)
	})

	test('third call while still running remains a no-op', () => {
		let state = startTimeClock(undefined, T0)
		state = startTimeClock(state, T1)
		state = startTimeClock(state, T2)
		expect(state).toEqual({ started_at: T0, accumulated_ms: 0 })
	})
})

describe('pauseTimeClock', () => {
	test('stops the clock and folds the running interval into accumulated_ms', () => {
		const running = startTimeClock(undefined, T0)
		const paused = pauseTimeClock(running, T1)
		expect(paused).toEqual({ accumulated_ms: 10000, paused_at: T1 })
		expect(paused.started_at).toBeUndefined()
	})

	test('adds the running interval on top of prior accumulated_ms', () => {
		const running: TimeTracking = { started_at: T1, accumulated_ms: 5000 }
		const paused = pauseTimeClock(running, T2)
		expect(paused).toEqual({ accumulated_ms: 25000, paused_at: T2 })
	})

	test('is a no-op when already paused', () => {
		const paused: TimeTracking = { accumulated_ms: 10000, paused_at: T1 }
		expect(pauseTimeClock(paused, T2)).toEqual({ accumulated_ms: 10000, paused_at: T1 })
	})

	test('is a no-op when not running (no started_at)', () => {
		const stopped: TimeTracking = { accumulated_ms: 1000 }
		expect(pauseTimeClock(stopped, T1)).toEqual({ accumulated_ms: 1000 })
	})
})

describe('resumeTimeClock', () => {
	test('resumes from a paused state with a fresh started_at, preserving accumulated_ms', () => {
		const paused: TimeTracking = { accumulated_ms: 10000, paused_at: T1 }
		const resumed = resumeTimeClock(paused, T2)
		expect(resumed).toEqual({ started_at: T2, accumulated_ms: 10000 })
		expect(resumed.paused_at).toBeUndefined()
	})

	test('is a no-op when already running', () => {
		const running: TimeTracking = { started_at: T0, accumulated_ms: 0 }
		expect(resumeTimeClock(running, T1)).toEqual({ started_at: T0, accumulated_ms: 0 })
	})

	test('is a no-op when stopped (no paused_at)', () => {
		const stopped: TimeTracking = { accumulated_ms: 1000 }
		expect(resumeTimeClock(stopped, T0)).toEqual({ accumulated_ms: 1000 })
	})
})

describe('getElapsedMs', () => {
	test('returns 0 for undefined state', () => {
		expect(getElapsedMs(undefined, T0)).toBe(0)
	})

	test('returns accumulated_ms plus the open interval while running', () => {
		const running: TimeTracking = { started_at: T0, accumulated_ms: 0 }
		expect(getElapsedMs(running, T1)).toBe(10000)
	})

	test('includes prior accumulated_ms while running', () => {
		const running: TimeTracking = { started_at: T1, accumulated_ms: 5000 }
		expect(getElapsedMs(running, T2)).toBe(25000)
	})

	test('returns accumulated_ms only when paused (no growth during pause)', () => {
		const paused: TimeTracking = { accumulated_ms: 10000, paused_at: T1 }
		expect(getElapsedMs(paused, T2)).toBe(10000)
		expect(getElapsedMs(paused, T3)).toBe(10000)
	})

	test('returns accumulated_ms only when stopped (no started_at)', () => {
		const stopped: TimeTracking = { accumulated_ms: 7000 }
		expect(getElapsedMs(stopped, T2)).toBe(7000)
	})
})

describe('pause/resume cycle (no double-counting)', () => {
	test('pause -> resume -> pause excludes the paused interval and never double-counts', () => {
		let state = startTimeClock(undefined, T0) // running from T0
		expect(getElapsedMs(state, T1)).toBe(10000)

		state = pauseTimeClock(state, T1) // 10s accumulated, paused at T1
		// The whole T1 -> T2 gap (20s) must NOT count while paused.
		expect(getElapsedMs(state, T2)).toBe(10000)

		state = resumeTimeClock(state, T2) // fresh started_at = T2, accumulated still 10000
		expect(getElapsedMs(state, T3)).toBe(40000) // 10000 + (T3 - T2 = 30000)

		state = pauseTimeClock(state, T3) // 40000 accumulated, paused at T3
		expect(getElapsedMs(state, T4)).toBe(40000) // paused again, no growth

		// Total real time T0 -> T4 is 120000ms; paused spans T1->T2 (20000) and
		// T3->T4 (60000) = 80000ms. Active time = 120000 - 80000 = 40000ms.
		expect(state).toEqual({ accumulated_ms: 40000, paused_at: T3 })
	})

	test('multiple pause/resume cycles accumulate only active intervals', () => {
		// Cycle 1: active T0->T1 (10s), paused T1->T2 (20s)
		let state = pauseTimeClock(startTimeClock(undefined, T0), T1)
		// Cycle 2: active T2->T3 (30s), paused at T3
		state = pauseTimeClock(resumeTimeClock(state, T2), T3)
		expect(state.accumulated_ms).toBe(40000)
		// Cycle 3: active T3->T4 (60s)
		state = resumeTimeClock(state, T3)
		expect(getElapsedMs(state, T4)).toBe(100000)
	})
})

describe('session resume roundtrip', () => {
	test('paused state survives serialize -> normalize -> getElapsedMs', () => {
		const original = pauseTimeClock(startTimeClock(undefined, T0), T1)
		const serialized = JSON.parse(JSON.stringify(original)) as unknown
		const restored = normalizeTimeTracking(serialized)
		expect(restored).toEqual(original)
		expect(getElapsedMs(restored, T2)).toBe(10000)
	})

	test('running state survives serialize -> normalize -> getElapsedMs', () => {
		const original: TimeTracking = { started_at: T0, accumulated_ms: 5000 }
		const serialized = JSON.parse(JSON.stringify(original)) as unknown
		const restored = normalizeTimeTracking(serialized)
		expect(restored).toEqual(original)
		expect(getElapsedMs(restored, T1)).toBe(15000)
	})

	test('empty state survives serialize -> normalize', () => {
		const original = emptyTimeTracking()
		const restored = normalizeTimeTracking(JSON.parse(JSON.stringify(original)) as unknown)
		expect(restored).toEqual(original)
		expect(getElapsedMs(restored, T1)).toBe(0)
	})
})

describe('purity', () => {
	test('startTimeClock does not mutate input and returns a new object', () => {
		const input: TimeTracking = { started_at: T0, accumulated_ms: 5 }
		const snapshot = { ...input }
		const result = startTimeClock(input, T1) // no-op (already running)
		expect(input).toEqual(snapshot)
		expect(result).not.toBe(input)
	})

	test('pauseTimeClock does not mutate input', () => {
		const input: TimeTracking = { started_at: T0, accumulated_ms: 0 }
		const snapshot = { ...input }
		const result = pauseTimeClock(input, T1)
		expect(input).toEqual(snapshot)
		expect(input.started_at).toBe(T0)
		expect(result).not.toBe(input)
	})

	test('resumeTimeClock does not mutate input', () => {
		const input: TimeTracking = { paused_at: T1, accumulated_ms: 10000 }
		const snapshot = { ...input }
		const result = resumeTimeClock(input, T2)
		expect(input).toEqual(snapshot)
		expect(input.paused_at).toBe(T1)
		expect(result).not.toBe(input)
	})

	test('functions do not mutate a frozen input object', () => {
		const frozen = Object.freeze({ started_at: T0, accumulated_ms: 0 })
		const paused = pauseTimeClock(frozen, T1)
		expect(paused).toEqual({ accumulated_ms: 10000, paused_at: T1 })
		expect(frozen).toEqual({ started_at: T0, accumulated_ms: 0 })

		const frozenPaused = Object.freeze({ paused_at: T1, accumulated_ms: 10000 })
		const resumed = resumeTimeClock(frozenPaused, T2)
		expect(resumed).toEqual({ started_at: T2, accumulated_ms: 10000 })
		expect(frozenPaused).toEqual({ paused_at: T1, accumulated_ms: 10000 })
	})
})

describe('normalizeTimeTracking', () => {
	test('returns an empty state for undefined', () => {
		expect(normalizeTimeTracking(undefined)).toEqual({ accumulated_ms: 0 })
	})

	test('returns an empty state for null', () => {
		expect(normalizeTimeTracking(null)).toEqual({ accumulated_ms: 0 })
	})

	test('normalizes a running state', () => {
		expect(normalizeTimeTracking({ started_at: T0, accumulated_ms: 100 })).toEqual({
			started_at: T0,
			accumulated_ms: 100,
		})
	})

	test('normalizes a paused state', () => {
		expect(normalizeTimeTracking({ paused_at: T1, accumulated_ms: 100 })).toEqual({
			paused_at: T1,
			accumulated_ms: 100,
		})
	})

	test('defaults accumulated_ms to 0 when missing', () => {
		expect(normalizeTimeTracking({})).toEqual({ accumulated_ms: 0 })
	})

	test('accepts zero accumulated_ms', () => {
		expect(normalizeTimeTracking({ accumulated_ms: 0 })).toEqual({ accumulated_ms: 0 })
	})

	test('accepts fractional accumulated_ms', () => {
		expect(normalizeTimeTracking({ accumulated_ms: 1.5 })).toEqual({ accumulated_ms: 1.5 })
	})

	test('returns a new object, not the input reference', () => {
		const input = { started_at: T0, accumulated_ms: 0 }
		expect(normalizeTimeTracking(input)).not.toBe(input)
	})

	test('rejects negative accumulated_ms', () => {
		expect(() => normalizeTimeTracking({ accumulated_ms: -1 })).toThrow(
			'time_tracking.accumulated_ms must be a non-negative finite number',
		)
	})

	test('rejects NaN accumulated_ms', () => {
		expect(() => normalizeTimeTracking({ accumulated_ms: Number.NaN })).toThrow(
			'time_tracking.accumulated_ms must be a non-negative finite number',
		)
	})

	test('rejects Infinity accumulated_ms', () => {
		expect(() => normalizeTimeTracking({ accumulated_ms: Number.POSITIVE_INFINITY })).toThrow(
			'time_tracking.accumulated_ms must be a non-negative finite number',
		)
	})

	test('rejects non-number accumulated_ms', () => {
		expect(() => normalizeTimeTracking({ accumulated_ms: '100' })).toThrow(
			'time_tracking.accumulated_ms must be a non-negative finite number',
		)
	})

	test('rejects non-string started_at', () => {
		expect(() => normalizeTimeTracking({ started_at: 123, accumulated_ms: 0 })).toThrow(
			'time_tracking.started_at must be a string',
		)
	})

	test('rejects non-string paused_at', () => {
		expect(() => normalizeTimeTracking({ paused_at: 123, accumulated_ms: 0 })).toThrow(
			'time_tracking.paused_at must be a string',
		)
	})

	test('rejects unknown keys', () => {
		expect(() => normalizeTimeTracking({ accumulated_ms: 0, extra: 'x' })).toThrow(
			'time_tracking contains unsupported key: extra',
		)
	})

	test('rejects non-object input', () => {
		expect(() => normalizeTimeTracking('nope')).toThrow('time_tracking must be an object')
	})

	test('rejects array input', () => {
		expect(() => normalizeTimeTracking([T0, 0])).toThrow('time_tracking must be an object')
	})
})
