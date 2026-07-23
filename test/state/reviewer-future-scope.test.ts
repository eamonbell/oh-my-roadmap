import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ScoutFinding, TaskPlan, WavePlan } from '@oh-my-roadmap/core/types'
import { milestonePlanPath, milestoneRuntimePath } from '@oh-my-roadmap/core/paths'
import { readYamlFile, writeMarkdownData, writeYamlFile } from '@oh-my-roadmap/core/files'
import { loadMilestonePlan, resolveBlocker, transition } from '@oh-my-roadmap/core/store/index'
import * as contextSeeding from '@oh-my-roadmap/core/wave-orchestration/context-seeding'
import {
	prepareWaveReview,
	recordReviewerDispatch,
	recordWaveReview,
} from '@oh-my-roadmap/core/wave-orchestration/index'
import { remainingWaveContexts } from '@oh-my-roadmap/core/wave-orchestration/review'
import {
	sliceReviewerSeededContext,
	type LoadedWaveContextSources,
} from '@oh-my-roadmap/core/wave-orchestration/context-seeding'
import type {
	ResolvedSharedInterfaceContract,
	SeededContext,
	SeededContextWarning,
} from '@oh-my-roadmap/core/wave-orchestration/types'
import {
	approvedRoadmap,
	createTempRoadmapCwd,
	milestoneInput,
	recordPassedWaveFlowCheck,
	removeTempRoadmapCwd,
} from './helpers'

let cwd = ''

beforeEach(async () => {
	cwd = await createTempRoadmapCwd()
})

afterEach(async () => {
	await removeTempRoadmapCwd(cwd)
	cwd = ''
})

function task(id: string, ownedModule: string): TaskPlan {
	return {
		id,
		title: id,
		objective: 'Review seeded context.',
		implementation_notes: [],
		done_criteria: [],
		verification_commands: [],
		worker: 'worker',
		status: 'assigned',
		depends_on: [],
		owned_files: [],
		owned_modules: [ownedModule],
		shared_interfaces: [],
		relevant_existing_code: [],
		shared_interface_contracts: [],
	}
}

function references(start: number, count: number) {
	return Array.from({ length: count }, (_, offset) => ({
		path: 'src/shared.ts',
		note: `reference-${start + offset}`,
		captured_at: '2026-07-23T00:00:00.000Z',
		source_mtime_ms: 1,
	}))
}

function interfaces(start: number, count: number): ResolvedSharedInterfaceContract[] {
	return Array.from({ length: count }, (_, offset) => ({
		name: `Interface${start + offset}`,
		signature: `export interface Interface${start + offset} {}`,
		source_path: 'src/shared.ts',
		planned: false,
		captured_at: '2026-07-23T00:00:00.000Z',
		source_mtime_ms: 1,
		current_source_mtime_ms: 1,
	}))
}

function warning(taskId: string, index: number): SeededContextWarning {
	return {
		kind: 'missing_source',
		message: `Missing ${taskId}-${index}`,
		path: `src/${taskId}-missing-${index}.ts`,
		task_id: taskId,
		item: `relevant_existing_code[${index}]`,
	}
}

function scout(id: string, sourcePaths: string[], minute: number): ScoutFinding {
	return {
		id,
		roadmap_id: 'roadmap-1',
		subsystem: 'core',
		milestone_ids: ['milestone-1'],
		source_paths: sourcePaths,
		summary: id,
		findings: [],
		created_by: 'scout',
		created_at: `2026-07-23T00:${String(minute).padStart(2, '0')}:00.000Z`,
	}
}

function seededContextFromPrompt(prompt: string): SeededContext {
	const prefix = 'Seeded reviewer context (this compact JSON exactly matches result.seeded_context):\n'
	const suffix = '\nThese seeded items were verified when this review package was assembled'
	const start = prompt.indexOf(prefix)
	const end = prompt.indexOf(suffix, start + prefix.length)
	expect(start).toBeGreaterThanOrEqual(0)
	expect(end).toBeGreaterThan(start)
	return JSON.parse(prompt.slice(start + prefix.length, end)) as SeededContext
}

async function setupFutureReview(activeWaveId = 'w-code', unknownFutureTask = false): Promise<void> {
	await approvedRoadmap(cwd)
	await transition(cwd, { operation: 'start_milestone_planning' })
	const input = milestoneInput()
	const [stateBase, reportBase] = input.tasks
	if (!stateBase || !reportBase) throw new Error('Expected milestone task fixtures')
	input.acceptanceCriteria = [
		'Code behavior remains correct.',
		'Document docs/reviewer.md before milestone closeout.',
	]
	input.tasks = [
		{
			...stateBase,
			id: 't-completed',
			title: 'Completed foundation',
			done_criteria: ['Foundation was completed in the earlier wave.'],
			owned_files: ['src/foundation.ts'],
			shared_interfaces: ['FoundationApi'],
		},
		{
			...reportBase,
			id: 't-code',
			title: 'Active code change',
			depends_on: ['t-completed'],
			done_criteria: ['Active code behavior passes its focused check.'],
			owned_files: ['src/active.ts'],
			shared_interfaces: ['ActiveApi'],
		},
		{
			...stateBase,
			id: 't-doc-one',
			title: 'Reviewer documentation',
			depends_on: ['t-code'],
			done_criteria: ['docs/reviewer.md explains reviewer context.'],
			owned_files: ['docs/reviewer.md'],
			owned_modules: ['docs'],
			shared_interfaces: ['ReviewerDocs'],
		},
		{
			...stateBase,
			id: 't-doc-two',
			title: 'Tutorial documentation',
			depends_on: ['t-doc-one'],
			done_criteria: ['docs/tutorial.md includes the final example.'],
			owned_files: ['docs/tutorial.md'],
			owned_modules: ['docs/tutorials'],
			shared_interfaces: ['TutorialDocs'],
		},
	]
	input.waves = [
		{
			id: 'w-completed',
			goal: 'Land the foundation.',
			exit_criteria: ['Foundation is complete.'],
			review_checkpoint: 'Review foundation.',
			status: 'pending',
			tasks: ['t-completed'],
		},
		{
			id: 'w-code',
			goal: 'Land active code behavior.',
			exit_criteria: ['Active code is complete.'],
			review_checkpoint: 'Review active code only.',
			status: 'pending',
			tasks: ['t-code'],
		},
		{
			id: 'w-doc-one',
			goal: 'Document reviewer context.',
			exit_criteria: ['Reviewer documentation is complete.'],
			review_checkpoint: 'Review reviewer docs.',
			status: 'pending',
			tasks: ['t-doc-one'],
		},
		{
			id: 'w-doc-two',
			goal: 'Document the tutorial.',
			exit_criteria: ['Tutorial documentation is complete.'],
			review_checkpoint: 'Review tutorial docs.',
			status: 'pending',
			tasks: ['t-doc-two'],
		},
	]
	await transition(cwd, { operation: 'create_milestone_plan', milestone: input })
	await recordPassedWaveFlowCheck(cwd)
	await transition(cwd, { operation: 'approve_milestone', approver: 'user' })
	await transition(cwd, { operation: 'start_implementation' })

	const runtimePath = milestoneRuntimePath(cwd, 'complex-refactor', 'm01-core')
	const runtime = await readYamlFile<Record<string, any>>(runtimePath)
	const activeIndex = input.waves.findIndex((wave) => wave.id === activeWaveId)
	if (activeIndex < 0) throw new Error(`Unknown fixture wave ${activeWaveId}`)
	for (const wave of runtime.waves) {
		const waveIndex = input.waves.findIndex((candidate) => candidate.id === wave.id)
		wave.status = waveIndex < activeIndex ? 'complete' : waveIndex === activeIndex ? 'running' : 'pending'
	}
	for (const task of runtime.tasks) {
		const waveIndex = input.waves.findIndex((wave) => wave.tasks.includes(task.id))
		task.status = waveIndex <= activeIndex ? 'done' : 'assigned'
	}
	runtime.progress.active_wave_id = activeWaveId
	runtime.progress.active_task_ids = []
	runtime.progress.step = 'workers_running'
	await writeYamlFile(runtimePath, runtime)
	if (unknownFutureTask) {
		const plan = await loadMilestonePlan(cwd, 'complex-refactor', 'm01-core')
		const futureWave = plan.waves.find((wave) => wave.id === 'w-doc-one')
		if (!futureWave) throw new Error('Expected future fixture wave')
		futureWave.tasks = ['t-missing-doc']
		await writeMarkdownData(
			milestonePlanPath(cwd, 'complex-refactor', 'm01-core'),
			plan as unknown as Record<string, unknown>,
			'# Future reviewer scope fixture\n',
		)
	}
}

describe('future reviewer seeded-context scope', () => {
	test('pure reviewer slicing repeats stable active-task-order merge, dedupe, exact caps, and warning reservation', () => {
		const firstTask = task('first', 'src/first')
		const secondTask = task('second', 'src/second')
		const firstScouts = Array.from({ length: 15 }, (_, index) => scout(`first-${index}`, ['src/first'], 45 - index))
		const secondScouts = Array.from({ length: 15 }, (_, index) => scout(`second-${index}`, ['src/second'], 30 - index))
		const sources: LoadedWaveContextSources = {
			taskContextById: new Map([
				[firstTask.id, {
					relevantExistingCode: references(0, 15),
					sharedInterfaceContracts: interfaces(0, 15),
					warnings: Array.from({ length: 10 }, (_, index) => warning(firstTask.id, index)),
				}],
				[secondTask.id, {
					relevantExistingCode: [...references(0, 5), ...references(15, 10)],
					sharedInterfaceContracts: [...interfaces(0, 5), ...interfaces(15, 10)],
					warnings: Array.from({ length: 10 }, (_, index) => warning(secondTask.id, index)),
				}],
			]),
			scoutFindings: [scout('repo-wide', [], 59), ...firstScouts, ...secondScouts],
			styleGuidance: { text: 'No recorded code-style guidance for these files.', bytes: 48, truncated: false },
			styleEntries: [],
			commonWarnings: [],
		}

		const first = sliceReviewerSeededContext(sources, [firstTask, secondTask])
		const repeated = sliceReviewerSeededContext(sources, [firstTask, secondTask])
		expect(repeated).toEqual(first)
		expect(first.relevant_existing_code).toMatchObject({ total: 25, included: 20, truncated: 5 })
		expect(first.relevant_existing_code.items.map((reference) => reference.note)).toEqual(
			Array.from({ length: 20 }, (_, index) => `reference-${index}`),
		)
		expect(first.shared_interface_contracts).toMatchObject({ total: 25, included: 20, truncated: 5 })
		expect(first.shared_interface_contracts.items.map((contract) => contract.name)).toEqual(
			Array.from({ length: 20 }, (_, index) => `Interface${index}`),
		)
		expect(first.scout_findings).toMatchObject({ total: 31, included: 20, truncated: 11 })
		expect(first.scout_findings.items.map((item) => item.id)).toEqual([
			'repo-wide',
			...Array.from({ length: 15 }, (_, index) => `first-${index}`),
			...Array.from({ length: 4 }, (_, index) => `second-${index}`),
		])
		expect(first.warnings).toMatchObject({ total: 21, included: 20, truncated: 1 })
		expect(first.warnings.items.slice(0, 10).map((item) => item.task_id)).toEqual(Array.from({ length: 10 }, () => 'first'))
		expect(first.warnings.items.slice(10, 19).map((item) => item.task_id)).toEqual(Array.from({ length: 9 }, () => 'second'))
		expect(first.warnings.items[19]).toEqual({
			kind: 'truncated',
			message: 'Context truncated fields: relevant_existing_code, shared_interface_contracts, scout_findings; omitted ordinary warnings: 1.',
		})
		expect(first.warnings.items.filter((item) => item.kind === 'truncated')).toHaveLength(1)
	})

	test('excludes a completed post-active wave while preserving later incomplete plan order', () => {
		const activeTask = task('t-active', 'src/active')
		const firstFutureTask = task('t-future-one', 'docs/first')
		const completedFutureTask = task('t-future-complete', 'docs/complete')
		const secondFutureTask = task('t-future-two', 'docs/second')
		const waves: WavePlan[] = [
			{
				id: 'w-active',
				goal: 'Review active code.',
				exit_criteria: ['Active code is complete.'],
				review_checkpoint: 'Review active code.',
				status: 'reviewing',
				tasks: [activeTask.id],
			},
			{
				id: 'w-future-one',
				goal: 'Write the first document.',
				exit_criteria: ['First document is complete.'],
				review_checkpoint: 'Review first document.',
				status: 'pending',
				tasks: [firstFutureTask.id],
			},
			{
				id: 'w-future-complete',
				goal: 'Represent already completed future-position work.',
				exit_criteria: ['Completed future-position work stays excluded.'],
				review_checkpoint: 'Already reviewed.',
				status: 'complete',
				tasks: [completedFutureTask.id],
			},
			{
				id: 'w-future-two',
				goal: 'Write the second document.',
				exit_criteria: ['Second document is complete.'],
				review_checkpoint: 'Review second document.',
				status: 'pending',
				tasks: [secondFutureTask.id],
			},
		]

		const remaining = remainingWaveContexts(
			{ tasks: [activeTask, firstFutureTask, completedFutureTask, secondFutureTask], waves },
			'w-active',
		)
		expect(remaining.map((wave) => wave.wave_id)).toEqual(['w-future-one', 'w-future-two'])
		expect(remaining.flatMap((wave) => wave.tasks.map((item) => item.task_id))).toEqual([
			't-future-one',
			't-future-two',
		])
		expect(remaining.flatMap((wave) => wave.tasks.map((item) => item.task_id))).not.toContain(completedFutureTask.id)
	})

	test('delivers active criteria, seeded context, and ordered informational future scope with fresh/re-review parity', async () => {
		await setupFutureReview()
		const loadSpy = spyOn(contextSeeding, 'loadWaveContextSources')
		try {
			const first = await prepareWaveReview(cwd)
			expect(loadSpy).toHaveBeenCalledTimes(1)
			expect(first.tasks).toEqual([{
				task_id: 't-code',
				title: 'Active code change',
				worker: 'worker-heavy',
				owned_files: ['src/active.ts'],
				owned_modules: [],
				shared_interfaces: ['ActiveApi'],
				done_criteria: ['Active code behavior passes its focused check.'],
			}])
			expect(first.remaining_waves).toEqual([
				{
					wave_id: 'w-doc-one',
					goal: 'Document reviewer context.',
					exit_criteria: ['Reviewer documentation is complete.'],
					tasks: [{
						task_id: 't-doc-one',
						title: 'Reviewer documentation',
						owned_files: ['docs/reviewer.md'],
						owned_modules: ['docs'],
						shared_interfaces: ['ReviewerDocs'],
						done_criteria: ['docs/reviewer.md explains reviewer context.'],
					}],
				},
				{
					wave_id: 'w-doc-two',
					goal: 'Document the tutorial.',
					exit_criteria: ['Tutorial documentation is complete.'],
					tasks: [{
						task_id: 't-doc-two',
						title: 'Tutorial documentation',
						owned_files: ['docs/tutorial.md'],
						owned_modules: ['docs/tutorials'],
						shared_interfaces: ['TutorialDocs'],
						done_criteria: ['docs/tutorial.md includes the final example.'],
					}],
				},
			])
			expect(first.remaining_waves.map((wave) => wave.wave_id)).not.toContain('w-completed')
			expect(first.remaining_waves.map((wave) => wave.wave_id)).not.toContain('w-code')
			expect(seededContextFromPrompt(first.prompt)).toEqual(first.seeded_context)
			expect(first.prompt).toContain('Active code behavior passes its focused check.')
			expect(first.prompt).toContain('Milestone acceptance context (non-gating for this wave; final disposition is closeout)')
			expect(first.prompt).toContain('Document docs/reviewer.md before milestone closeout.')
			expect(first.prompt).toContain('Judge this wave only against the active wave exit criteria and active task done criteria')
			expect(first.prompt).toContain('Do not fail this wave solely because an item is owned by remaining_waves')
			expect(first.prompt).not.toContain('omr_style_guide')

			await recordReviewerDispatch(cwd, { agentId: 'reviewer-one', jobId: 'review-job-one' })
			const failed = await recordWaveReview(cwd, {
				status: 'failed',
				summary: 'Active code requires rework.',
				findings: ['Active code focused check failed.'],
			})
			for (const blocker of failed.blockers) {
				await resolveBlocker(cwd, { blockerId: blocker.id, resolution: 'Active code was corrected.' })
			}
			await transition(cwd, { operation: 'update_wave_status', waveId: 'w-code', waveStatus: 'reviewing' })

			const repeated = await prepareWaveReview(cwd)
			expect(loadSpy).toHaveBeenCalledTimes(2)
			expect(repeated.re_review).toBe(true)
			expect(repeated.prior_reviewer_agent_id).toBe('reviewer-one')
			expect(repeated.seeded_context).toEqual(first.seeded_context)
			expect(repeated.remaining_waves).toEqual(first.remaining_waves)
			expect(repeated.tasks).toEqual(first.tasks)
			expect(seededContextFromPrompt(repeated.prompt)).toEqual(repeated.seeded_context)
		} finally {
			loadSpy.mockRestore()
		}
	})

	test('names unknown remaining-wave task references', async () => {
		await setupFutureReview('w-code', true)
		await expect(prepareWaveReview(cwd)).rejects.toThrow('Wave w-doc-one references unknown task t-missing-doc')
	})

	test('returns no remaining waves for the final plan wave', async () => {
		await setupFutureReview('w-doc-two')
		const review = await prepareWaveReview(cwd)
		expect(review.remaining_waves).toEqual([])
	})

	test('reviewer template consumes assembled context and contains no style-tool instruction', async () => {
		const template = await fs.readFile(
			path.join(process.cwd(), 'packages/core/agent-templates/reviewer/AGENT.md'),
			'utf8',
		)
		expect(template).toContain('remaining_waves')
		expect(template).toContain('seeded_context')
		expect(template).toContain('relevant-code references')
		expect(template).toContain('shared-interface contracts')
		expect(template).toMatch(/scout\s+findings/)
		expect(template).toContain('repository primer')
		expect(template).toContain('seeded_context.style_guidance')
		expect(template).not.toContain('omr_style_guide')
	})
})
