import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { refreshRepoPrimer, renderRepoPrimer, type RepoPrimerRefreshResult } from '../repo-primer'
import { detectLanguages, renderStyleGuide, styleGuideForFiles, type StyleGuideEntry } from '../style'
import { listScoutFindings, type ListScoutFindingsResult } from '../store/scout-findings'
import type { RelevantCodeReference, ScoutFinding, TaskPlan } from '../types'
import type { ActivePlanContext } from './context'
import type {
	CappedContextItems,
	RenderedContextBlock,
	ResolvedSharedInterfaceContract,
	SeededContext,
	SeededContextWarning,
	SeededRepoPrimerBlock,
} from './types'

const TASK_CODE_REFERENCE_CAP = 20
const TASK_INTERFACE_CAP = 20
const TASK_SCOUT_CAP = 10
const REVIEW_CODE_REFERENCE_CAP = 20
const REVIEW_INTERFACE_CAP = 20
const REVIEW_SCOUT_CAP = 20
const STYLE_BYTE_CAP = 8 * 1024
const PRIMER_BYTE_CAP = 12 * 1024
const WARNING_CAP = 20

export interface ContextSourceProviders {
	refreshRepoPrimer(cwd: string): Promise<RepoPrimerRefreshResult>;
	listScoutFindings(cwd: string, input: { roadmapId: string; includeStale: boolean; limit: number }): Promise<ListScoutFindingsResult>;
	styleGuideForFiles(cwd: string, files: string[]): Promise<StyleGuideEntry[]>;
}

interface LoadedTaskContext {
	relevantExistingCode: RelevantCodeReference[];
	sharedInterfaceContracts: ResolvedSharedInterfaceContract[];
	warnings: SeededContextWarning[];
}

export interface LoadedWaveContextSources {
	readonly taskContextById: ReadonlyMap<string, LoadedTaskContext>;
	readonly scoutFindings: readonly ScoutFinding[];
	readonly styleGuidance: RenderedContextBlock;
	readonly styleEntries: readonly StyleGuideEntry[];
	readonly repoPrimer?: SeededRepoPrimerBlock;
	readonly commonWarnings: readonly SeededContextWarning[];
}

interface InspectedSource {
	status: 'available' | 'missing' | 'outside_repo';
	mtimeMs?: number;
	contents?: string;
}

const DEFAULT_PROVIDERS: ContextSourceProviders = {
	refreshRepoPrimer,
	listScoutFindings,
	styleGuideForFiles,
}

function utf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return ''
	const bytes = Buffer.from(text)
	if (bytes.byteLength <= maxBytes) return text
	let end = maxBytes
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
	return bytes.subarray(0, end).toString('utf8')
}

function renderBoundedText(text: string, maxBytes: number): RenderedContextBlock {
	const fullBytes = Buffer.byteLength(text)
	if (fullBytes <= maxBytes) return { text, bytes: fullBytes, truncated: false }
	const marker = '\n[truncated]'
	const markerBytes = Buffer.byteLength(marker)
	const rendered = maxBytes >= markerBytes
		? `${utf8Prefix(text, maxBytes - markerBytes)}${marker}`
		: utf8Prefix(marker, maxBytes)
	return { text: rendered, bytes: Buffer.byteLength(rendered), truncated: true }
}

function capItems<T>(items: T[], limit: number): CappedContextItems<T> {
	const includedItems = items.slice(0, limit)
	return {
		items: includedItems,
		total: items.length,
		included: includedItems.length,
		truncated: items.length - includedItems.length,
	}
}

function isLexicallyOutsideRepository(sourcePath: string): boolean {
	if (path.isAbsolute(sourcePath)) return true
	const parts = sourcePath.split(/[\\/]/)
	return parts.includes('..')
}

function isInsideRepository(repositoryRealpath: string, sourceRealpath: string): boolean {
	const relative = path.relative(repositoryRealpath, sourceRealpath)
	return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function inspectSource(
	cwd: string,
	repositoryRealpath: string,
	sourcePath: string,
): Promise<InspectedSource> {
	if (isLexicallyOutsideRepository(sourcePath)) return { status: 'outside_repo' }
	let sourceRealpath: string
	try {
		sourceRealpath = await fs.realpath(path.resolve(cwd, sourcePath))
	} catch {
		return { status: 'missing' }
	}
	if (!isInsideRepository(repositoryRealpath, sourceRealpath)) return { status: 'outside_repo' }
	try {
		const stat = await fs.stat(sourceRealpath)
		if (!stat.isFile()) return { status: 'missing' }
		return {
			status: 'available',
			mtimeMs: stat.mtimeMs,
			contents: await fs.readFile(sourceRealpath, 'utf8'),
		}
	} catch {
		return { status: 'missing' }
	}
}

function normalizedWhitespace(value: string): string {
	return value.trim().replace(/\s+/g, ' ')
}

function itemWarning(
	kind: SeededContextWarning['kind'],
	message: string,
	task: TaskPlan,
	item: string,
	sourcePath: string,
): SeededContextWarning {
	return { kind, message, path: sourcePath, task_id: task.id, item }
}

async function resolveTaskContext(
	task: TaskPlan,
	inspect: (sourcePath: string) => Promise<InspectedSource>,
): Promise<LoadedTaskContext> {
	const relevantExistingCode: RelevantCodeReference[] = []
	const sharedInterfaceContracts: ResolvedSharedInterfaceContract[] = []
	const warnings: SeededContextWarning[] = []

	for (const [index, reference] of task.relevant_existing_code.entries()) {
		const item = `relevant_existing_code[${index}]`
		const source = await inspect(reference.path)
		if (source.status === 'outside_repo') {
			warnings.push(itemWarning('outside_repo', `Omitted ${item}: ${reference.path} resolves outside the repository.`, task, item, reference.path))
			continue
		}
		if (source.status === 'missing' || source.mtimeMs === undefined) {
			warnings.push(itemWarning('missing_source', `Omitted ${item}: ${reference.path} is not a live regular file.`, task, item, reference.path))
			continue
		}
		if (source.mtimeMs !== reference.source_mtime_ms) {
			warnings.push(itemWarning('stale_source', `Omitted ${item}: ${reference.path} changed after capture.`, task, item, reference.path))
			continue
		}
		relevantExistingCode.push(reference)
	}

	for (const [index, contract] of task.shared_interface_contracts.entries()) {
		const item = `shared_interface_contracts[${index}]`
		const source = await inspect(contract.source_path)
		if (source.status === 'outside_repo') {
			warnings.push(itemWarning('outside_repo', `Omitted ${item}: ${contract.source_path} resolves outside the repository.`, task, item, contract.source_path))
			continue
		}
		if (source.status === 'missing' || source.mtimeMs === undefined || source.contents === undefined) {
			warnings.push(itemWarning('missing_source', `Omitted ${item}: ${contract.source_path} is not a live regular file.`, task, item, contract.source_path))
			continue
		}
		if (!normalizedWhitespace(source.contents).includes(normalizedWhitespace(contract.signature))) {
			warnings.push(itemWarning('signature_mismatch', `Omitted ${item}: ${contract.name} no longer matches ${contract.source_path}.`, task, item, contract.source_path))
			continue
		}
		sharedInterfaceContracts.push({ ...contract, current_source_mtime_ms: source.mtimeMs })
	}

	return { relevantExistingCode, sharedInterfaceContracts, warnings }
}

function normalizeMatchPath(value: string): string {
	const slashPath = value.replace(/\\/g, '/')
	const normalized = path.posix.normalize(slashPath)
	return normalized.replace(/^\.\//, '').replace(/\/$/, '')
}

function pathsOverlap(left: string, right: string): boolean {
	const normalizedLeft = normalizeMatchPath(left)
	const normalizedRight = normalizeMatchPath(right)
	if (normalizedLeft === normalizedRight) return true
	return normalizedLeft.startsWith(`${normalizedRight}/`) || normalizedRight.startsWith(`${normalizedLeft}/`)
}

function findingMatchesTask(finding: ScoutFinding, task: TaskPlan): boolean {
	if (finding.source_paths.length === 0) return true
	const ownership = [...task.owned_files, ...task.owned_modules]
	return finding.source_paths.some((sourcePath) => ownership.some((ownedPath) => pathsOverlap(sourcePath, ownedPath)))
}

function sortNewestFirst(findings: ScoutFinding[]): ScoutFinding[] {
	return findings
		.map((finding, index) => ({ finding, index }))
		.sort((left, right) => {
			const byDate = right.finding.created_at.localeCompare(left.finding.created_at)
			return byDate !== 0 ? byDate : left.index - right.index
		})
		.map(({ finding }) => finding)
}

function primerContext(result: RepoPrimerRefreshResult): {
	block?: SeededRepoPrimerBlock;
	warnings: SeededContextWarning[];
} {
	if (result.status === 'unavailable') {
		return {
			warnings: [{
				kind: 'primer_unavailable',
				message: result.warnings.join('; ') || 'Repository primer is unavailable.',
			}],
		}
	}
	const rendered = renderRepoPrimer(result.primer, PRIMER_BYTE_CAP)
	const block: SeededRepoPrimerBlock = {
		...rendered,
		generated_at: result.primer.generated_at,
		source_fingerprint: result.primer.source_fingerprint,
	}
	if (result.status !== 'stale_fallback') return { block, warnings: [] }
	return {
		block,
		warnings: [{
			kind: 'primer_refresh_failed',
			message: result.warnings.join('; ') || 'Repository primer refresh failed; using the last good primer.',
		}],
	}
}

export async function loadWaveContextSources(
	cwd: string,
	ctx: ActivePlanContext,
	providers: ContextSourceProviders = DEFAULT_PROVIDERS,
): Promise<LoadedWaveContextSources> {
	const ownership = Array.from(new Set(ctx.activeTasks.flatMap((task) => [...task.owned_files, ...task.owned_modules])))
	const [primerResult, scoutResult, styleEntries, repositoryRealpath] = await Promise.all([
		providers.refreshRepoPrimer(cwd).catch((error: unknown): RepoPrimerRefreshResult => ({
			status: 'unavailable',
			warnings: [`Repository primer refresh failed: ${(error as Error).message}`],
		})),
		providers.listScoutFindings(cwd, {
			roadmapId: ctx.roadmapId,
			includeStale: false,
			limit: Number.MAX_SAFE_INTEGER,
		}),
		providers.styleGuideForFiles(cwd, ownership),
		fs.realpath(cwd),
	])

	const inspectionCache = new Map<string, Promise<InspectedSource>>()
	const inspect = (sourcePath: string): Promise<InspectedSource> => {
		let pending = inspectionCache.get(sourcePath)
		if (!pending) {
			pending = inspectSource(cwd, repositoryRealpath, sourcePath)
			inspectionCache.set(sourcePath, pending)
		}
		return pending
	}
	const taskContexts = await Promise.all(ctx.activeTasks.map(async (task) => [task.id, await resolveTaskContext(task, inspect)] as const))
	const primer = primerContext(primerResult)
	return {
		taskContextById: new Map(taskContexts),
		scoutFindings: sortNewestFirst(scoutResult.findings.filter((finding) => finding.stale !== true)),
		styleGuidance: renderBoundedText(renderStyleGuide(styleEntries), STYLE_BYTE_CAP),
		styleEntries,
		...(primer.block ? { repoPrimer: primer.block } : {}),
		commonWarnings: primer.warnings,
	}
}

function referenceKey(reference: RelevantCodeReference): string {
	return JSON.stringify([reference.path, reference.line ?? null, reference.symbol ?? null, reference.note])
}

function interfaceKey(contract: ResolvedSharedInterfaceContract): string {
	return JSON.stringify([contract.name, contract.source_path, contract.signature])
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>()
	return items.filter((item) => {
		const value = key(item)
		if (seen.has(value)) return false
		seen.add(value)
		return true
	})
}

function warningItems(
	ordinaryWarnings: SeededContextWarning[],
	truncatedFields: string[],
): CappedContextItems<SeededContextWarning> {
	const needsAggregate = truncatedFields.length > 0 || ordinaryWarnings.length > WARNING_CAP
	if (!needsAggregate) return capItems(ordinaryWarnings, WARNING_CAP)
	const fields = ordinaryWarnings.length > WARNING_CAP ? [...truncatedFields, 'warnings'] : truncatedFields
	const omittedOrdinaryWarnings = Math.max(0, ordinaryWarnings.length - (WARNING_CAP - 1))
	const marker: SeededContextWarning = {
		kind: 'truncated',
		message: `Context truncated fields: ${fields.join(', ')}; omitted ordinary warnings: ${omittedOrdinaryWarnings}.`,
	}
	const items = [...ordinaryWarnings.slice(0, WARNING_CAP - 1), marker]
	const total = ordinaryWarnings.length + 1
	const included = Math.min(total, WARNING_CAP)
	return { items: items.slice(0, included), total, included, truncated: total - included }
}

function truncatedFields(
	references: CappedContextItems<RelevantCodeReference>,
	interfaces: CappedContextItems<ResolvedSharedInterfaceContract>,
	scouts: CappedContextItems<ScoutFinding>,
	styleGuidance: RenderedContextBlock,
	repoPrimer: SeededRepoPrimerBlock | undefined,
): string[] {
	const fields: string[] = []
	if (references.truncated > 0) fields.push('relevant_existing_code')
	if (interfaces.truncated > 0) fields.push('shared_interface_contracts')
	if (scouts.truncated > 0) fields.push('scout_findings')
	if (styleGuidance.truncated) fields.push('style_guidance')
	if (repoPrimer?.truncated) fields.push('repo_primer')
	return fields
}

function taskContext(sources: LoadedWaveContextSources, task: TaskPlan): LoadedTaskContext {
	const loaded = sources.taskContextById.get(task.id)
	if (!loaded) throw new Error(`Seeded context sources do not include active task ${task.id}`)
	return loaded
}

function taskStyleGuidance(sources: LoadedWaveContextSources, task: TaskPlan): RenderedContextBlock {
	const languages = new Set(detectLanguages([...task.owned_files, ...task.owned_modules]))
	const entries = sources.styleEntries.filter((entry) => languages.has(entry.language))
	return renderBoundedText(renderStyleGuide(entries), STYLE_BYTE_CAP)
}

export function sliceTaskSeededContext(sources: LoadedWaveContextSources, task: TaskPlan): SeededContext {
	const loaded = taskContext(sources, task)
	const references = capItems(loaded.relevantExistingCode, TASK_CODE_REFERENCE_CAP)
	const interfaces = capItems(loaded.sharedInterfaceContracts, TASK_INTERFACE_CAP)
	const scouts = capItems(sources.scoutFindings.filter((finding) => findingMatchesTask(finding, task)), TASK_SCOUT_CAP)
	const styleGuidance = taskStyleGuidance(sources, task)
	const ordinaryWarnings = [...loaded.warnings, ...sources.commonWarnings]
	return {
		relevant_existing_code: references,
		shared_interface_contracts: interfaces,
		scout_findings: scouts,
		style_guidance: styleGuidance,
		...(sources.repoPrimer ? { repo_primer: sources.repoPrimer } : {}),
		warnings: warningItems(ordinaryWarnings, truncatedFields(references, interfaces, scouts, styleGuidance, sources.repoPrimer)),
	}
}

export function sliceReviewerSeededContext(
	sources: LoadedWaveContextSources,
	activeTasks: readonly TaskPlan[],
): SeededContext {
	const loadedTasks = activeTasks.map((task) => taskContext(sources, task))
	const references = capItems(
		dedupeBy(loadedTasks.flatMap((loaded) => loaded.relevantExistingCode), referenceKey),
		REVIEW_CODE_REFERENCE_CAP,
	)
	const interfaces = capItems(
		dedupeBy(loadedTasks.flatMap((loaded) => loaded.sharedInterfaceContracts), interfaceKey),
		REVIEW_INTERFACE_CAP,
	)
	const scouts = capItems(
		dedupeBy(
			activeTasks.flatMap((task) => sources.scoutFindings.filter((finding) => findingMatchesTask(finding, task))),
			(finding) => finding.id,
		),
		REVIEW_SCOUT_CAP,
	)
	const ordinaryWarnings = [...loadedTasks.flatMap((loaded) => loaded.warnings), ...sources.commonWarnings]
	return {
		relevant_existing_code: references,
		shared_interface_contracts: interfaces,
		scout_findings: scouts,
		style_guidance: sources.styleGuidance,
		...(sources.repoPrimer ? { repo_primer: sources.repoPrimer } : {}),
		warnings: warningItems(ordinaryWarnings, truncatedFields(references, interfaces, scouts, sources.styleGuidance, sources.repoPrimer)),
	}
}
