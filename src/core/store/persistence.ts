import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {withDiagnosticTiming} from '../../diagnostics'
import {loadMilestoneCloseout} from '../closeout'
import {fileExists, readMarkdownData, readYamlFile, writeMarkdownData, writeText, writeYamlFile} from '../files'
import {withStoreWriteLock} from '../lock'
import {
	activePointerPath,
	changeRequestPath,
	changeRequestRuntimePath,
	milestoneCloseoutPath,
	milestonePlanPath,
	milestoneRuntimePath,
	roadmapBlockersPath,
	roadmapDir,
	roadmapDocPath,
	roadmapsDir,
	roadmapStatePath
} from '../paths'
import type {
	ActivePointer,
	ChangeRequest,
	ChangeRequestRuntime,
	LoadedState,
	MilestonePlan,
	MilestoneRuntime,
	RoadmapBlocker,
	RoadmapState
} from '../types'
import {loadUsageSummary} from '../usage'
import {
	applyRuntime,
	normalizeChangeRequest,
	normalizeMilestonePlan,
	normalizePlanRuntime,
	normalizeRoadmapState,
	planDefinitionData,
	renderImplementationPlanBody,
	renderRoadmapMarkdown,
	roadmapContentHash,
	runtimeFromPlan
} from './format'
import {nowIso} from './shared'

export interface StoreMutationSnapshot {
	roadmapId: string;
	tempDir: string;
	roadmapExisted: boolean;
	activeExisted: boolean;
	roadmapBackupPath: string;
	activeBackupPath: string;
}

export async function createStoreMutationSnapshot(cwd: string, roadmapId: string): Promise<StoreMutationSnapshot> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roadmap-store-rollback-'))
	const snapshot: StoreMutationSnapshot = {
		roadmapId,
		tempDir,
		roadmapExisted: await fileExists(roadmapDir(cwd, roadmapId)),
		activeExisted: await fileExists(activePointerPath(cwd)),
		roadmapBackupPath: path.join(tempDir, 'roadmap'),
		activeBackupPath: path.join(tempDir, 'active.yml'),
	}

	if (snapshot.roadmapExisted) {
		await fs.cp(roadmapDir(cwd, roadmapId), snapshot.roadmapBackupPath, {recursive: true})
	}
	if (snapshot.activeExisted) {
		await fs.copyFile(activePointerPath(cwd), snapshot.activeBackupPath)
	}

	return snapshot
}

export async function restoreStoreMutationSnapshot(cwd: string, snapshot: StoreMutationSnapshot): Promise<void> {
	await fs.rm(roadmapDir(cwd, snapshot.roadmapId), {recursive: true, force: true})
	if (snapshot.roadmapExisted) {
		await fs.cp(snapshot.roadmapBackupPath, roadmapDir(cwd, snapshot.roadmapId), {recursive: true})
	}

	await fs.rm(activePointerPath(cwd), {force: true})
	if (snapshot.activeExisted) {
		await fs.mkdir(path.dirname(activePointerPath(cwd)), {recursive: true})
		await fs.copyFile(snapshot.activeBackupPath, activePointerPath(cwd))
	}
}

export async function withStoreMutationRollback<T>(
	cwd: string,
	roadmapId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const snapshot = await createStoreMutationSnapshot(cwd, roadmapId)
	try {
		const result = await fn()
		await fs.rm(snapshot.tempDir, {recursive: true, force: true}).catch(() => undefined)
		return result
	} catch (error) {
		try {
			await restoreStoreMutationSnapshot(cwd, snapshot)
		} finally {
			await fs.rm(snapshot.tempDir, {recursive: true, force: true}).catch(() => undefined)
		}
		throw error
	}
}

export function blockerYaml(blockers: RoadmapBlocker[]): { blockers: RoadmapBlocker[] } {
	return {blockers}
}

export function normalizeBlockers(value: unknown): RoadmapBlocker[] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return []
	const raw = value as { blockers?: unknown }
	return Array.isArray(raw.blockers) ? raw.blockers as RoadmapBlocker[] : []
}

export async function loadActiveImpl(cwd: string): Promise<ActivePointer | undefined> {
	const filePath = activePointerPath(cwd)
	if (!(await fileExists(filePath))) return undefined
	return await readYamlFile<ActivePointer>(filePath)
}

export async function writeActiveImpl(cwd: string, active: ActivePointer): Promise<void> {
	await withStoreWriteLock(cwd, async () => {
		await writeYamlFile(activePointerPath(cwd), active)
	})
}

export async function loadRoadmapStateImpl(cwd: string, roadmapId: string): Promise<RoadmapState> {
	return normalizeRoadmapState(await readYamlFile<RoadmapState>(roadmapStatePath(cwd, roadmapId)))
}

export async function loadRoadmapBlockersImpl(cwd: string, roadmapId: string): Promise<RoadmapBlocker[]> {
	const filePath = roadmapBlockersPath(cwd, roadmapId)
	if (!(await fileExists(filePath))) return []
	return normalizeBlockers(await readYamlFile<unknown>(filePath))
}

export async function writeRoadmapBlockersImpl(
	cwd: string,
	roadmapId: string,
	blockers: RoadmapBlocker[],
): Promise<void> {
	await writeYamlFile(roadmapBlockersPath(cwd, roadmapId), blockerYaml(blockers))
}

export async function writeRoadmapStateImpl(cwd: string, state: RoadmapState): Promise<void> {
	await withStoreWriteLock(cwd, async () => {
		state.updated_at = nowIso()
		state.roadmap_content_hash = roadmapContentHash(state)
		await writeYamlFile(roadmapStatePath(cwd, state.roadmap_id), state)
		if (state.roadmap_finalized) {
			await writeText(roadmapDocPath(cwd, state.roadmap_id), renderRoadmapMarkdown(state))
		}
	})
}

export async function loadMilestonePlanImpl(
	cwd: string,
	roadmapId: string,
	milestoneId: string,
): Promise<MilestonePlan> {
	const plan = normalizeMilestonePlan(await readMarkdownData<MilestonePlan>(
		milestonePlanPath(cwd, roadmapId, milestoneId),
	))
	const runtimePath = milestoneRuntimePath(cwd, roadmapId, milestoneId)
	if (!(await fileExists(runtimePath))) return plan
	return applyRuntime(plan, await loadMilestoneRuntime(cwd, roadmapId, milestoneId))
}

export async function writeMilestonePlanImpl(
	cwd: string,
	plan: MilestonePlan,
	body?: string,
): Promise<void> {
	await withStoreWriteLock(cwd, async () => {
		const normalized = normalizeMilestonePlan(plan)
		await writeMarkdownData(
			milestonePlanPath(cwd, normalized.roadmap_id, normalized.milestone_id),
			planDefinitionData(normalized),
			body ?? renderImplementationPlanBody(normalized),
		)
	})
}

export async function loadMilestoneRuntimeImpl(
	cwd: string,
	roadmapId: string,
	milestoneId: string,
): Promise<MilestoneRuntime> {
	const plan = normalizeMilestonePlan(await readMarkdownData<MilestonePlan>(
		milestonePlanPath(cwd, roadmapId, milestoneId),
	))
	return normalizePlanRuntime(await readYamlFile<MilestoneRuntime>(
		milestoneRuntimePath(cwd, roadmapId, milestoneId),
	), plan)
}

export async function writeMilestoneRuntimeImpl(
	cwd: string,
	plan: MilestonePlan,
): Promise<void> {
	const normalized = normalizeMilestonePlan(plan)
	await writeYamlFile(
		milestoneRuntimePath(cwd, normalized.roadmap_id, normalized.milestone_id),
		runtimeFromPlan(normalized),
	)
}

export async function loadChangeRequestImpl(
	cwd: string,
	roadmapId: string,
	milestoneId: string,
	changeRequestId: string,
): Promise<ChangeRequest> {
	const change = normalizeChangeRequest(await readMarkdownData<ChangeRequest>(
		changeRequestPath(cwd, roadmapId, milestoneId, changeRequestId),
	))
	const runtimePath = changeRequestRuntimePath(cwd, roadmapId, milestoneId, changeRequestId)
	if (!(await fileExists(runtimePath))) return change
	return applyRuntime(change, await loadChangeRequestRuntime(cwd, roadmapId, milestoneId, changeRequestId))
}

export async function loadChangeRequestRuntimeImpl(
	cwd: string,
	roadmapId: string,
	milestoneId: string,
	changeRequestId: string,
): Promise<ChangeRequestRuntime> {
	const change = normalizeChangeRequest(await readMarkdownData<ChangeRequest>(
		changeRequestPath(cwd, roadmapId, milestoneId, changeRequestId),
	))
	return normalizePlanRuntime(await readYamlFile<ChangeRequestRuntime>(
		changeRequestRuntimePath(cwd, roadmapId, milestoneId, changeRequestId),
	), change)
}

export async function writeChangeRequestRuntimeImpl(
	cwd: string,
	change: ChangeRequest,
): Promise<void> {
	const normalized = normalizeChangeRequest(change)
	await writeYamlFile(
		changeRequestRuntimePath(cwd, normalized.roadmap_id, normalized.milestone_id, normalized.change_request_id),
		runtimeFromPlan(normalized),
	)
}

export async function loadStateImpl(cwd: string): Promise<LoadedState> {
	const active = await loadActive(cwd)
	if (!active) return {}

	const roadmap = await loadRoadmapState(cwd, active.roadmap_id)
	const milestone = active.milestone_id
		? await loadMilestonePlan(cwd, active.roadmap_id, active.milestone_id)
		: undefined
	const changeRequest =
		active.milestone_id && active.change_request_id
			? await loadChangeRequest(cwd, active.roadmap_id, active.milestone_id, active.change_request_id)
			: undefined
	const closeout =
		active.milestone_id && (await fileExists(milestoneCloseoutPath(cwd, active.roadmap_id, active.milestone_id)))
			? await loadMilestoneCloseout(cwd, active.roadmap_id, active.milestone_id)
			: undefined

	const loaded: LoadedState = {active, roadmap}
	if (milestone) loaded.milestone = milestone
	if (changeRequest) loaded.changeRequest = changeRequest
	if (closeout) loaded.closeout = closeout
	loaded.usage = await loadUsageSummary(cwd, active.roadmap_id)
	return loaded
}

export function storeTiming<T>(
	operation: string,
	cwd: string,
	metadata: Record<string, unknown> | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	return withDiagnosticTiming({
		component: 'core',
		operation: `store.${operation}`,
		cwd,
		slowMs: 250,
		...(metadata ? {metadata} : {}),
	}, fn)
}

export async function loadActive(cwd: string): Promise<ActivePointer | undefined> {
	return await storeTiming('loadActive', cwd, undefined, async () => await loadActiveImpl(cwd))
}

export async function writeActive(cwd: string, active: ActivePointer): Promise<void> {
	return await storeTiming('writeActive', cwd, {roadmap_id: active.roadmap_id}, async () => await writeActiveImpl(cwd, active))
}

export async function loadRoadmapState(cwd: string, roadmapId: string): Promise<RoadmapState> {
	return await storeTiming('loadRoadmapState', cwd, {roadmap_id: roadmapId}, async () => await loadRoadmapStateImpl(cwd, roadmapId))
}

export async function loadRoadmapBlockers(cwd: string, roadmapId: string): Promise<RoadmapBlocker[]> {
	return await storeTiming('loadRoadmapBlockers', cwd, {roadmap_id: roadmapId}, async () => await loadRoadmapBlockersImpl(cwd, roadmapId))
}

export async function writeRoadmapBlockers(
	cwd: string,
	roadmapId: string,
	blockers: RoadmapBlocker[],
): Promise<void> {
	return await storeTiming('writeRoadmapBlockers', cwd, {
		roadmap_id: roadmapId,
		blocker_count: blockers.length,
	}, async () => await writeRoadmapBlockersImpl(cwd, roadmapId, blockers))
}

export async function writeRoadmapState(cwd: string, state: RoadmapState): Promise<void> {
	return await storeTiming('writeRoadmapState', cwd, {
		roadmap_id: state.roadmap_id,
		phase: state.phase,
	}, async () => await writeRoadmapStateImpl(cwd, state))
}

export async function loadMilestonePlan(
	cwd: string,
	roadmapId: string,
	milestoneId: string,
): Promise<MilestonePlan> {
	return await storeTiming('loadMilestonePlan', cwd, {
		roadmap_id: roadmapId,
		milestone_id: milestoneId,
	}, async () => await loadMilestonePlanImpl(cwd, roadmapId, milestoneId))
}

export async function writeMilestonePlan(
	cwd: string,
	plan: MilestonePlan,
	body?: string,
): Promise<void> {
	return await storeTiming('writeMilestonePlan', cwd, {
		roadmap_id: plan.roadmap_id,
		milestone_id: plan.milestone_id,
	}, async () => await writeMilestonePlanImpl(cwd, plan, body))
}

export async function loadMilestoneRuntime(
	cwd: string,
	roadmapId: string,
	milestoneId: string,
): Promise<MilestoneRuntime> {
	return await storeTiming('loadMilestoneRuntime', cwd, {
		roadmap_id: roadmapId,
		milestone_id: milestoneId,
	}, async () => await loadMilestoneRuntimeImpl(cwd, roadmapId, milestoneId))
}

export async function writeMilestoneRuntime(
	cwd: string,
	plan: MilestonePlan,
): Promise<void> {
	return await storeTiming('writeMilestoneRuntime', cwd, {
		roadmap_id: plan.roadmap_id,
		milestone_id: plan.milestone_id,
	}, async () => await writeMilestoneRuntimeImpl(cwd, plan))
}

export async function loadChangeRequest(
	cwd: string,
	roadmapId: string,
	milestoneId: string,
	changeRequestId: string,
): Promise<ChangeRequest> {
	return await storeTiming('loadChangeRequest', cwd, {
		roadmap_id: roadmapId,
		milestone_id: milestoneId,
		change_request_id: changeRequestId,
	}, async () => await loadChangeRequestImpl(cwd, roadmapId, milestoneId, changeRequestId))
}

export async function loadChangeRequestRuntime(
	cwd: string,
	roadmapId: string,
	milestoneId: string,
	changeRequestId: string,
): Promise<ChangeRequestRuntime> {
	return await storeTiming('loadChangeRequestRuntime', cwd, {
		roadmap_id: roadmapId,
		milestone_id: milestoneId,
		change_request_id: changeRequestId,
	}, async () => await loadChangeRequestRuntimeImpl(cwd, roadmapId, milestoneId, changeRequestId))
}

export async function writeChangeRequestRuntime(
	cwd: string,
	change: ChangeRequest,
): Promise<void> {
	return await storeTiming('writeChangeRequestRuntime', cwd, {
		roadmap_id: change.roadmap_id,
		milestone_id: change.milestone_id,
		change_request_id: change.change_request_id,
	}, async () => await writeChangeRequestRuntimeImpl(cwd, change))
}

export async function loadState(cwd: string): Promise<LoadedState> {
	return await storeTiming('loadState', cwd, undefined, async () => await loadStateImpl(cwd))
}

export async function resetRoadmapStateForTest(cwd: string): Promise<void> {
	await fs.rm(roadmapsDir(cwd), {recursive: true, force: true})
}
