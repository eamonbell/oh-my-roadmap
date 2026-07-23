import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
	RelevantCodeReference,
	RelevantCodeReferenceInput,
	SharedInterfaceContract,
	SharedInterfaceContractInput,
	TaskPlan,
	TaskPlanInput,
	WavePlan,
} from './types'

function requireNonEmpty(value: string | undefined, label: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be non-empty`)
	return value
}

function validateLine(line: number | undefined, label: string): void {
	if (line !== undefined && (!Number.isInteger(line) || line < 1)) {
		throw new Error(`${label} must be a 1-based positive integer`)
	}
}

function validateRepoRelativePath(value: string, label: string): string {
	requireNonEmpty(value, label)
	if (path.isAbsolute(value)) throw new Error(`${label} must be repository-relative: ${value}`)
	const components = value.split(/[\\/]/)
	if (components.includes('..')) throw new Error(`${label} must not contain '..': ${value}`)
	if (components.some((component) => component.length === 0 || component === '.')) {
		throw new Error(`${label} must be a lexical repository-relative path: ${value}`)
	}
	return value
}

function isInsideRepository(repositoryRealpath: string, sourceRealpath: string): boolean {
	const relative = path.relative(repositoryRealpath, sourceRealpath)
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function normalizedWhitespace(value: string): string {
	return value.trim().replace(/\s+/g, ' ')
}

function lineCount(contents: string): number {
	if (contents.length === 0) return 0
	return contents.split(/\r?\n/).length
}

interface VerifiedSource {
	contents: string;
	mtimeMs: number;
}

async function verifyExistingSource(
	repositoryRealpath: string,
	cwd: string,
	sourcePath: string,
	line: number | undefined,
	label: string,
): Promise<VerifiedSource> {
	validateRepoRelativePath(sourcePath, label)
	let sourceRealpath: string
	try {
		sourceRealpath = await fs.realpath(path.resolve(cwd, sourcePath))
	} catch {
		throw new Error(`${label} must reference an existing regular file: ${sourcePath}`)
	}
	if (!isInsideRepository(repositoryRealpath, sourceRealpath)) {
		throw new Error(`${label} resolves outside the repository: ${sourcePath}`)
	}
	const stat = await fs.stat(sourceRealpath)
	if (!stat.isFile()) throw new Error(`${label} must reference an existing regular file: ${sourcePath}`)
	const contents = await fs.readFile(sourceRealpath, 'utf8')
	if (line !== undefined && line > lineCount(contents)) {
		throw new Error(`${label} line ${line} is past end of file: ${sourcePath}`)
	}
	return { contents, mtimeMs: stat.mtimeMs }
}

function ownsPlannedSource(producer: TaskPlanInput, sourcePath: string): boolean {
	if (producer.owned_files.some((ownedFile) => ownedFile === sourcePath)) return true
	return producer.owned_modules.some((ownedModule) => {
		const ancestor = ownedModule.replace(/[\\/]+$/, '')
		return ancestor.length > 0 && (sourcePath === ancestor || sourcePath.startsWith(`${ancestor}/`))
	})
}

function validateRelevantCodeInput(input: RelevantCodeReferenceInput, taskId: string, index: number): void {
	const label = `Task ${taskId} relevant_existing_code[${index}]`
	validateRepoRelativePath(input.path, `${label}.path`)
	validateLine(input.line, `${label}.line`)
	if (input.symbol !== undefined) requireNonEmpty(input.symbol, `${label}.symbol`)
	requireNonEmpty(input.note, `${label}.note`)
}

function validateInterfaceInput(input: SharedInterfaceContractInput, taskId: string, index: number): void {
	const label = `Task ${taskId} shared_interface_contracts[${index}]`
	requireNonEmpty(input.name, `${label}.name`)
	requireNonEmpty(input.signature, `${label}.signature`)
	validateRepoRelativePath(input.source_path, `${label}.source_path`)
	validateLine(input.line, `${label}.line`)
	if (typeof input.planned !== 'boolean') throw new Error(`${label}.planned must be a boolean`)
}

export async function captureTaskContext(
	cwd: string,
	taskInputs: TaskPlanInput[],
	waves: WavePlan[],
): Promise<TaskPlan[]> {
	const repositoryRealpath = await fs.realpath(cwd)
	const taskById = new Map<string, TaskPlanInput>()
	for (const task of taskInputs) {
		requireNonEmpty(task.id, 'Task id')
		if (taskById.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`)
		taskById.set(task.id, task)
	}

	const waveIndexByTaskId = new Map<string, number>()
	const membershipCount = new Map<string, number>()
	for (const [waveIndex, wave] of waves.entries()) {
		for (const taskId of wave.tasks) {
			if (!taskById.has(taskId)) throw new Error(`Wave ${wave.id} references unknown task ${taskId}`)
			membershipCount.set(taskId, (membershipCount.get(taskId) ?? 0) + 1)
			if (!waveIndexByTaskId.has(taskId)) waveIndexByTaskId.set(taskId, waveIndex)
		}
	}
	for (const task of taskInputs) {
		const count = membershipCount.get(task.id) ?? 0
		if (count !== 1) throw new Error(`Task ${task.id} must appear in exactly one wave (found ${count})`)
	}

	const capturedAt = new Date().toISOString()
	const tasks: TaskPlan[] = []
	for (const task of taskInputs) {
		const relevantExistingCode: RelevantCodeReference[] = []
		for (const [index, reference] of task.relevant_existing_code.entries()) {
			validateRelevantCodeInput(reference, task.id, index)
			const verified = await verifyExistingSource(
				repositoryRealpath,
				cwd,
				reference.path,
				reference.line,
				`Task ${task.id} relevant_existing_code[${index}].path`,
			)
			relevantExistingCode.push({
				path: reference.path,
				...(reference.line !== undefined ? { line: reference.line } : {}),
				...(reference.symbol !== undefined ? { symbol: reference.symbol } : {}),
				note: reference.note,
				captured_at: capturedAt,
				source_mtime_ms: verified.mtimeMs,
			})
		}

		const sharedInterfaceContracts: SharedInterfaceContract[] = []
		for (const [index, contract] of task.shared_interface_contracts.entries()) {
			validateInterfaceInput(contract, task.id, index)
			const label = `Task ${task.id} shared_interface_contracts[${index}]`
			if (!contract.planned) {
				if (contract.planned_by_task_id !== undefined) {
					throw new Error(`${label}.planned_by_task_id is forbidden when planned is false`)
				}
				const verified = await verifyExistingSource(
					repositoryRealpath,
					cwd,
					contract.source_path,
					contract.line,
					`${label}.source_path`,
				)
				if (!normalizedWhitespace(verified.contents).includes(normalizedWhitespace(contract.signature))) {
					throw new Error(`${label}.signature does not match source ${contract.source_path}`)
				}
				sharedInterfaceContracts.push({
					name: contract.name,
					signature: contract.signature,
					source_path: contract.source_path,
					...(contract.line !== undefined ? { line: contract.line } : {}),
					planned: false,
					captured_at: capturedAt,
					source_mtime_ms: verified.mtimeMs,
				})
				continue
			}

			const producerId = requireNonEmpty(contract.planned_by_task_id, `${label}.planned_by_task_id`)
			const producer = taskById.get(producerId)
			if (!producer) throw new Error(`${label} references unknown producer task ${producerId}`)
			const consumerWaveIndex = waveIndexByTaskId.get(task.id)
			const producerWaveIndex = waveIndexByTaskId.get(producerId)
			if (producerWaveIndex === undefined || consumerWaveIndex === undefined || producerWaveIndex >= consumerWaveIndex) {
				throw new Error(`${label} producer ${producerId} must be in a strictly earlier wave`)
			}
			if (!ownsPlannedSource(producer, contract.source_path)) {
				throw new Error(`${label} producer ${producerId} does not own ${contract.source_path}`)
			}
			sharedInterfaceContracts.push({
				name: contract.name,
				signature: contract.signature,
				source_path: contract.source_path,
				...(contract.line !== undefined ? { line: contract.line } : {}),
				planned: true,
				planned_by_task_id: producerId,
			})
		}

		tasks.push({
			...task,
			relevant_existing_code: relevantExistingCode,
			shared_interface_contracts: sharedInterfaceContracts,
		})
	}
	return tasks
}
