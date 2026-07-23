import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
	createChangeRequest,
	loadChangeRequest,
	loadChangeRequestRuntime,
	loadMilestonePlan,
	loadMilestoneRuntime,
	writeChangeRequestRuntime,
	writeMilestoneRuntime,
} from '@oh-my-roadmap/core/store/index'
import { planDefinitionData } from '@oh-my-roadmap/core/store/format'
import type { WaveGitState } from '@oh-my-roadmap/core/types'
import { closeoutPhase, createTempRoadmapCwd, removeTempRoadmapCwd, testWave } from './helpers'

let cwd = ''

beforeEach(async () => {
	cwd = await createTempRoadmapCwd()
})

afterEach(async () => {
	await removeTempRoadmapCwd(cwd)
	cwd = ''
})

const sampleGit: WaveGitState = {
	start: {
		start_head: 'abc123',
		predirty: ['src/core/store.ts'],
		captured_at: '2026-07-23T00:00:00.000Z',
	},
	checkpoint: {
		status: 'created',
		commit: 'def456',
		paths: ['src/core/store.ts'],
		warnings: ['Checkpoint includes pre-existing uncommitted changes in: src/core/store.ts'],
		at: '2026-07-23T00:01:00.000Z',
	},
}

// Attach runtime-only git state to a wave without widening the WavePlan type (git is a runtime
// projection carried only on WaveRuntime).
function withWaveGit<T extends { waves: unknown[] }>(plan: T, waveId: string, git: WaveGitState): T {
	return {
		...plan,
		waves: (plan.waves as Array<{ id: string }>).map((wave) =>
			wave.id === waveId ? { ...wave, git } : wave,
		),
	}
}

describe('WaveGitState runtime round trip (roadmap milestone)', () => {
	test('git start + checkpoint survive a runtime write -> read and never leak into plan.md data', async () => {
		await closeoutPhase(cwd)
		const plan = await loadMilestonePlan(cwd, 'complex-refactor', 'm01-core')
		const withGit = withWaveGit(plan, 'w01', sampleGit)

		await writeMilestoneRuntime(cwd, withGit)

		const runtime = await loadMilestoneRuntime(cwd, 'complex-refactor', 'm01-core')
		const w01 = runtime.waves.find((w) => w.id === 'w01')
		const w02 = runtime.waves.find((w) => w.id === 'w02')
		expect(w01?.git).toEqual(sampleGit)
		// waves without git stay clean (no empty git object leaking in)
		expect(w02?.git).toBeUndefined()

		// applyRuntime overlays git back onto the loaded plan waves.
		const reloaded = await loadMilestonePlan(cwd, 'complex-refactor', 'm01-core')
		const reloadedWave = reloaded.waves.find((w) => w.id === 'w01') as { git?: WaveGitState }
		expect(reloadedWave.git).toEqual(sampleGit)

		// planDefinitionData strips runtime-only git so it never reaches plan.md.
		const definition = planDefinitionData(withGit)
		for (const wave of definition.waves as Array<Record<string, unknown>>) {
			expect('git' in wave).toBe(false)
		}
	})

	async function seedChangeRequest(): Promise<void> {
		await closeoutPhase(cwd)
		await createChangeRequest(cwd, {
			changeRequestId: 'c01-adjust',
			title: 'Adjust behavior',
			request: 'Change the implementation after review.',
			verificationCommands: ['bun test'],
			acceptanceCriteria: ['Requested delta is implemented'],
			tasks: [
				{
					id: 't01-change',
					title: 'Change task',
					objective: 'Adjust behavior.',
					implementation_notes: ['Adjust the implementation.'],
					done_criteria: ['Delta implemented.'],
					verification_commands: ['bun test'],
					worker: 'worker',
					status: 'assigned',
					depends_on: [],
					owned_files: ['src/core/store.ts'],
					owned_modules: [],
					shared_interfaces: [],
					relevant_existing_code: [],
					shared_interface_contracts: [],
				},
			],
			waves: [testWave('w01', ['t01-change'])],
		})
	}

	test('change request runtime preserves git and strips it from plan definition', async () => {
		await seedChangeRequest()
		const change = await loadChangeRequest(cwd, 'complex-refactor', 'm01-core', 'c01-adjust')
		const withGit = withWaveGit(change, 'w01', sampleGit)

		await writeChangeRequestRuntime(cwd, withGit)

		const runtime = await loadChangeRequestRuntime(cwd, 'complex-refactor', 'm01-core', 'c01-adjust')
		expect(runtime.waves.find((w) => w.id === 'w01')?.git).toEqual(sampleGit)

		const definition = planDefinitionData(withGit)
		for (const wave of definition.waves as Array<Record<string, unknown>>) {
			expect('git' in wave).toBe(false)
		}
	})
})
