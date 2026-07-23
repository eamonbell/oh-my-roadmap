import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import {loadState, transition} from '@oh-my-roadmap/core/store/index'
import {recordVerificationBaseline, recordWaveReview, prepareWaveDispatch, prepareWaveReview, recordWaveResult} from '@oh-my-roadmap/core/wave-orchestration/index'
import {milestoneRuntimePath} from '@oh-my-roadmap/core/paths'
import {readYamlFile, writeYamlFile} from '@oh-my-roadmap/core/files'
import {approvedMilestone, createTempRoadmapCwd, removeTempRoadmapCwd} from './helpers'

let cwd = ''

beforeEach(async () => {
	cwd = await createTempRoadmapCwd()
})

afterEach(async () => {
	await removeTempRoadmapCwd(cwd)
	cwd = ''
})

// Read the persisted runtime directly, bypassing normalizeProgress on load. This verifies that
// fields are actually persisted to the YAML regardless of how the load-time normalizer handles them.
async function readRuntimeProgress(): Promise<Record<string, any>> {
	const runtime = await readYamlFile<Record<string, any>>(
		milestoneRuntimePath(cwd, 'complex-refactor', 'm01-core'),
	)
	return runtime.progress as Record<string, any>
}

describe('progress persistence across ordinary transitions', () => {
	test('verification_baseline survives update_implementation_progress when not updating baseline', async () => {
		// Set up: reach implementing phase and record a baseline
		await approvedMilestone(cwd)
		await transition(cwd, {operation: 'start_implementation'})

		const baseline = await recordVerificationBaseline(cwd, {
			commandResults: [
				{command: 'bun test', failing_tests: [], failure_count: 0},
			],
		})

		// Verify baseline was recorded
		let state = await loadState(cwd)
		expect(state.milestone?.progress.verification_baseline).toEqual(baseline)

		// Perform an ordinary progress update (change step and active_task_ids) that does NOT
		// record or modify the baseline
		await transition(cwd, {
			operation: 'update_implementation_progress',
			progress: {
				step: 'workers_running',
				activeTaskIds: ['t01-state'],
			},
		})

		// Reload and verify baseline STILL persists
		state = await loadState(cwd)
		expect(state.milestone?.progress.verification_baseline).toEqual(baseline)
		expect(state.milestone?.progress.step).toBe('workers_running')
		expect(state.milestone?.progress.active_task_ids).toEqual(['t01-state'])

		// Also check the raw YAML to ensure it's actually persisted (not just loaded via normalizer)
		const rawProgress = await readRuntimeProgress()
		expect(rawProgress.verification_baseline).toBeDefined()
		expect(rawProgress.verification_baseline.captured_at).toBe(baseline.captured_at)
	})

	test('rework_queue survives update_implementation_progress when queue is not being cleared', async () => {
		// Set up: reach review-ready state with rework queue
		await approvedMilestone(cwd)
		await transition(cwd, {operation: 'start_implementation'})
		await prepareWaveDispatch(cwd)
		await recordWaveResult(cwd, {
			taskId: 't01-state',
			status: 'completed',
			summary: 'State task completed.',
		})
		await prepareWaveReview(cwd)

		// Create review findings that queue rework items
		await recordWaveReview(cwd, {
			status: 'failed',
			summary: 'Reviewer found issues.',
			structured_findings: [
				{severity: 'blocking_worker_fixable', text: 'Fix the lock error path.', task_id: 't01-state'},
				{severity: 'blocking_worker_fixable', text: 'Add missing guard.', task_id: 't01-state'},
			],
		})

		// Verify rework queue was created
		let rawProgress = await readRuntimeProgress()
		expect(rawProgress.rework_queue).toHaveLength(2)
		const queueItemIds = rawProgress.rework_queue.map((item: any) => item.id)

		// Perform an ordinary progress update that does NOT touch the queue
		await transition(cwd, {
			operation: 'update_implementation_progress',
			progress: {
				step: 'resolving_blockers',
				activeTaskIds: [],
			},
		})

		// Verify rework queue STILL persists with the same items
		rawProgress = await readRuntimeProgress()
		expect(rawProgress.rework_queue).toHaveLength(2)
		expect(rawProgress.rework_queue.map((item: any) => item.id)).toEqual(queueItemIds)
		expect(rawProgress.rework_queue.map((item: any) => item.finding_text)).toEqual([
			'Fix the lock error path.',
			'Add missing guard.',
		])

		// Also verify via loadState
		const state = await loadState(cwd)
		expect(state.milestone?.progress.rework_queue).toHaveLength(2)
		expect(state.milestone?.progress.step).toBe('resolving_blockers')
	})

	test('both verification_baseline and rework_queue persist together in a single transition', async () => {
		// Set up: reach review-ready state with both baseline and queue
		await approvedMilestone(cwd)
		await transition(cwd, {operation: 'start_implementation'})

		// Record baseline
		const baseline = await recordVerificationBaseline(cwd, {
			commandResults: [
				{command: 'bun test', failing_tests: [], failure_count: 0},
			],
		})

		// Create rework queue via review
		await prepareWaveDispatch(cwd)
		await recordWaveResult(cwd, {
			taskId: 't01-state',
			status: 'completed',
			summary: 'State task completed.',
		})
		await prepareWaveReview(cwd)

		await recordWaveReview(cwd, {
			status: 'failed',
			summary: 'Found issues.',
			structured_findings: [
				{severity: 'blocking_worker_fixable', text: 'Issue A', task_id: 't01-state'},
			],
		})

		// Verify both exist
		let state = await loadState(cwd)
		expect(state.milestone?.progress.verification_baseline).toBeDefined()
		expect(state.milestone?.progress.rework_queue).toHaveLength(1)

		// Perform progress update
		await transition(cwd, {
			operation: 'update_implementation_progress',
			progress: {
				step: 'resolving_blockers',
				activeTaskIds: ['t01-state'],
			},
		})

		// Verify BOTH still persist
		state = await loadState(cwd)
		expect(state.milestone?.progress.verification_baseline).toEqual(baseline)
		expect(state.milestone?.progress.rework_queue).toHaveLength(1)
		expect(state.milestone?.progress.rework_queue?.[0]?.finding_text).toBe('Issue A')
		expect(state.milestone?.progress.step).toBe('resolving_blockers')

		// Check raw YAML
		const rawProgress = await readRuntimeProgress()
		expect(rawProgress.verification_baseline).toBeDefined()
		expect(rawProgress.rework_queue).toHaveLength(1)
	})
})
