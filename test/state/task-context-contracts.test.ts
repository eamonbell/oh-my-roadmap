import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import { writeMarkdownData } from '@oh-my-roadmap/core/files'
import { adhocPlanPath, changeRequestPath, milestonePlanPath } from '@oh-my-roadmap/core/paths'
import {
	createAdhocPlan,
	createChangeRequest,
	loadAdhocPlan,
	loadChangeRequest,
	loadMilestonePlan,
	transition,
	updateAdhocPlan,
} from '@oh-my-roadmap/core/store/index'
import { captureTaskContext } from '@oh-my-roadmap/core/task-context'
import type { TaskPlanInput, WavePlan } from '@oh-my-roadmap/core/types'
import { adhocCommandPrompt, commandPrompt } from '../../packages/extension/src/extension/commands/prompts'
import { createToolRegistrationSchemas } from '../../packages/extension/src/tools/register/shared'
import {
	approvedRoadmap,
	closeoutPhase,
	createTempRoadmapCwd,
	milestoneInput,
	removeTempRoadmapCwd,
} from './helpers'

const LEGACY_ERROR = 'Task t-context uses the pre-Wave-3 context schema; re-plan with the current task context schema.'

let cwd = ''

beforeEach(async () => {
	cwd = await createTempRoadmapCwd()
})

afterEach(async () => {
	await removeTempRoadmapCwd(cwd)
	cwd = ''
})

function task(id: string, overrides: Partial<TaskPlanInput> = {}): TaskPlanInput {
	return {
		id,
		title: `Task ${id}`,
		objective: `Implement ${id}`,
		implementation_notes: ['Keep the change bounded.'],
		done_criteria: [`${id} is complete.`],
		verification_commands: ['bun test test/state/task-context-contracts.test.ts'],
		worker: 'worker',
		status: 'assigned',
		depends_on: [],
		owned_files: [`src/${id}.ts`],
		owned_modules: [],
		shared_interfaces: [],
		relevant_existing_code: [],
		shared_interface_contracts: [],
		...overrides,
	}
}

function wave(id: string, taskIds: string[]): WavePlan {
	return {
		id,
		goal: `Complete ${id}`,
		exit_criteria: [`${id} is complete.`],
		review_checkpoint: `Review ${id}`,
		status: 'pending',
		tasks: taskIds,
	}
}

async function writeSource(root: string, sourcePath = 'src/context.ts'): Promise<void> {
	await fs.mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true })
	await fs.writeFile(
		path.join(root, sourcePath),
		'export interface ExistingContext {\n  value: string\n}\n',
		'utf8',
	)
}

function contextTask(id = 't-context'): TaskPlanInput {
	return task(id, {
		owned_files: ['src/context.ts'],
		shared_interfaces: ['ExistingContext'],
		relevant_existing_code: [{
			path: 'src/context.ts',
			line: 2,
			symbol: 'ExistingContext',
			note: 'The existing interface is the integration boundary.',
		}],
		shared_interface_contracts: [{
			name: 'ExistingContext',
			signature: 'interface ExistingContext { value: string }',
			source_path: 'src/context.ts',
			line: 1,
			planned: false,
		}],
	})
}

function singleTaskInput(context: TaskPlanInput) {
	return {
		verificationCommands: ['bun test test/state/task-context-contracts.test.ts'],
		acceptanceCriteria: ['Structured task context persists.'],
		tasks: [context],
		waves: [wave('w-context', [context.id])],
	}
}

async function removeContextFields(plan: { tasks: unknown[] }): Promise<Record<string, unknown>> {
	const legacy = structuredClone(plan) as unknown as Record<string, unknown>
	const tasks = legacy.tasks as Array<Record<string, unknown>>
	delete tasks[0]!.relevant_existing_code
	delete tasks[0]!.shared_interface_contracts
	return legacy
}

describe('structured task context persistence', () => {
	test('captures and persists milestone task references and contracts', async () => {
		await writeSource(cwd)
		await approvedRoadmap(cwd)
		await transition(cwd, { operation: 'start_milestone_planning' })
		const input = milestoneInput()
		input.tasks = [contextTask()]
		input.waves = [wave('w-context', ['t-context'])]
		await transition(cwd, { operation: 'create_milestone_plan', milestone: input })

		const loaded = await loadMilestonePlan(cwd, 'complex-refactor', 'm01-core')
		expect(loaded.tasks[0]!.relevant_existing_code[0]).toMatchObject({
			path: 'src/context.ts',
			line: 2,
			symbol: 'ExistingContext',
			note: 'The existing interface is the integration boundary.',
		})
		expect(loaded.tasks[0]!.relevant_existing_code[0]!.captured_at).not.toBe('')
		expect(loaded.tasks[0]!.relevant_existing_code[0]!.source_mtime_ms).toBeGreaterThan(0)
		expect(loaded.tasks[0]!.shared_interface_contracts[0]).toMatchObject({
			name: 'ExistingContext',
			planned: false,
			source_path: 'src/context.ts',
		})
		const markdown = await fs.readFile(milestonePlanPath(cwd, 'complex-refactor', 'm01-core'), 'utf8')
		expect(markdown).toContain('Relevant Existing Code:')
		expect(markdown).toContain('Shared Interface Contracts:')
	})

	test('captures and persists change-request task context', async () => {
		await closeoutPhase(cwd)
		await writeSource(cwd)
		await createChangeRequest(cwd, {
			changeRequestId: 'c01-context',
			title: 'Context change',
			request: 'Exercise structured context.',
			...singleTaskInput(contextTask()),
		})

		const loaded = await loadChangeRequest(cwd, 'complex-refactor', 'm01-core', 'c01-context')
		expect(loaded.tasks[0]!.relevant_existing_code).toHaveLength(1)
		expect(loaded.tasks[0]!.shared_interface_contracts[0]!.captured_at).not.toBe('')
	})

	test('captures on ad-hoc creation and recaptures on draft update', async () => {
		await writeSource(cwd)
		const input = {
			adhocId: 'a01-context',
			title: 'Context ad-hoc',
			request: 'Exercise structured context.',
			...singleTaskInput(contextTask()),
		}
		const created = await createAdhocPlan(cwd, input)
		const firstCapture = created.tasks[0]!.relevant_existing_code[0]!.captured_at
		await fs.writeFile(path.join(cwd, 'src/context.ts'), 'export  interface ExistingContext {\n value: string\n}\n')
		const updated = await updateAdhocPlan(cwd, {
			...input,
			title: 'Updated context ad-hoc',
			tasks: [contextTask()],
		})
		expect(updated.tasks[0]!.relevant_existing_code[0]!.captured_at >= firstCapture).toBe(true)
		expect((await loadAdhocPlan(cwd, 'a01-context')).tasks[0]!.shared_interface_contracts).toHaveLength(1)
	})
})

describe('legacy task context rejection', () => {
	test('rejects a legacy milestone plan with the exact re-plan error', async () => {
		await writeSource(cwd)
		await approvedRoadmap(cwd)
		await transition(cwd, { operation: 'start_milestone_planning' })
		const input = milestoneInput()
		input.tasks = [contextTask()]
		input.waves = [wave('w-context', ['t-context'])]
		await transition(cwd, { operation: 'create_milestone_plan', milestone: input })
		const plan = await loadMilestonePlan(cwd, 'complex-refactor', 'm01-core')
		await writeMarkdownData(
			milestonePlanPath(cwd, 'complex-refactor', 'm01-core'),
			await removeContextFields(plan),
			'# Legacy milestone\n',
		)
		await expect(loadMilestonePlan(cwd, 'complex-refactor', 'm01-core')).rejects.toThrow(LEGACY_ERROR)
	})

	test('rejects a legacy change-request plan with the exact re-plan error', async () => {
		await closeoutPhase(cwd)
		await writeSource(cwd)
		await createChangeRequest(cwd, {
			changeRequestId: 'c01-context',
			title: 'Context change',
			request: 'Exercise structured context.',
			...singleTaskInput(contextTask()),
		})
		const plan = await loadChangeRequest(cwd, 'complex-refactor', 'm01-core', 'c01-context')
		await writeMarkdownData(
			changeRequestPath(cwd, 'complex-refactor', 'm01-core', 'c01-context'),
			await removeContextFields(plan),
			'# Legacy change request\n',
		)
		await expect(loadChangeRequest(cwd, 'complex-refactor', 'm01-core', 'c01-context')).rejects.toThrow(LEGACY_ERROR)
	})

	test('rejects a legacy ad-hoc plan with the exact re-plan error', async () => {
		await writeSource(cwd)
		const plan = await createAdhocPlan(cwd, {
			adhocId: 'a01-context',
			title: 'Context ad-hoc',
			request: 'Exercise structured context.',
			...singleTaskInput(contextTask()),
		})
		await writeMarkdownData(
			adhocPlanPath(cwd, 'a01-context'),
			await removeContextFields(plan),
			'# Legacy ad-hoc plan\n',
		)
		await expect(loadAdhocPlan(cwd, 'a01-context')).rejects.toThrow(LEGACY_ERROR)
	})
})

describe('captureTaskContext', () => {
	test('matches whitespace-normalized signatures and records source metadata', async () => {
		await writeSource(cwd)
		const stat = await fs.stat(path.join(cwd, 'src/context.ts'))
		const [captured] = await captureTaskContext(cwd, [contextTask()], [wave('w1', ['t-context'])])
		expect(captured!.relevant_existing_code[0]!.source_mtime_ms).toBe(stat.mtimeMs)
		expect(captured!.shared_interface_contracts[0]!.source_mtime_ms).toBe(stat.mtimeMs)
		expect(captured!.shared_interface_contracts[0]!.captured_at).toBe(captured!.relevant_existing_code[0]!.captured_at)
	})

	test('accepts only a strictly earlier owning producer for planned contracts', async () => {
		const producer = task('producer', { owned_modules: ['generated'], owned_files: [] })
		const consumer = task('consumer', {
			shared_interface_contracts: [{
				name: 'GeneratedApi',
				signature: 'export interface GeneratedApi',
				source_path: 'generated/api.ts',
				planned: true,
				planned_by_task_id: 'producer',
			}],
		})
		const captured = await captureTaskContext(cwd, [producer, consumer], [wave('w1', ['producer']), wave('w2', ['consumer'])])
		expect(captured[1]!.shared_interface_contracts[0]).toEqual(consumer.shared_interface_contracts[0]!)

		await expect(captureTaskContext(cwd, [producer, consumer], [wave('w1', ['producer', 'consumer'])]))
			.rejects.toThrow('strictly earlier wave')
		await expect(captureTaskContext(cwd, [producer, consumer], [wave('w1', ['consumer']), wave('w2', ['producer'])]))
			.rejects.toThrow('strictly earlier wave')
		await expect(captureTaskContext(
			cwd,
			[{ ...producer, owned_modules: ['other'] }, consumer],
			[wave('w1', ['producer']), wave('w2', ['consumer'])],
		)).rejects.toThrow('does not own generated/api.ts')
		await expect(captureTaskContext(
			cwd,
			[producer, { ...consumer, shared_interface_contracts: [{ ...consumer.shared_interface_contracts[0]!, planned_by_task_id: 'missing' }] }],
			[wave('w1', ['producer']), wave('w2', ['consumer'])],
		)).rejects.toThrow('unknown producer task missing')
	})

	test('requires every task in exactly one wave and rejects unknown wave tasks', async () => {
		const input = task('one')
		await expect(captureTaskContext(cwd, [input], [])).rejects.toThrow('exactly one wave')
		await expect(captureTaskContext(cwd, [input], [wave('w1', ['one']), wave('w2', ['one'])])).rejects.toThrow('exactly one wave')
		await expect(captureTaskContext(cwd, [input], [wave('w1', ['missing'])])).rejects.toThrow('references unknown task missing')
	})

	test('rejects invalid, missing, non-file, escaping, and out-of-range source paths', async () => {
		await writeSource(cwd)
		const reference = contextTask().relevant_existing_code[0]!
		const withReference = (value: typeof reference) => task('one', { relevant_existing_code: [value] })
		await expect(captureTaskContext(cwd, [withReference({ ...reference, path: '../outside.ts' })], [wave('w1', ['one'])]))
			.rejects.toThrow("must not contain '..'")
		await expect(captureTaskContext(cwd, [withReference({ ...reference, path: path.join(cwd, 'src/context.ts') })], [wave('w1', ['one'])]))
			.rejects.toThrow('must be repository-relative')
		await expect(captureTaskContext(cwd, [withReference({ ...reference, path: 'src/missing.ts' })], [wave('w1', ['one'])]))
			.rejects.toThrow('existing regular file')
		await expect(captureTaskContext(cwd, [withReference({ ...reference, path: 'src' })], [wave('w1', ['one'])]))
			.rejects.toThrow('existing regular file')
		await expect(captureTaskContext(cwd, [withReference({ ...reference, line: 0 })], [wave('w1', ['one'])]))
			.rejects.toThrow('1-based positive integer')
		await expect(captureTaskContext(cwd, [withReference({ ...reference, line: 99 })], [wave('w1', ['one'])]))
			.rejects.toThrow('past end of file')

		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'omr-context-outside-'))
		try {
			await fs.writeFile(path.join(outside, 'outside.ts'), 'export const outside = true\n')
			await fs.symlink(path.join(outside, 'outside.ts'), path.join(cwd, 'src/escape.ts'))
			await expect(captureTaskContext(
				cwd,
				[withReference({ ...reference, path: 'src/escape.ts' })],
				[wave('w1', ['one'])],
			)).rejects.toThrow('resolves outside the repository')
		} finally {
			await fs.rm(outside, { recursive: true, force: true })
		}
	})

	test('rejects mismatched existing interfaces and invalid planned flags', async () => {
		await writeSource(cwd)
		const existing = contextTask().shared_interface_contracts[0]!
		await expect(captureTaskContext(
			cwd,
			[task('one', { shared_interface_contracts: [{ ...existing, signature: 'interface Missing {}' }] })],
			[wave('w1', ['one'])],
		)).rejects.toThrow('signature does not match')
		await expect(captureTaskContext(
			cwd,
			[task('one', { shared_interface_contracts: [{ ...existing, planned_by_task_id: 'one' }] })],
			[wave('w1', ['one'])],
		)).rejects.toThrow('forbidden when planned is false')
		await expect(captureTaskContext(
			cwd,
			[task('one', { shared_interface_contracts: [{ ...existing, planned: true }] })],
			[wave('w1', ['one'])],
		)).rejects.toThrow('planned_by_task_id must be non-empty')
	})
})

describe('planning schema and instructions', () => {
	test('requires both structured arrays in the task Zod schema', () => {
		const { taskSchema } = createToolRegistrationSchemas(z as never)
		const valid = task('schema-task')
		expect(taskSchema.safeParse(valid).success).toBe(true)
		const missingReferences = { ...valid } as Record<string, unknown>
		delete missingReferences.relevant_existing_code
		expect(taskSchema.safeParse(missingReferences).success).toBe(false)
		const missingContracts = { ...valid } as Record<string, unknown>
		delete missingContracts.shared_interface_contracts
		expect(taskSchema.safeParse(missingContracts).success).toBe(false)
	})

	test('requires exact pointers, contracts, and planned producers in every planning prompt', async () => {
		const promptFiles = [
			'packages/extension/skills/milestone-planner/SKILL.md',
			'packages/extension/prompts/milestone-plan-template.md',
			'packages/extension/prompts/change-request-template.md',
		]
		const prompts = await Promise.all(promptFiles.map((file) => fs.readFile(path.join(process.cwd(), file), 'utf8')))
		prompts.push(commandPrompt('omr:ms-plan', '', 'state'))
		prompts.push(adhocCommandPrompt('omr:adhoc-new', '', 'state'))
		for (const prompt of prompts) {
			expect(prompt).toContain('relevant_existing_code')
			expect(prompt).toContain('shared_interface_contracts')
			expect(prompt).toContain('planned_by_task_id')
		}
	})
})
