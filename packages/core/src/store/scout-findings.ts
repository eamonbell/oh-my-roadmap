import * as crypto from 'node:crypto'
import {appendTextAtomic, fileExists, readText} from '../files'
import {roadmapScoutFindingsPath} from '../paths'
import type {ScoutFinding} from '../types'
import {loadState} from './persistence'
import {nowIso} from './shared'

const DEFAULT_LIMIT = 20

export interface RecordScoutFindingInput {
	subsystem: string;
	milestoneIds?: string[];
	sourcePaths?: string[];
	summary: string;
	findings?: string[];
	createdBy?: string;
	stale?: boolean;
}

export interface ListScoutFindingsInput {
	roadmapId?: string;
	subsystem?: string;
	milestoneId?: string;
	sourcePath?: string;
	includeStale?: boolean;
	limit?: number;
}

export interface ListScoutFindingsResult {
	roadmapId?: string;
	total: number;
	returned: number;
	findings: ScoutFinding[];
}

function scoutFindingId(): string {
	return `scout_${crypto.randomUUID().slice(0, 8)}`
}

async function activeRoadmapId(cwd: string): Promise<string | undefined> {
	const state = await loadState(cwd)
	return state.roadmap?.roadmap_id ?? state.active?.roadmap_id
}

function parseFindings(text: string): ScoutFinding[] {
	const findings: ScoutFinding[] = []
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue
		try {
			findings.push(JSON.parse(line) as ScoutFinding)
		} catch {
			// Skip malformed lines rather than failing the whole read.
		}
	}
	return findings
}

export async function recordScoutFinding(cwd: string, input: RecordScoutFindingInput): Promise<ScoutFinding> {
	const roadmapId = await activeRoadmapId(cwd)
	if (!roadmapId) throw new Error('No active roadmap to record a scout finding against')
	const finding: ScoutFinding = {
		id: scoutFindingId(),
		roadmap_id: roadmapId,
		subsystem: input.subsystem,
		milestone_ids: input.milestoneIds ?? [],
		source_paths: input.sourcePaths ?? [],
		summary: input.summary,
		findings: input.findings ?? [],
		created_by: input.createdBy ?? 'orchestrator',
		created_at: nowIso(),
		...(input.stale ? {stale: true} : {}),
	}
	await appendTextAtomic(roadmapScoutFindingsPath(cwd, roadmapId), `${JSON.stringify(finding)}\n`)
	return finding
}

export async function listScoutFindings(
	cwd: string,
	input: ListScoutFindingsInput = {},
): Promise<ListScoutFindingsResult> {
	const roadmapId = input.roadmapId ?? (await activeRoadmapId(cwd))
	if (!roadmapId) return {total: 0, returned: 0, findings: []}
	const filePath = roadmapScoutFindingsPath(cwd, roadmapId)
	if (!(await fileExists(filePath))) return {roadmapId, total: 0, returned: 0, findings: []}
	const all = parseFindings(await readText(filePath))
	const filtered = all.filter((finding) => {
		if (input.subsystem !== undefined && finding.subsystem !== input.subsystem) return false
		if (input.milestoneId !== undefined && !finding.milestone_ids.includes(input.milestoneId)) return false
		if (input.sourcePath !== undefined && !finding.source_paths.includes(input.sourcePath)) return false
		if (!input.includeStale && finding.stale === true) return false
		return true
	})
	const limit = input.limit !== undefined && Number.isFinite(input.limit) && input.limit > 0
		? Math.floor(input.limit)
		: DEFAULT_LIMIT
	const returned = filtered.slice(0, limit)
	return {roadmapId, total: filtered.length, returned: returned.length, findings: returned}
}
