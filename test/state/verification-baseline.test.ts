import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import {loadState, transition} from '@oh-my-roadmap/core/store/index'
import {recordVerificationBaseline} from '@oh-my-roadmap/core/wave-orchestration/index'
import {approvedMilestone, createTempRoadmapCwd, removeTempRoadmapCwd} from './helpers'

let cwd = ''

beforeEach(async () => {
	cwd = await createTempRoadmapCwd()
})

afterEach(async () => {
	await removeTempRoadmapCwd(cwd)
	cwd = ''
})

describe('verification baseline', () => {
	test('records a verification baseline with defaulted captured_by', async () => {
		await approvedMilestone(cwd)
		await transition(cwd, {operation: 'start_implementation'})

		const baseline = await recordVerificationBaseline(cwd, {
			commandResults: [
				{command: 'bun test', failing_tests: [], failure_count: 0},
			],
		})

		expect(baseline.captured_by).toBe('orchestrator')
		expect(baseline.command_results).toEqual([
			{command: 'bun test', failing_tests: [], failure_count: 0},
		])
		expect(baseline.captured_at).toEqual(expect.any(String))

		const state = await loadState(cwd)
		expect(state.milestone?.progress.verification_baseline).toEqual(baseline)
	})

	test('respects an explicit captured_by', async () => {
		await approvedMilestone(cwd)
		await transition(cwd, {operation: 'start_implementation'})

		const baseline = await recordVerificationBaseline(cwd, {
			commandResults: [
				{command: 'bun test', exit_status: 1, failing_tests: ['a.test.ts'], failure_count: 1},
			],
			capturedBy: 'agent-42',
		})

		expect(baseline.captured_by).toBe('agent-42')
	})

	test('re-recording replaces the prior baseline instead of appending', async () => {
		await approvedMilestone(cwd)
		await transition(cwd, {operation: 'start_implementation'})

		await recordVerificationBaseline(cwd, {
			commandResults: [
				{command: 'bun test', failing_tests: ['old.test.ts'], failure_count: 1},
			],
		})

		const replacement = await recordVerificationBaseline(cwd, {
			commandResults: [
				{command: 'bun test', failing_tests: [], failure_count: 0},
				{command: 'bun run check', failing_tests: [], failure_count: 0},
			],
		})

		expect(replacement.command_results).toHaveLength(2)
		expect(replacement.command_results.map((result) => result.command)).toEqual(['bun test', 'bun run check'])

		const state = await loadState(cwd)
		expect(state.milestone?.progress.verification_baseline?.command_results).toHaveLength(2)
	})

	test('throws when recorded before the implementing phase', async () => {
		await approvedMilestone(cwd)

		await expect(recordVerificationBaseline(cwd, {
			commandResults: [{command: 'bun test', failing_tests: [], failure_count: 0}],
		})).rejects.toThrow()
	})
})
