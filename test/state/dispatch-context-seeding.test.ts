import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { setProjectStyle } from '@oh-my-roadmap/core/project-init'
import { recordScoutFinding, transition } from '@oh-my-roadmap/core/store/index'
import * as contextSeeding from '@oh-my-roadmap/core/wave-orchestration/context-seeding'
import {
	prepareWaveDispatch,
	prepareWorkerRedispatch,
	recordWorkerAbandoned,
	recordWorkerDispatch,
} from '@oh-my-roadmap/core/wave-orchestration/index'
import type { SeededContext } from '@oh-my-roadmap/core/wave-orchestration/types'
import {
	approvedRoadmap,
	createTempRoadmapCwd,
	milestoneInput,
	recordPassedWaveFlowCheck,
	removeTempRoadmapCwd,
	testWave,
} from './helpers'

let cwd = ''

beforeEach(async () => {
	cwd = await createTempRoadmapCwd()
})

afterEach(async () => {
	await removeTempRoadmapCwd(cwd)
	cwd = ''
})

function seededContextFromPrompt(prompt: string): SeededContext {
	const prefix = 'Seeded context (this compact JSON exactly matches assignment.seeded_context):\n'
	const suffix = '\nThe seeded items above were verified when this assignment was assembled'
	const start = prompt.indexOf(prefix)
	const end = prompt.indexOf(suffix, start + prefix.length)
	expect(start).toBeGreaterThanOrEqual(0)
	expect(end).toBeGreaterThan(start)
	return JSON.parse(prompt.slice(start + prefix.length, end)) as SeededContext
}

async function setupContextWave(): Promise<void> {
	await approvedRoadmap(cwd)
	await fs.mkdir(path.join(cwd, 'src'), { recursive: true })
	await fs.writeFile(path.join(cwd, 'src/live.ts'), 'export const liveApi = 1\n', 'utf8')
	await fs.writeFile(path.join(cwd, 'src/stale.ts'), 'export const staleApi = 1\n', 'utf8')
	await fs.writeFile(path.join(cwd, 'src/unrelated.ts'), 'export const unrelatedApi = 1\n', 'utf8')

	await transition(cwd, { operation: 'start_milestone_planning' })
	const input = milestoneInput()
	const liveReferences = Array.from({ length: 21 }, (_, index) => ({
		path: 'src/live.ts',
		note: `live-reference-${index}`,
	}))
	const contracts = Array.from({ length: 21 }, (_, index) => ({
		name: `LiveContract${index}`,
		signature: 'export const liveApi = 1',
		source_path: 'src/live.ts',
		planned: false as const,
	}))
	input.tasks = [
		{
			...input.tasks[0]!,
			id: 't-own',
			owned_files: ['src/live.ts', 'src/stale.ts'],
			shared_interfaces: ['LiveContract'],
			relevant_existing_code: [
				...liveReferences,
				{ path: 'src/stale.ts', note: 'becomes-stale' },
			],
			shared_interface_contracts: contracts,
		},
		{
			...input.tasks[1]!,
			id: 't-unrelated',
			depends_on: [],
			owned_files: ['src/unrelated.ts'],
			relevant_existing_code: [{ path: 'src/unrelated.ts', note: 'unrelated-reference' }],
			shared_interface_contracts: [{
				name: 'UnrelatedContract',
				signature: 'export const unrelatedApi = 1',
				source_path: 'src/unrelated.ts',
				planned: false,
			}],
		},
	]
	input.waves = [testWave('w-context', ['t-own', 't-unrelated'])]
	await transition(cwd, { operation: 'create_milestone_plan', milestone: input })
	await recordPassedWaveFlowCheck(cwd)
	await transition(cwd, { operation: 'approve_milestone', approver: 'user' })

	await setProjectStyle(cwd, 'typescript', { guidelines: ['Prefer explicit context contracts.'] })
	for (let index = 0; index < 11; index += 1) {
		await recordScoutFinding(cwd, {
			subsystem: 'repository',
			summary: `Repository finding ${index}`,
			sourcePaths: [],
		})
	}
	await recordScoutFinding(cwd, {
		subsystem: 'own',
		summary: 'Own task finding',
		sourcePaths: ['src/live.ts'],
	})
	await recordScoutFinding(cwd, {
		subsystem: 'unrelated',
		summary: 'Unrelated task finding',
		sourcePaths: ['src/unrelated.ts'],
	})

	await fs.writeFile(path.join(cwd, 'src/stale.ts'), 'export const staleApi = 2\n', 'utf8')
	const future = new Date(Date.now() + 5_000)
	await fs.utimes(path.join(cwd, 'src/stale.ts'), future, future)
	await transition(cwd, { operation: 'start_implementation' })
}

describe('worker dispatch seeded context', () => {
	test('filters task context, warns without gating, enforces caps, and preserves exact prompt/package parity', async () => {
		await setupContextWave()
		const loadSpy = spyOn(contextSeeding, 'loadWaveContextSources')
		try {
			const dispatch = await prepareWaveDispatch(cwd)
			expect(loadSpy).toHaveBeenCalledTimes(1)
			expect(dispatch.assignments).toHaveLength(2)

			const own = dispatch.assignments.find((assignment) => assignment.task_id === 't-own')!
			const unrelated = dispatch.assignments.find((assignment) => assignment.task_id === 't-unrelated')!
			expect(own.seeded_context.relevant_existing_code).toMatchObject({ total: 21, included: 20, truncated: 1 })
			expect(own.seeded_context.shared_interface_contracts).toMatchObject({ total: 21, included: 20, truncated: 1 })
			expect(own.seeded_context.scout_findings).toMatchObject({ total: 12, included: 10, truncated: 2 })
			expect(own.seeded_context.relevant_existing_code.items.every((item) => item.note.startsWith('live-reference-'))).toBe(true)
			expect(own.seeded_context.relevant_existing_code.items.some((item) => item.note === 'unrelated-reference')).toBe(false)
			expect(own.seeded_context.scout_findings.items.some((item) => item.summary === 'Unrelated task finding')).toBe(false)
			expect(unrelated.seeded_context.relevant_existing_code.items.map((item) => item.note)).toEqual(['unrelated-reference'])
			expect(unrelated.seeded_context.scout_findings.items.some((item) => item.summary === 'Own task finding')).toBe(false)

			const staleWarning = own.seeded_context.warnings.items.find((warning) => warning.kind === 'stale_source')
			expect(staleWarning).toMatchObject({ task_id: 't-own', item: 'relevant_existing_code[21]', path: 'src/stale.ts' })
			expect(own.prompt).toContain('live repository code remains authoritative')
			expect(own.prompt).toContain('Typed warnings name context items omitted')
			expect(own.prompt).not.toContain('omr_style_guide')
			expect(own.seeded_context.style_guidance.text).toContain('Prefer explicit context contracts.')
			expect(seededContextFromPrompt(own.prompt)).toEqual(own.seeded_context)
			expect(seededContextFromPrompt(unrelated.prompt)).toEqual(unrelated.seeded_context)
		} finally {
			loadSpy.mockRestore()
		}
	})

	test('uses one provider load per operation and identical enrichment for abandonment recovery and genuine rework', async () => {
		await setupContextWave()
		const loadSpy = spyOn(contextSeeding, 'loadWaveContextSources')
		try {
			const fresh = await prepareWaveDispatch(cwd)
			const freshOwn = fresh.assignments.find((assignment) => assignment.task_id === 't-own')!
			const freshUnrelated = fresh.assignments.find((assignment) => assignment.task_id === 't-unrelated')!
			await recordWorkerDispatch(cwd, { taskId: 't-own', agentId: 'own-agent', jobId: 'own-job' })
			await recordWorkerDispatch(cwd, { taskId: 't-unrelated', agentId: 'unrelated-agent', jobId: 'unrelated-job' })
			await recordWorkerAbandoned(cwd, { taskId: 't-own', jobId: 'own-job', lastError: 'transport lost' })
			await recordWorkerAbandoned(cwd, { taskId: 't-unrelated', jobId: 'unrelated-job', lastError: 'review requested rework' })

			const recovered = await prepareWorkerRedispatch(cwd, { taskId: 't-own' })
			const rework = await prepareWorkerRedispatch(cwd, { taskId: 't-unrelated', reworkOf: 'rq-context' })
			expect(loadSpy).toHaveBeenCalledTimes(3)
			expect(recovered.assignment.seeded_context).toEqual(freshOwn.seeded_context)
			expect(rework.assignment.seeded_context).toEqual(freshUnrelated.seeded_context)
			expect(seededContextFromPrompt(recovered.assignment.prompt)).toEqual(recovered.assignment.seeded_context)
			expect(seededContextFromPrompt(rework.assignment.prompt)).toEqual(rework.assignment.seeded_context)
			expect(recovered.assignment.prompt).toContain('CONTINUATION CONTEXT')
			expect(rework.assignment.prompt).toContain('CONTINUATION CONTEXT')
		} finally {
			loadSpy.mockRestore()
		}
	})
})
