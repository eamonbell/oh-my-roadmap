import * as crypto from 'node:crypto'
import {activePointerPath, roadmapEventsPath} from './paths'
import {appendText, fileExists, readText, readYamlFile} from './files'
import {withStoreWriteLock} from './lock'
import type {ActivePointer, RoadmapEvent} from './types'

const DEFAULT_EVENT_LIMIT = 100
const MAX_EVENT_LIMIT = 500

export type RoadmapEventInput = Omit<RoadmapEvent, 'id' | 'schema_version' | 'at'> & {
	id?: string;
	at?: string;
};

export interface ReadRoadmapEventsInput {
	roadmapId?: string;
	milestoneId?: string;
	changeRequestId?: string;
	taskId?: string;
	waveId?: string;
	blockerId?: string;
	type?: string[];
	since?: string;
	limit?: number;
}

export interface ReadRoadmapEventsResult {
	roadmapId?: string;
	total: number;
	returned: number;
	events: RoadmapEvent[];
}

export function roadmapEventId(): string {
	return `evt_${crypto.randomUUID()}`
}

function eventLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_EVENT_LIMIT
	if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_EVENT_LIMIT
	return Math.min(Math.floor(limit), MAX_EVENT_LIMIT)
}

async function activeRoadmapId(cwd: string): Promise<string | undefined> {
	const filePath = activePointerPath(cwd)
	if (!(await fileExists(filePath))) return undefined
	return (await readYamlFile<ActivePointer>(filePath)).roadmap_id
}

function matchesScope(event: RoadmapEvent, input: ReadRoadmapEventsInput): boolean {
	return (
		(input.milestoneId === undefined || event.scope.milestone_id === input.milestoneId) &&
		(input.changeRequestId === undefined || event.scope.change_request_id === input.changeRequestId) &&
		(input.taskId === undefined || event.scope.task_id === input.taskId) &&
		(input.waveId === undefined || event.scope.wave_id === input.waveId) &&
		(input.blockerId === undefined || event.scope.blocker_id === input.blockerId)
	)
}

function parseEvents(text: string): RoadmapEvent[] {
	return text
	.split('\n')
	.filter((line) => line.trim() !== '')
	.map((line) => JSON.parse(line) as RoadmapEvent)
}

export async function appendRoadmapEvent(cwd: string, input: RoadmapEventInput): Promise<RoadmapEvent> {
	return await withStoreWriteLock(cwd, async () => {
		const event: RoadmapEvent = {
			...input,
			id: input.id ?? roadmapEventId(),
			schema_version: 1,
			at: input.at ?? new Date().toISOString(),
		}
		await appendText(roadmapEventsPath(cwd, event.scope.roadmap_id), `${JSON.stringify(event)}\n`)
		return event
	})
}

export async function readRoadmapEvents(
	cwd: string,
	input: ReadRoadmapEventsInput = {},
): Promise<ReadRoadmapEventsResult> {
	const roadmapId = input.roadmapId ?? await activeRoadmapId(cwd)
	if (!roadmapId) return {total: 0, returned: 0, events: []}

	const filePath = roadmapEventsPath(cwd, roadmapId)
	if (!(await fileExists(filePath))) return {roadmapId, total: 0, returned: 0, events: []}

	const sinceTime = input.since === undefined ? undefined : Date.parse(input.since)
	if (input.since !== undefined && !Number.isFinite(sinceTime)) {
		throw new Error('since must be a valid date string')
	}

	const types = new Set(input.type ?? [])
	const filtered = parseEvents(await readText(filePath)).filter((event) => {
		if (types.size > 0 && !types.has(event.type)) return false
		if (sinceTime !== undefined && Date.parse(event.at) < sinceTime) return false
		return matchesScope(event, input)
	})
	const events = filtered.slice(-eventLimit(input.limit))
	return {roadmapId, total: filtered.length, returned: events.length, events}
}
