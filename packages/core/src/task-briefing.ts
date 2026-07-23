import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export type TaskBriefingResponseFormat = 'concise' | 'detailed'

export interface TaskBriefingInput {
	ownedPaths: readonly string[];
	dependencyPaths?: readonly string[];
	responseFormat?: TaskBriefingResponseFormat;
}

export interface TaskBriefingFileEntry {
	path: string;
	role: 'owned' | 'dependency';
	size_bytes: number;
	excerpt: string;
	excerpt_bytes: number;
	excerpt_truncated: boolean;
}

export interface TaskBriefingSkippedEntry {
	path: string;
	role: 'owned' | 'dependency';
	reason: 'outside_repo' | 'missing' | 'not_a_file';
}

export interface TaskBriefingImportEdge {
	from: string;
	to: string;
}

export interface TaskBriefing {
	schema_version: 1;
	response_format: TaskBriefingResponseFormat;
	files: TaskBriefingFileEntry[];
	skipped: TaskBriefingSkippedEntry[];
	import_edges: TaskBriefingImportEdge[];
	truncated_files: number;
	truncated_edges: number;
	lsp_note: string;
}

const LSP_NOTE = 'Symbol outlines and diagnostics: call `xd://lsp` yourself on the files you touch — this briefing does not include them.'

// Byte caps for per-file head excerpts and for the overall briefing payload,
// mirroring the concise/detailed split and the render-cap idiom used by
// repo-primer.ts and wave-orchestration/context-seeding.ts.
const EXCERPT_BYTE_CAP: Record<TaskBriefingResponseFormat, number> = {
	concise: 1024,
	detailed: 4096,
}
const FILE_COUNT_CAP: Record<TaskBriefingResponseFormat, number> = {
	concise: 20,
	detailed: 60,
}
const EDGE_COUNT_CAP: Record<TaskBriefingResponseFormat, number> = {
	concise: 40,
	detailed: 120,
}
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const INDEX_BASENAMES = RESOLVE_EXTENSIONS.map((ext) => `index${ext}`)

// Matches import/export/require specifiers in JS/TS source: `import ... from '...'`,
// bare `import '...'`, `import('...')`, `require('...')`, and `export ... from '...'`.
const IMPORT_SPECIFIER_PATTERN = /(?:import|export)(?:[^'"`;]*?)from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g

function inside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function utf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return ''
	const bytes = Buffer.from(text)
	if (bytes.byteLength <= maxBytes) return text
	let end = maxBytes
	while (end > 0) {
		const result = bytes.subarray(0, end).toString('utf8')
		if (!result.endsWith('�')) return result
		end--
	}
	return ''
}

interface ConfinedFile {
	real: string;
	relative: string;
	size: number;
	contents: string;
}

async function confinedReadFile(
	cwd: string,
	rootReal: string,
	requestedPath: string,
): Promise<ConfinedFile | { skipped: TaskBriefingSkippedEntry['reason'] }> {
	let real: string
	try {
		real = await fs.realpath(path.resolve(cwd, requestedPath))
	} catch {
		return { skipped: 'missing' }
	}
	if (!inside(rootReal, real)) return { skipped: 'outside_repo' }
	let stat: Awaited<ReturnType<typeof fs.stat>>
	try {
		stat = await fs.stat(real)
	} catch {
		return { skipped: 'missing' }
	}
	if (!stat.isFile()) return { skipped: 'not_a_file' }
	const contents = await fs.readFile(real, 'utf8')
	return { real, relative: path.relative(rootReal, real).split(path.sep).join('/'), size: stat.size, contents }
}

async function resolveImportTarget(rootReal: string, fromReal: string, specifier: string): Promise<string | undefined> {
	if (!specifier.startsWith('.')) return undefined
	const base = path.resolve(path.dirname(fromReal), specifier)
	const candidates: string[] = [base, ...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`), ...INDEX_BASENAMES.map((name) => path.join(base, name))]
	for (const candidate of candidates) {
		try {
			const real = await fs.realpath(candidate)
			if (!inside(rootReal, real)) continue
			const stat = await fs.stat(real)
			if (stat.isFile()) return path.relative(rootReal, real).split(path.sep).join('/')
		} catch {
			continue
		}
	}
	return undefined
}

function extractSpecifiers(source: string): string[] {
	const specifiers: string[] = []
	IMPORT_SPECIFIER_PATTERN.lastIndex = 0
	let match: RegExpExecArray | null
	while ((match = IMPORT_SPECIFIER_PATTERN.exec(source)) !== null) {
		const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]
		if (specifier) specifiers.push(specifier)
	}
	return specifiers
}

/**
 * Assembles a server-side, capped context pack for a worker's owned and
 * dependency files: file sizes, truncated head excerpts, and a one-hop
 * import graph (relative specifiers resolved in-repo; bare/external
 * specifiers ignored). Every requested path is confined to the repository
 * root via fs.realpath + prefix check before being read; paths that escape
 * the repo, don't exist, or aren't regular files are reported in `skipped`
 * rather than throwing. Symbol outlines/diagnostics are deliberately out of
 * scope — see `lsp_note`.
 */
export async function buildTaskBriefing(cwd: string, input: TaskBriefingInput): Promise<TaskBriefing> {
	const responseFormat: TaskBriefingResponseFormat = input.responseFormat ?? 'concise'
	const rootReal = await fs.realpath(cwd)
	const excerptCap = EXCERPT_BYTE_CAP[responseFormat]
	const fileCap = FILE_COUNT_CAP[responseFormat]
	const edgeCap = EDGE_COUNT_CAP[responseFormat]

	const requested: Array<{ path: string; role: 'owned' | 'dependency' }> = [
		...input.ownedPaths.map((path_) => ({ path: path_, role: 'owned' as const })),
		...(input.dependencyPaths ?? []).map((path_) => ({ path: path_, role: 'dependency' as const })),
	]

	const files: TaskBriefingFileEntry[] = []
	const skipped: TaskBriefingSkippedEntry[] = []
	const resolvedByRelative = new Map<string, { real: string; contents: string }>()
	let truncatedFiles = 0

	for (const item of requested) {
		const outcome = await confinedReadFile(cwd, rootReal, item.path)
		if ('skipped' in outcome) {
			skipped.push({ path: item.path, role: item.role, reason: outcome.skipped })
			continue
		}
		resolvedByRelative.set(outcome.relative, { real: outcome.real, contents: outcome.contents })
		if (files.length >= fileCap) {
			truncatedFiles += 1
			continue
		}
		const excerpt = utf8Prefix(outcome.contents, excerptCap)
		const excerptBytes = Buffer.byteLength(excerpt)
		files.push({
			path: outcome.relative,
			role: item.role,
			size_bytes: outcome.size,
			excerpt,
			excerpt_bytes: excerptBytes,
			excerpt_truncated: excerptBytes < Buffer.byteLength(outcome.contents),
		})
	}

	const importEdges: TaskBriefingImportEdge[] = []
	let truncatedEdges = 0
	for (const [relative, { real, contents }] of resolvedByRelative) {
		const specifiers = extractSpecifiers(contents)
		for (const specifier of specifiers) {
			const target = await resolveImportTarget(rootReal, real, specifier)
			if (!target || target === relative) continue
			if (importEdges.length >= edgeCap) {
				truncatedEdges += 1
				continue
			}
			importEdges.push({ from: relative, to: target })
		}
	}

	return {
		schema_version: 1,
		response_format: responseFormat,
		files,
		skipped,
		import_edges: importEdges,
		truncated_files: truncatedFiles,
		truncated_edges: truncatedEdges,
		lsp_note: LSP_NOTE,
	}
}
