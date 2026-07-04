import {loadContextEntries} from './context-loader'
import {withDiagnosticTiming} from './diagnostics'
import type {
	ContextArtifact,
	ContextEntry,
	ContextEntryResult,
	ContextNoteKind,
	ContextNoteStatus,
	ContextReadResult,
	ContextSearchMode,
	ContextSearchResult,
	ReadContextInput,
	SearchContextInput,
} from './context-types'

export type {
	ContextArtifact,
	ContextEntryResult,
	ContextNoteKind,
	ContextNoteStatus,
	ContextReadResult,
	ContextSearchMode,
	ContextSearchResult,
	ReadContextInput,
	SearchContextInput,
} from './context-types'

const DEFAULT_ARTIFACTS: ContextArtifact[] = ['notes', 'decisions', 'risks']
const READ_ARTIFACTS: ContextArtifact[] = ['notes', 'decisions', 'risks', 'roadmap', 'plan']
const DEFAULT_MAX_RESULTS = 20
const DEFAULT_SNIPPET_CHARS = 240
const DEFAULT_MAX_BODY_CHARS = 4000

interface Matcher {
	matches(entry: ContextEntry): boolean;

	indexIn(text: string): number;
}

function positiveNumber(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value < 0) return fallback
	return Math.floor(value)
}

function metadataText(metadata: Record<string, unknown>): string {
	return Object.entries(metadata)
	.filter(([, value]) => value !== undefined)
	.map(([key, value]) => `${key}: ${String(value)}`)
	.join('\n')
}

function searchableText(entry: ContextEntry): string {
	return [entry.title, entry.body, entry.path, metadataText(entry.metadata)].join('\n')
}

function plainMatcher(query: string, caseSensitive: boolean): Matcher {
	const needle = caseSensitive ? query : query.toLowerCase()
	return {
		matches(entry) {
			return this.indexIn(searchableText(entry)) !== -1
		},
		indexIn(text) {
			const haystack = caseSensitive ? text : text.toLowerCase()
			return haystack.indexOf(needle)
		},
	}
}

function regexMatcher(query: string, caseSensitive: boolean): Matcher {
	const pattern = new RegExp(query, caseSensitive ? '' : 'i')
	return {
		matches(entry) {
			return this.indexIn(searchableText(entry)) !== -1
		},
		indexIn(text) {
			return pattern.exec(text)?.index ?? -1
		},
	}
}

function createMatcher(input: SearchContextInput): Matcher | undefined {
	const query = input.query?.trim()
	if (!query) return undefined
	return input.useRegex
		? regexMatcher(query, input.caseSensitive ?? false)
		: plainMatcher(query, input.caseSensitive ?? false)
}

function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return {text, truncated: false}
	return {text: text.slice(0, maxChars), truncated: true}
}

function snippetFor(entry: ContextEntry, matcher: Matcher | undefined, maxChars: number): { text: string; truncated: boolean } {
	const source = `${entry.title}\n${entry.body}`.trim()
	if (source.length <= maxChars) return {text: source, truncated: false}
	const matchIndex = matcher?.indexIn(source) ?? -1
	const start = matchIndex === -1 ? 0 : Math.max(0, matchIndex - Math.floor(maxChars / 2))
	const end = Math.min(source.length, start + maxChars)
	return {
		text: `${start > 0 ? '...' : ''}${source.slice(start, end)}${end < source.length ? '...' : ''}`,
		truncated: true,
	}
}

function resultFor(
	entry: ContextEntry,
	matcher: Matcher | undefined,
	snippetChars: number,
	includeBody: boolean,
	maxBodyChars: number,
): ContextEntryResult {
	const snippet = snippetFor(entry, matcher, snippetChars)
	const result: ContextEntryResult = {
		id: entry.id,
		artifact: entry.artifact,
		path: entry.path,
		...(entry.milestoneId ? {milestoneId: entry.milestoneId} : {}),
		title: entry.title,
		metadata: entry.metadata,
		snippet: snippet.text,
		snippetTruncated: snippet.truncated,
	}
	if (includeBody) {
		const body = capText(entry.body, maxBodyChars)
		result.body = body.text
		result.bodyTruncated = body.truncated
	}
	return result
}

function idResultFor(entry: ContextEntry): ContextEntryResult {
	return {
		id: entry.id,
		artifact: entry.artifact,
		path: entry.path,
		...(entry.milestoneId ? {milestoneId: entry.milestoneId} : {}),
		title: entry.title,
		metadata: entry.metadata,
		snippet: '',
		snippetTruncated: false,
	}
}

function uniqueArtifacts(artifacts: ContextArtifact[] | undefined): ContextArtifact[] {
	if (!artifacts || artifacts.length === 0) return DEFAULT_ARTIFACTS
	return Array.from(new Set(artifacts))
}

function matchesFilters(entry: ContextEntry, input: SearchContextInput): boolean {
	if (input.milestoneIds && (!entry.milestoneId || !input.milestoneIds.includes(entry.milestoneId))) return false
	if (entry.artifact !== 'notes') return true
	if (input.kinds && !input.kinds.includes(entry.metadata.kind as ContextNoteKind)) return false
	if (input.statuses && !input.statuses.includes(entry.metadata.status as ContextNoteStatus)) return false
	if (input.blocking !== undefined && entry.metadata.blocking !== input.blocking) return false
	if (input.waveId !== undefined && entry.metadata.wave_id !== input.waveId) return false
	if (input.taskId !== undefined && entry.metadata.task_id !== input.taskId) return false
	if (input.taskIds !== undefined && (typeof entry.metadata.task_id !== 'string' || !input.taskIds.includes(entry.metadata.task_id))) return false
	if (input.workerId !== undefined && entry.metadata.worker_id !== input.workerId) return false
	return true
}

function sortEntries(entries: ContextEntry[]): ContextEntry[] {
	return [...entries].sort((left, right) => {
		if (left.artifact === 'notes' && right.artifact === 'notes') {
			const byTime = String(right.metadata.at ?? '').localeCompare(String(left.metadata.at ?? ''))
			return byTime || left.order - right.order
		}
		if (left.artifact === 'notes') return -1
		if (right.artifact === 'notes') return 1
		return left.order - right.order
	})
}

export async function searchContext(cwd: string, input: SearchContextInput): Promise<ContextSearchResult> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'context.searchContext',
		cwd,
		slowMs: 250,
	}, async () => {
		const mode: ContextSearchMode = input.mode ?? 'snippets'
		const matcher = createMatcher(input)
		const snippetChars = positiveNumber(input.snippetChars, DEFAULT_SNIPPET_CHARS)
		const maxBodyChars = positiveNumber(input.maxBodyChars, DEFAULT_MAX_BODY_CHARS)
		const maxResults = positiveNumber(input.maxResults, DEFAULT_MAX_RESULTS)
		const {roadmapId, entries} = await loadContextEntries(cwd, uniqueArtifacts(input.artifacts))
		const filtered = sortEntries(
			entries.filter((entry) => matchesFilters(entry, input) && (!matcher || matcher.matches(entry))),
		)
		// count mode reports the full match total but builds no result entries.
		if (mode === 'count') {
			return {
				...(roadmapId ? {roadmapId} : {}),
				total: filtered.length,
				returned: 0,
				results: [],
			}
		}
		const returned = filtered.slice(0, maxResults)
		// bodies mode always includes bodies; snippets mode honors legacy includeBodies for compatibility.
		const includeBody = mode === 'bodies' || (mode === 'snippets' && (input.includeBodies ?? false))
		return {
			...(roadmapId ? {roadmapId} : {}),
			total: filtered.length,
			returned: returned.length,
			results: returned.map((entry) =>
				mode === 'ids'
					? idResultFor(entry)
					: resultFor(entry, matcher, snippetChars, includeBody, maxBodyChars),
			),
		}
	})
}

export async function readContext(cwd: string, input: ReadContextInput): Promise<ContextReadResult> {
	return await withDiagnosticTiming({
		component: 'core',
		operation: 'context.readContext',
		cwd,
		slowMs: 250,
	}, async () => {
		const maxBodyChars = positiveNumber(input.maxBodyChars, DEFAULT_MAX_BODY_CHARS)
		const {roadmapId, entries} = await loadContextEntries(cwd, READ_ARTIFACTS)
		const byId = new Map(entries.map((entry) => [entry.id, entry]))
		const results: ContextEntryResult[] = []
		const missingIds: string[] = []
		for (const id of input.ids) {
			const entry = byId.get(id)
			if (!entry) missingIds.push(id)
			else results.push(resultFor(entry, undefined, DEFAULT_SNIPPET_CHARS, true, maxBodyChars))
		}
		return {
			...(roadmapId ? {roadmapId} : {}),
			requested: input.ids.length,
			found: results.length,
			results,
			missingIds,
		}
	})
}
