import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { RepoPrimer, RepoPrimerRefreshResult } from '@oh-my-roadmap/core/repo-primer'
import type { ListScoutFindingsResult } from '@oh-my-roadmap/core/store/scout-findings'
import type { StyleGuideEntry } from '@oh-my-roadmap/core/style'
import type { ScoutFinding, TaskPlan } from '@oh-my-roadmap/core/types'
import type { ActivePlanContext } from '@oh-my-roadmap/core/wave-orchestration/context'
import {
	loadWaveContextSources,
	sliceReviewerSeededContext,
	sliceTaskSeededContext,
	type ContextSourceProviders,
} from '@oh-my-roadmap/core/wave-orchestration/context-seeding'

let cwd = ''
let outsideCwd = ''

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'omr-context-seeding-'))
	outsideCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'omr-context-outside-'))
})

afterEach(async () => {
	await Promise.all([
		fs.rm(cwd, { recursive: true, force: true }),
		fs.rm(outsideCwd, { recursive: true, force: true }),
	])
})

function task(id: string, overrides: Partial<TaskPlan> = {}): TaskPlan {
	return {
		id,
		title: `Task ${id}`,
		objective: 'Implement context delivery.',
		implementation_notes: [],
		done_criteria: [],
		verification_commands: [],
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

function activeContext(tasks: TaskPlan[]): ActivePlanContext {
	return {
		roadmapId: 'roadmap-1',
		milestoneId: 'milestone-1',
		isAdhoc: false,
		activeTasks: tasks,
		activeWave: {
			id: 'wave-1',
			goal: 'Deliver context.',
			exit_criteria: [],
			review_checkpoint: 'Review context.',
			status: 'running',
			tasks: tasks.map((candidate) => candidate.id),
		},
	} as unknown as ActivePlanContext
}

function primer(overrides: Partial<RepoPrimer> = {}): RepoPrimer {
	return {
		schema_version: 1,
		generated_at: '2026-07-23T00:00:00.000Z',
		source_fingerprint: 'a'.repeat(64),
		package_managers: ['bun'],
		manifests: [],
		workspace_members: [],
		commands: [],
		test_roots: ['test'],
		module_roots: ['src'],
		guidance: [],
		warnings: [],
		...overrides,
	}
}

function finding(id: string, createdAt: string, sourcePaths: string[], stale = false): ScoutFinding {
	return {
		id,
		roadmap_id: 'roadmap-1',
		subsystem: 'core',
		milestone_ids: ['milestone-1'],
		source_paths: sourcePaths,
		summary: id,
		findings: [],
		created_by: 'scout',
		created_at: createdAt,
		...(stale ? { stale: true } : {}),
	}
}

function providers(options: {
	primer?: RepoPrimerRefreshResult;
	findings?: ScoutFinding[];
	style?: StyleGuideEntry[];
} = {}): { providers: ContextSourceProviders; calls: { primer: number; scouts: number; style: number; styleFiles: string[] } } {
	const calls = { primer: 0, scouts: 0, style: 0, styleFiles: [] as string[] }
	const findings = options.findings ?? []
	return {
		calls,
		providers: {
			async refreshRepoPrimer() {
				calls.primer += 1
				return options.primer ?? { status: 'created', primer: primer(), warnings: [] }
			},
			async listScoutFindings(_cwd, input) {
				calls.scouts += 1
				expect(input).toEqual({ roadmapId: 'roadmap-1', includeStale: false, limit: Number.MAX_SAFE_INTEGER })
				return {
					roadmapId: 'roadmap-1',
					total: findings.length,
					returned: findings.length,
					findings,
				} satisfies ListScoutFindingsResult
			},
			async styleGuideForFiles(_cwd, files) {
				calls.style += 1
				calls.styleFiles = files
				return options.style ?? []
			},
		},
	}
}

async function writeSource(relativePath: string, contents: string): Promise<number> {
	const target = path.join(cwd, relativePath)
	await fs.mkdir(path.dirname(target), { recursive: true })
	await fs.writeFile(target, contents, 'utf8')
	return (await fs.stat(target)).mtimeMs
}

describe('bounded seeded context source loading', () => {
	test('loads each provider once and pure task slices boundary-match own, ancestor, descendant, and pathless scouts', async () => {
		const ownTask = task('own', {
			owned_files: ['src/feature.ts'],
			owned_modules: ['packages/core'],
		})
		const fixture = providers({
			findings: [
				finding('own', '2026-07-23T01:00:00.000Z', ['src/feature.ts']),
				finding('prefix-only', '2026-07-23T05:00:00.000Z', ['src/feature.ts-extra']),
				finding('ancestor', '2026-07-23T02:00:00.000Z', ['packages']),
				finding('descendant', '2026-07-23T03:00:00.000Z', ['packages/core/src/index.ts']),
				finding('pathless', '2026-07-23T04:00:00.000Z', []),
				finding('stale', '2026-07-23T06:00:00.000Z', [], true),
			],
			style: [
				{ language: 'go', guide: { guidelines: ['unrelated-go-rule'] } },
				{ language: 'typescript', guide: { guidelines: ['task-ts-rule'] } },
			],
		})
		const sources = await loadWaveContextSources(cwd, activeContext([ownTask]), fixture.providers)

		expect(fixture.calls).toEqual({
			primer: 1,
			scouts: 1,
			style: 1,
			styleFiles: ['src/feature.ts', 'packages/core'],
		})
		const first = sliceTaskSeededContext(sources, ownTask)
		const second = sliceTaskSeededContext(sources, ownTask)
		expect(second).toEqual(first)
		expect(first.scout_findings.items.map((item) => item.id)).toEqual([
			'pathless',
			'descendant',
			'ancestor',
			'own',
		])
		expect(first.style_guidance.text).toContain('task-ts-rule')
		expect(first.style_guidance.text).not.toContain('unrelated-go-rule')
		expect(fixture.calls.primer).toBe(1)
		expect(fixture.calls.scouts).toBe(1)
		expect(fixture.calls.style).toBe(1)
	})

	test('omits stale, missing, mismatched, and realpath-escaping sources while resolving landed planned signatures', async () => {
		const liveMtime = await writeSource('src/live.ts', 'export interface Live { value: string }\n')
		const outsideTarget = path.join(outsideCwd, 'outside.ts')
		await fs.writeFile(outsideTarget, 'export interface Outside {}\n', 'utf8')
		await fs.symlink(outsideTarget, path.join(cwd, 'outside.ts'))
		const contextTask = task('sources', {
			relevant_existing_code: [
				{ path: 'src/live.ts', note: 'live', captured_at: 'now', source_mtime_ms: liveMtime },
				{ path: 'src/live.ts', note: 'stale', captured_at: 'then', source_mtime_ms: liveMtime + 1 },
				{ path: 'src/missing.ts', note: 'missing', captured_at: 'then', source_mtime_ms: 1 },
				{ path: 'outside.ts', note: 'outside', captured_at: 'then', source_mtime_ms: 1 },
			],
			shared_interface_contracts: [
				{ name: 'Live', signature: 'interface Live { value: string }', source_path: 'src/live.ts', planned: false, captured_at: 'now', source_mtime_ms: liveMtime },
				{ name: 'PlannedLive', signature: 'export   interface Live {\n value: string }', source_path: 'src/live.ts', planned: true, planned_by_task_id: 'producer' },
				{ name: 'Mismatch', signature: 'interface Missing {}', source_path: 'src/live.ts', planned: false, captured_at: 'now', source_mtime_ms: liveMtime },
				{ name: 'Missing', signature: 'interface Missing {}', source_path: 'src/missing.ts', planned: true, planned_by_task_id: 'producer' },
				{ name: 'Outside', signature: 'interface Outside {}', source_path: 'outside.ts', planned: true, planned_by_task_id: 'producer' },
			],
		})
		const fixture = providers()
		const sources = await loadWaveContextSources(cwd, activeContext([contextTask]), fixture.providers)
		const seeded = sliceTaskSeededContext(sources, contextTask)

		expect(seeded.relevant_existing_code.items.map((item) => item.note)).toEqual(['live'])
		expect(seeded.shared_interface_contracts.items.map((item) => item.name)).toEqual(['Live', 'PlannedLive'])
		expect(seeded.shared_interface_contracts.items.every((item) => item.current_source_mtime_ms === liveMtime)).toBe(true)
		expect(seeded.warnings.items.map((warning) => warning.kind)).toEqual([
			'stale_source',
			'missing_source',
			'outside_repo',
			'signature_mismatch',
			'missing_source',
			'outside_repo',
		])
		expect(seeded.warnings.items.map((warning) => warning.item)).toEqual([
			'relevant_existing_code[1]',
			'relevant_existing_code[2]',
			'relevant_existing_code[3]',
			'shared_interface_contracts[2]',
			'shared_interface_contracts[3]',
			'shared_interface_contracts[4]',
		])
	})

	test('delivers stale fallback primer non-gating and omits unavailable primer with typed warnings', async () => {
		const contextTask = task('primer')
		const staleFixture = providers({
			primer: { status: 'stale_fallback', primer: primer(), warnings: ['scan failed'] },
		})
		const staleSources = await loadWaveContextSources(cwd, activeContext([contextTask]), staleFixture.providers)
		const stale = sliceTaskSeededContext(staleSources, contextTask)
		expect(stale.repo_primer?.source_fingerprint).toBe('a'.repeat(64))
		expect(stale.warnings.items).toEqual([{ kind: 'primer_refresh_failed', message: 'scan failed' }])

		const unavailableFixture = providers({
			primer: { status: 'unavailable', warnings: ['no last good primer'] },
		})
		const unavailableSources = await loadWaveContextSources(cwd, activeContext([contextTask]), unavailableFixture.providers)
		const unavailable = sliceTaskSeededContext(unavailableSources, contextTask)
		expect(unavailable.repo_primer).toBeUndefined()
		expect(unavailable.warnings.items).toEqual([{ kind: 'primer_unavailable', message: 'no last good primer' }])
	})
})

describe('task and reviewer seeded context caps', () => {
	test('enforces byte/data caps and reviewer stable first-occurrence dedupe across task order', async () => {
		const sourceMtime = await writeSource('src/shared.ts', 'export const sharedApi = 1\n')
		const refs = (start: number, count: number) => Array.from({ length: count }, (_, offset) => ({
			path: 'src/shared.ts',
			note: `reference-${start + offset}`,
			captured_at: 'now',
			source_mtime_ms: sourceMtime,
		}))
		const contracts = (start: number, count: number) => Array.from({ length: count }, (_, offset) => ({
			name: `Contract${start + offset}`,
			signature: 'export const sharedApi = 1',
			source_path: 'src/shared.ts',
			planned: false as const,
			captured_at: 'now',
			source_mtime_ms: sourceMtime,
		}))
		const firstTask = task('first', {
			owned_modules: ['src'],
			relevant_existing_code: refs(0, 21),
			shared_interface_contracts: contracts(0, 21),
		})
		const secondTask = task('second', {
			owned_modules: ['src'],
			relevant_existing_code: [...refs(0, 5), ...refs(21, 4)],
			shared_interface_contracts: [...contracts(0, 5), ...contracts(21, 4)],
		})
		const scoutFindings = Array.from({ length: 25 }, (_, index) => finding(
			`scout-${index}`,
			`2026-07-23T00:${String(index).padStart(2, '0')}:00.000Z`,
			[],
		))
		const fixture = providers({
			findings: scoutFindings,
			style: [{ language: 'typescript', guide: { summary: 'x'.repeat(9000), guidelines: [] } }],
			primer: { status: 'created', primer: primer({ warnings: ['p'.repeat(15000)] }), warnings: [] },
		})
		const sources = await loadWaveContextSources(cwd, activeContext([firstTask, secondTask]), fixture.providers)

		const taskSeeded = sliceTaskSeededContext(sources, firstTask)
		expect(taskSeeded.relevant_existing_code).toMatchObject({ total: 21, included: 20, truncated: 1 })
		expect(taskSeeded.shared_interface_contracts).toMatchObject({ total: 21, included: 20, truncated: 1 })
		expect(taskSeeded.scout_findings).toMatchObject({ total: 25, included: 10, truncated: 15 })
		expect(taskSeeded.style_guidance).toMatchObject({ bytes: 8192, truncated: true })
		expect(taskSeeded.repo_primer).toMatchObject({ bytes: 12288, truncated: true })
		expect(taskSeeded.warnings.items.at(-1)).toMatchObject({ kind: 'truncated' })
		expect(taskSeeded.warnings.items.at(-1)?.message).toContain('relevant_existing_code, shared_interface_contracts, scout_findings, style_guidance, repo_primer')

		const reviewer = sliceReviewerSeededContext(sources, [firstTask, secondTask])
		expect(reviewer.relevant_existing_code).toMatchObject({ total: 25, included: 20, truncated: 5 })
		expect(reviewer.relevant_existing_code.items.map((item) => item.note)).toEqual(
			Array.from({ length: 20 }, (_, index) => `reference-${index}`),
		)
		expect(reviewer.shared_interface_contracts).toMatchObject({ total: 25, included: 20, truncated: 5 })
		expect(reviewer.shared_interface_contracts.items.map((item) => item.name)).toEqual(
			Array.from({ length: 20 }, (_, index) => `Contract${index}`),
		)
		expect(reviewer.scout_findings).toMatchObject({ total: 25, included: 20, truncated: 5 })
		expect(new Set(reviewer.scout_findings.items.map((item) => item.id)).size).toBe(20)
		expect(reviewer.scout_findings.items[0]?.id).toBe('scout-24')
		expect(reviewer.warnings.items.at(-1)?.message).toContain('relevant_existing_code, shared_interface_contracts, scout_findings, style_guidance, repo_primer')
	})

	test('reserves reviewer warning slot 20 after stable multi-task merge with exactly 20 ordinary warnings and another truncated field', async () => {
		const sourceMtime = await writeSource('src/warning-shared.ts', 'export const firstApi = 1\nexport const secondApi = 2\n')
		const firstReference = {
			path: 'src/warning-shared.ts',
			note: 'first-reference',
			captured_at: 'now',
			source_mtime_ms: sourceMtime,
		}
		const firstContract = {
			name: 'FirstApi',
			signature: 'export const firstApi = 1',
			source_path: 'src/warning-shared.ts',
			planned: false as const,
			captured_at: 'now',
			source_mtime_ms: sourceMtime,
		}
		const firstTask = task('warning-first', {
			owned_modules: ['src'],
			relevant_existing_code: [
				firstReference,
				...Array.from({ length: 10 }, (_, index) => ({
					path: `src/first-missing-${index}.ts`,
					note: `first-missing-${index}`,
					captured_at: 'then',
					source_mtime_ms: 1,
				})),
			],
			shared_interface_contracts: [firstContract],
		})
		const secondTask = task('warning-second', {
			owned_modules: ['src'],
			relevant_existing_code: [
				firstReference,
				{
					path: 'src/warning-shared.ts',
					note: 'second-reference',
					captured_at: 'now',
					source_mtime_ms: sourceMtime,
				},
				...Array.from({ length: 10 }, (_, index) => ({
					path: `src/second-missing-${index}.ts`,
					note: `second-missing-${index}`,
					captured_at: 'then',
					source_mtime_ms: 1,
				})),
			],
			shared_interface_contracts: [
				firstContract,
				{
					name: 'SecondApi',
					signature: 'export const secondApi = 2',
					source_path: 'src/warning-shared.ts',
					planned: false,
					captured_at: 'now',
					source_mtime_ms: sourceMtime,
				},
			],
		})
		const fixture = providers({
			findings: Array.from({ length: 21 }, (_, index) => finding(
				`finding-${index}`,
				`2026-07-23T00:${String(index).padStart(2, '0')}:00.000Z`,
				[],
			)),
		})
		const sources = await loadWaveContextSources(cwd, activeContext([firstTask, secondTask]), fixture.providers)
		const reviewer = sliceReviewerSeededContext(sources, [firstTask, secondTask])

		expect(reviewer.relevant_existing_code.items.map((reference) => reference.note)).toEqual([
			'first-reference',
			'second-reference',
		])
		expect(reviewer.shared_interface_contracts.items.map((contract) => contract.name)).toEqual([
			'FirstApi',
			'SecondApi',
		])
		expect(reviewer.scout_findings).toMatchObject({ total: 21, included: 20, truncated: 1 })
		expect(reviewer.warnings).toMatchObject({ total: 21, included: 20, truncated: 1 })
		expect(reviewer.warnings.items.slice(0, 10).map((warning) => warning.task_id)).toEqual(
			Array.from({ length: 10 }, () => 'warning-first'),
		)
		expect(reviewer.warnings.items.slice(10, 19).map((warning) => warning.task_id)).toEqual(
			Array.from({ length: 9 }, () => 'warning-second'),
		)
		expect(reviewer.warnings.items.slice(0, 19).every((warning) => warning.kind === 'missing_source')).toBe(true)
		expect(reviewer.warnings.items[19]).toEqual({
			kind: 'truncated',
			message: 'Context truncated fields: scout_findings; omitted ordinary warnings: 1.',
		})
		expect(reviewer.warnings.items.filter((warning) => warning.kind === 'truncated')).toHaveLength(1)
	})
})
