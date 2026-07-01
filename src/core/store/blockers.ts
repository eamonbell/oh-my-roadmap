import {appendRoadmapEvent} from '../events'
import {appendText} from '../files'
import {serializeYaml} from '../frontmatter'
import {withStoreWriteLock} from '../lock'
import {decisionsPath, milestoneNotesPath} from '../paths'
import type {LoadedState, RoadmapBlocker, RoadmapEventScope} from '../types'
import type {
	AmendmentInput,
	AppendNoteInput,
	DeferBlockerInput,
	ListBlockersInput,
	ListBlockersResult,
	OpenBlockerInput,
	ResolveBlockerInput
} from './contract'
import {appendBlockerEvent} from './events'
import {loadRoadmapBlockers, loadState, storeTiming, withStoreMutationRollback, writeRoadmapBlockers} from './persistence'
import {nowIso, roadmapBlockerId} from './shared'

export function activeBlockerScope(
	loaded: LoadedState,
	input: OpenBlockerInput,
): Pick<RoadmapBlocker, 'roadmap_id' | 'milestone_id' | 'change_request_id' | 'task_id' | 'wave_id'> {
	const roadmapId = input.roadmapId ?? loaded.active?.roadmap_id
	if (!roadmapId) throw new Error('open_blocker requires an active roadmap or roadmapId')
	const canUseActiveScope = input.roadmapId === undefined || input.roadmapId === loaded.active?.roadmap_id
	const milestoneId = input.milestoneId ?? (canUseActiveScope ? loaded.active?.milestone_id : undefined)
	const changeRequestId = input.changeRequestId ?? (canUseActiveScope ? loaded.active?.change_request_id : undefined)
	return {
		roadmap_id: roadmapId,
		...(milestoneId ? {milestone_id: milestoneId} : {}),
		...(changeRequestId ? {change_request_id: changeRequestId} : {}),
		...(input.taskId ? {task_id: input.taskId} : {}),
		...(input.waveId ? {wave_id: input.waveId} : {}),
	}
}

export function matchesBlockerFilters(blocker: RoadmapBlocker, input: ListBlockersInput): boolean {
	return (
		(input.milestoneId === undefined || blocker.milestone_id === input.milestoneId) &&
		(input.changeRequestId === undefined || blocker.change_request_id === input.changeRequestId) &&
		(input.taskId === undefined || blocker.task_id === input.taskId) &&
		(input.waveId === undefined || blocker.wave_id === input.waveId) &&
		(input.status === undefined || blocker.status === input.status) &&
		(input.severity === undefined || blocker.severity === input.severity)
	)
}

export function resultLimit(limit: number | undefined, total: number): number {
	if (limit === undefined) return total
	if (!Number.isFinite(limit) || limit < 0) return total
	return Math.floor(limit)
}

export async function listBlockersImpl(cwd: string, input: ListBlockersInput = {}): Promise<ListBlockersResult> {
	const loaded = await loadState(cwd)
	const roadmapId = input.roadmapId ?? loaded.active?.roadmap_id
	if (!roadmapId) return {total: 0, returned: 0, blockers: []}
	const filtered = (await loadRoadmapBlockers(cwd, roadmapId)).filter((blocker) => matchesBlockerFilters(blocker, input))
	const limit = resultLimit(input.limit, filtered.length)
	const blockers = filtered.slice(0, limit)
	return {
		roadmapId,
		total: filtered.length,
		returned: blockers.length,
		blockers,
	}
}

export async function openBlockerImpl(cwd: string, input: OpenBlockerInput): Promise<RoadmapBlocker> {
	return await withStoreWriteLock(cwd, async () => {
		const loaded = await loadState(cwd)
		const scope = activeBlockerScope(loaded, input)
		const actor = input.createdBy?.trim() || 'user'

		return await withStoreMutationRollback(cwd, scope.roadmap_id, async () => {
			const blocker: RoadmapBlocker = {
				id: roadmapBlockerId(),
				...scope,
				severity: input.severity ?? 'blocking',
				status: 'open',
				title: input.title,
				description: input.description,
				created_by: actor,
				created_at: nowIso(),
				...(input.notePath ? {note_path: input.notePath} : {}),
			}
			const blockers = await loadRoadmapBlockers(cwd, blocker.roadmap_id)
			await writeRoadmapBlockers(cwd, blocker.roadmap_id, [...blockers, blocker])
			await appendBlockerEvent(cwd, 'blocker.opened', actor, blocker, undefined, {
				description: blocker.description,
			})
			return blocker
		})
	})
}

export function findBlocker(blockers: RoadmapBlocker[], blockerId: string): { blocker: RoadmapBlocker; index: number } {
	const index = blockers.findIndex((candidate) => candidate.id === blockerId)
	if (index === -1) throw new Error(`Unknown blocker: ${blockerId}`)
	const blocker = blockers[index]
	if (!blocker) throw new Error(`Unknown blocker: ${blockerId}`)
	return {blocker, index}
}

export async function resolveBlockerImpl(cwd: string, input: ResolveBlockerInput): Promise<RoadmapBlocker> {
	return await withStoreWriteLock(cwd, async () => {
		const loaded = await loadState(cwd)
		const roadmapId = input.roadmapId ?? loaded.active?.roadmap_id
		if (!roadmapId) throw new Error('resolve_blocker requires an active roadmap or roadmapId')
		const actor = input.resolvedBy?.trim() || 'user'

		return await withStoreMutationRollback(cwd, roadmapId, async () => {
			const blockers = await loadRoadmapBlockers(cwd, roadmapId)
			const {blocker, index} = findBlocker(blockers, input.blockerId)
			if (blocker.status !== 'open') throw new Error(`Blocker is not open: ${input.blockerId}`)
			const updated: RoadmapBlocker = {
				...blocker,
				status: 'resolved',
				resolved_by: actor,
				resolved_at: nowIso(),
				resolution: input.resolution,
			}
			blockers[index] = updated
			await writeRoadmapBlockers(cwd, roadmapId, blockers)
			await appendBlockerEvent(cwd, 'blocker.resolved', actor, updated, blocker, {
				resolution: input.resolution,
			})
			return updated
		})
	})
}

export async function deferBlockerImpl(cwd: string, input: DeferBlockerInput): Promise<RoadmapBlocker> {
	return await withStoreWriteLock(cwd, async () => {
		const loaded = await loadState(cwd)
		const roadmapId = input.roadmapId ?? loaded.active?.roadmap_id
		if (!roadmapId) throw new Error('defer_blocker requires an active roadmap or roadmapId')
		const actor = input.deferredBy?.trim() || 'user'

		return await withStoreMutationRollback(cwd, roadmapId, async () => {
			const blockers = await loadRoadmapBlockers(cwd, roadmapId)
			const {blocker, index} = findBlocker(blockers, input.blockerId)
			if (blocker.status !== 'open') throw new Error(`Blocker is not open: ${input.blockerId}`)
			const updated: RoadmapBlocker = {
				...blocker,
				status: 'deferred',
				deferred_by: actor,
				deferred_at: nowIso(),
				defer_reason: input.deferReason,
			}
			blockers[index] = updated
			await writeRoadmapBlockers(cwd, roadmapId, blockers)
			await appendBlockerEvent(cwd, 'blocker.deferred', actor, updated, blocker, {
				defer_reason: input.deferReason,
			})
			return updated
		})
	})
}

export async function appendNoteEntry(
	cwd: string,
	input: AppendNoteInput,
	blockerId?: string,
): Promise<{ filePath: string; scope: RoadmapEventScope }> {
	const loaded = await loadState(cwd)
	const roadmapId = input.roadmapId ?? loaded.active?.roadmap_id
	const milestoneId = input.milestoneId ?? loaded.active?.milestone_id
	if (!roadmapId || !milestoneId) {
		throw new Error('append_note requires an active roadmap and milestone')
	}
	const changeRequestId =
		roadmapId === loaded.active?.roadmap_id && milestoneId === loaded.active?.milestone_id
			? loaded.active.change_request_id
			: undefined

	const metadata = {
		kind: input.kind,
		roadmap_id: roadmapId,
		milestone_id: milestoneId,
		change_request_id: changeRequestId,
		wave_id: input.waveId,
		task_id: input.taskId,
		worker_id: input.workerId,
		blocking: input.blocking ?? false,
		...(blockerId ? {blocker_id: blockerId} : {}),
		status: input.status ?? 'open',
		at: nowIso(),
	}
	const entry = `\n---\n${serializeYaml(metadata).trimEnd()}\n---\n\n## ${input.title}\n\n${input.body.trimEnd()}\n`
	const filePath = milestoneNotesPath(cwd, roadmapId, milestoneId)
	await appendText(filePath, entry)
	const scope: RoadmapEventScope = {roadmap_id: roadmapId, milestone_id: milestoneId}
	if (changeRequestId) scope.change_request_id = changeRequestId
	if (input.waveId) scope.wave_id = input.waveId
	if (input.taskId) scope.task_id = input.taskId
	if (blockerId) scope.blocker_id = blockerId
	return {filePath, scope}
}

export async function appendNoteImpl(cwd: string, input: AppendNoteInput): Promise<string> {
	return await withStoreWriteLock(cwd, async () => {
		const loaded = await loadState(cwd)
		const roadmapId = input.roadmapId ?? loaded.active?.roadmap_id
		if (!roadmapId) throw new Error('append_note requires an active roadmap and milestone')

		return await withStoreMutationRollback(cwd, roadmapId, async () => {
			const blockerId = input.blocking ? roadmapBlockerId() : undefined
			const {filePath, scope} = await appendNoteEntry(cwd, input, blockerId)
			if (blockerId) {
				const actor = input.workerId?.trim() || input.kind
				const status = input.status ?? 'open'
				const blocker: RoadmapBlocker = {
					id: blockerId,
					roadmap_id: scope.roadmap_id,
					...(scope.milestone_id ? {milestone_id: scope.milestone_id} : {}),
					...(scope.change_request_id ? {change_request_id: scope.change_request_id} : {}),
					...(scope.task_id ? {task_id: scope.task_id} : {}),
					...(scope.wave_id ? {wave_id: scope.wave_id} : {}),
					severity: 'blocking',
					status,
					title: input.title,
					description: input.body,
					created_by: actor,
					created_at: nowIso(),
					note_path: filePath,
					...(status === 'resolved' ? {resolved_by: actor, resolved_at: nowIso(), resolution: 'Recorded as resolved.'} : {}),
					...(status === 'deferred' ? {deferred_by: actor, deferred_at: nowIso(), defer_reason: 'Recorded as deferred.'} : {}),
				}
				const blockers = await loadRoadmapBlockers(cwd, roadmapId)
				await writeRoadmapBlockers(cwd, roadmapId, [...blockers, blocker])
				await appendBlockerEvent(cwd, 'blocker.opened', actor, blocker, undefined, {
					description: blocker.description,
				})
			}
			await appendRoadmapEvent(cwd, {
				actor: input.workerId?.trim() || input.kind,
				type: 'note.appended',
				scope,
				summary: `Appended ${input.kind} note: ${input.title}.`,
				details: {
					kind: input.kind,
					blocking: input.blocking ?? false,
					status: input.status ?? 'open',
					...(blockerId ? {blocker_id: blockerId} : {}),
				},
			})
			return filePath
		})
	})
}

export async function amendImpl(cwd: string, input: AmendmentInput): Promise<string> {
	return await withStoreWriteLock(cwd, async () => {
		const loaded = await loadState(cwd)
		if (!loaded.active?.roadmap_id || !loaded.roadmap) throw new Error('No active roadmap')
		const active = loaded.active
		if (input.material && !input.approvedBy) {
			throw new Error('Material amendments require approval')
		}

		const approvedLine = input.approvedBy
			? `Approved by ${input.approvedBy}: ${input.approvalSummary ?? 'No summary provided'}`
			: 'Clerical amendment; approval not required.'
		const entry = `\n## ${input.title}\n\n- Scope: ${input.scope}\n- Material: ${input.material ? 'yes' : 'no'}\n- ${approvedLine}\n- At: ${nowIso()}\n\n${input.body.trimEnd()}\n`

		return await withStoreMutationRollback(cwd, active.roadmap_id, async () => {
			if (input.scope === 'roadmap') {
				await appendText(decisionsPath(cwd, active.roadmap_id), entry)
				await appendRoadmapEvent(cwd, {
					actor: input.approvedBy?.trim() || 'user',
					type: 'amendment.recorded',
					scope: {roadmap_id: active.roadmap_id},
					summary: `Recorded ${input.scope} amendment: ${input.title}.`,
					details: {
						scope: input.scope,
						material: input.material,
					},
				})
				return decisionsPath(cwd, active.roadmap_id)
			}

			const milestoneId = active.milestone_id
			if (!milestoneId) throw new Error('Milestone amendment requires an active milestone')
			const {filePath, scope} = await appendNoteEntry(cwd, {
				kind: 'decision',
				roadmapId: active.roadmap_id,
				milestoneId,
				title: input.title,
				body: entry,
				blocking: false,
				status: 'resolved',
			})
			await appendRoadmapEvent(cwd, {
				actor: input.approvedBy?.trim() || 'user',
				type: 'amendment.recorded',
				scope,
				summary: `Recorded ${input.scope} amendment: ${input.title}.`,
				details: {
					scope: input.scope,
					material: input.material,
				},
			})
			return filePath
		})
	})
}

export async function listBlockers(cwd: string, input: ListBlockersInput = {}): Promise<ListBlockersResult> {
	return await storeTiming('listBlockers', cwd, {
		roadmap_id: input.roadmapId,
		milestone_id: input.milestoneId,
		change_request_id: input.changeRequestId,
		task_id: input.taskId,
		wave_id: input.waveId,
		status: input.status,
		severity: input.severity,
	}, async () => await listBlockersImpl(cwd, input))
}

export async function openBlocker(cwd: string, input: OpenBlockerInput): Promise<RoadmapBlocker> {
	return await storeTiming('openBlocker', cwd, {
		roadmap_id: input.roadmapId,
		milestone_id: input.milestoneId,
		change_request_id: input.changeRequestId,
		task_id: input.taskId,
		wave_id: input.waveId,
		severity: input.severity ?? 'blocking',
	}, async () => await openBlockerImpl(cwd, input))
}

export async function resolveBlocker(cwd: string, input: ResolveBlockerInput): Promise<RoadmapBlocker> {
	return await storeTiming('resolveBlocker', cwd, {
		roadmap_id: input.roadmapId,
		blocker_id: input.blockerId,
	}, async () => await resolveBlockerImpl(cwd, input))
}

export async function deferBlocker(cwd: string, input: DeferBlockerInput): Promise<RoadmapBlocker> {
	return await storeTiming('deferBlocker', cwd, {
		roadmap_id: input.roadmapId,
		blocker_id: input.blockerId,
	}, async () => await deferBlockerImpl(cwd, input))
}

export async function appendNote(cwd: string, input: AppendNoteInput): Promise<string> {
	return await storeTiming('appendNote', cwd, {
		kind: input.kind,
		roadmap_id: input.roadmapId,
		milestone_id: input.milestoneId,
		task_id: input.taskId,
		wave_id: input.waveId,
		blocking: input.blocking ?? false,
		status: input.status ?? 'open',
	}, async () => await appendNoteImpl(cwd, input))
}

export async function amend(cwd: string, input: AmendmentInput): Promise<string> {
	return await storeTiming('amend', cwd, {
		scope: input.scope,
		material: input.material,
	}, async () => await amendImpl(cwd, input))
}
