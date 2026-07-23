import * as fs from 'node:fs/promises'
import {appendRoadmapEvent, roadmapEventId} from '../events'
import {fileExists, readText, writeText} from '../files'
import {withStoreWriteLock} from '../lock'
import {activePointerPath, decisionsPath, risksPath, roadmapDir, roadmapDocPath} from '../paths'
import type {RoadmapMilestoneCheck, RoadmapState} from '../types'
import type {InitRoadmapInput, RepairRoadmapInput, RepairRoadmapResult, UpdateRoadmapInput, WaveFlowCheckInput} from './contract'
import {
	hasContent,
	hasContentItems,
	pendingRoadmapMilestoneCheck,
	recordedRoadmapMilestoneCheck,
	renderRoadmapMarkdown,
	roadmapContentHash
} from './format'
import {
	loadActive,
	loadRoadmapState,
	loadState,
	storeTiming,
	withStoreMutationRollback,
	writeActive,
	writeRoadmapBlockers,
	writeRoadmapState
} from './persistence'
import {assertSlug, nowIso} from './shared'

export function requirePassedRepairRoadmapMilestoneCheck(input: WaveFlowCheckInput, roadmap: RoadmapState): RoadmapMilestoneCheck {
	if (!roadmap.roadmap_finalized) {
		throw new Error('repair_roadmap can record a roadmap-milestone check only for a finalized roadmap')
	}
	if (input.status !== 'passed') {
		throw new Error('repair_roadmap roadmapMilestoneCheck must have status passed')
	}
	if (!input.summary || input.summary.trim() === '') {
		throw new Error('repair_roadmap roadmapMilestoneCheck requires a non-empty summary')
	}
	return recordedRoadmapMilestoneCheck(input, roadmap)
}

export async function assertRoadmapReadyForApproval(cwd: string, roadmap: RoadmapState): Promise<void> {
	if (!roadmap.roadmap_finalized) throw new Error('Roadmap approval requires a finalized roadmap')
	if (!hasContent(roadmap.goal)) throw new Error('Roadmap approval requires a concrete goal')
	for (const [label, items] of [
		['success criteria', roadmap.success_criteria],
		['constraints', roadmap.constraints],
		['non-goals', roadmap.non_goals],
		['context', roadmap.context],
		['evidence', roadmap.evidence],
		['risks', roadmap.risks],
	] as const) {
		if (!hasContentItems(items)) throw new Error(`Roadmap approval requires concrete ${label}`)
	}
	if (!Array.isArray(roadmap.milestones) || roadmap.milestones.length === 0) {
		throw new Error('Roadmap approval requires at least one concrete milestone')
	}

	const milestoneIds = new Set<string>()
	for (const milestone of roadmap.milestones) {
		if (milestoneIds.has(milestone.id)) throw new Error(`Duplicate milestone id: ${milestone.id}`)
		milestoneIds.add(milestone.id)
		if (!hasContent(milestone.id)) throw new Error('Roadmap milestone requires an id')
		if (!hasContent(milestone.title)) throw new Error(`Roadmap milestone ${milestone.id} requires a title`)
		if (!hasContent(milestone.goal)) throw new Error(`Roadmap milestone ${milestone.id} requires a goal`)
		for (const [label, items] of [
			['scope', milestone.scope],
			['non-goals', milestone.non_goals],
			['evidence', milestone.evidence],
			['risks', milestone.risks],
			['acceptance intent', milestone.acceptance_intent],
			['verification intent', milestone.verification_intent],
		] as const) {
			if (!hasContentItems(items)) throw new Error(`Roadmap milestone ${milestone.id} requires concrete ${label}`)
		}
	}
	for (const milestone of roadmap.milestones) {
		for (const dependency of milestone.dependencies ?? []) {
			if (!milestoneIds.has(dependency)) {
				throw new Error(`Roadmap milestone ${milestone.id} depends on unknown milestone ${dependency}`)
			}
		}
	}

	const expected = renderRoadmapMarkdown(roadmap)
	const actual = await readText(roadmapDocPath(cwd, roadmap.roadmap_id))
	if (actual !== expected) throw new Error('Roadmap approval requires generated roadmap.md to match state')
	if (roadmap.roadmap_content_hash !== roadmapContentHash(roadmap)) {
		throw new Error('Roadmap approval requires roadmap content hash to match generated roadmap state')
	}
	if (roadmap.roadmap_milestone_check.status !== 'passed') {
		throw new Error('Roadmap approval requires a passed roadmap-milestone check')
	}
	if (roadmap.roadmap_milestone_check.roadmap_revision !== roadmap.roadmap_revision) {
		throw new Error('Roadmap approval requires a roadmap-milestone check for the current roadmap revision')
	}
	if (roadmap.roadmap_milestone_check.roadmap_content_hash !== roadmap.roadmap_content_hash) {
		throw new Error('Roadmap approval requires a roadmap-milestone check for the current roadmap content hash')
	}
	if (roadmap.roadmap_milestone_check.checked_by.trim() === '') {
		throw new Error('Passed roadmap-milestone check must record who checked it')
	}
	if (roadmap.roadmap_milestone_check.checked_at.trim() === '') {
		throw new Error('Passed roadmap-milestone check must record when it ran')
	}
	if (roadmap.roadmap_milestone_check.summary.trim() === '') {
		throw new Error('Passed roadmap-milestone check must include a summary')
	}
	if (roadmap.roadmap_milestone_check.event_id.trim() === '') {
		throw new Error('Passed roadmap-milestone check must record its quality gate event id')
	}
}

export async function clearActivePointer(cwd: string): Promise<void> {
	return await withStoreWriteLock(cwd, async () => {
		await fs.rm(activePointerPath(cwd), {force: true})
	})
}

export async function initRoadmapImpl(cwd: string, input: InitRoadmapInput): Promise<RoadmapState> {
	return await withStoreWriteLock(cwd, async () => {
		assertSlug(input.roadmapId, 'roadmapId')
		// Recording repo discovery is a distinct transition (record_discovery) that advances the
		// phase discovery -> roadmap_draft and captures findings, content hash, and revision
		// semantics. A new roadmap always starts in discovery, so accepting `discovery.recorded: true`
		// at init would mark discovery complete while the phase stays `discovery` — an incoherent
		// state that later lets approve_roadmap's discovery gate pass without discovery ever having
		// run. Reject it loudly rather than silently accept-and-ignore. Other discovery scaffolding
		// fields (external_research_required/recorded, findings) may still be seeded here.
		if (input.discovery?.recorded === true) {
			throw new Error('Cannot mark discovery recorded at init: a new roadmap starts in the discovery phase. Record repo discovery with the record_discovery transition instead.')
		}
		// Never overwrite an existing roadmap directory (e.g. a just-archived completed roadmap
		// whose id is reused): auto-archive only clears the active pointer, the files remain as
		// history, and mkdir(recursive)+writes below would otherwise clobber them.
		if (await fileExists(roadmapDir(cwd, input.roadmapId))) {
			throw new Error(`Cannot create roadmap: a roadmap named ${input.roadmapId} already exists`)
		}
		const existingActive = await loadActive(cwd)
		if (existingActive) {
			const existingRoadmap = await loadRoadmapState(cwd, existingActive.roadmap_id)
			const hasActiveChangeRequest =
				Boolean(existingActive.change_request_id) || Boolean(existingRoadmap.active_change_request_id)
			if (existingRoadmap.phase !== 'complete' || hasActiveChangeRequest) {
				throw new Error(`Cannot create roadmap: ${existingActive.roadmap_id} is already active`)
			}
			// Completed roadmap with no active change request: auto-archive it. The roadmap
			// directory and files are preserved as history; only the active pointer is cleared.
			await appendRoadmapEvent(cwd, {
				actor: 'user',
				type: 'roadmap.archived',
				scope: {roadmap_id: existingRoadmap.roadmap_id},
				summary: `Archived completed roadmap ${existingRoadmap.roadmap_id} to start a new roadmap.`,
				before: {phase: existingRoadmap.phase},
			})
			await clearActivePointer(cwd)
		}

		return await withStoreMutationRollback(cwd, input.roadmapId, async () => {
			const createdAt = nowIso()
			const state: RoadmapState = {
				roadmap_id: input.roadmapId,
				title: input.title,
				phase: 'discovery',
				created_at: createdAt,
				updated_at: createdAt,
				roadmap_finalized: false,
				roadmap_revision: 0,
				roadmap_content_hash: '',
				roadmap_milestone_check: pendingRoadmapMilestoneCheck(0, ''),
				goal: input.summary ?? '',
				success_criteria: [],
				constraints: [],
				non_goals: [],
				context: [],
				evidence: [],
				risks: [],
				discovery: {
					recorded: input.discovery?.recorded ?? false,
					external_research_required: input.discovery?.external_research_required ?? false,
					external_research_recorded: input.discovery?.external_research_recorded ?? false,
					findings: input.discovery?.findings ?? [],
				},
				approvals: [],
				open_questions: [],
				milestones: [],
			}
			state.roadmap_content_hash = roadmapContentHash(state)
			state.roadmap_milestone_check = pendingRoadmapMilestoneCheck(state.roadmap_revision, state.roadmap_content_hash)

			await fs.mkdir(roadmapDir(cwd, input.roadmapId), {recursive: true})
			await writeRoadmapState(cwd, state)
			await writeRoadmapBlockers(cwd, state.roadmap_id, [])
			await writeActive(cwd, {roadmap_id: input.roadmapId, updated_at: createdAt})
			await writeText(
				roadmapDocPath(cwd, input.roadmapId),
				renderRoadmapMarkdown(state),
			)
			await writeText(decisionsPath(cwd, input.roadmapId), '# Decision Register\n')
			await writeText(risksPath(cwd, input.roadmapId), '# Risk Register\n')
			await appendRoadmapEvent(cwd, {
				actor: 'user',
				type: 'roadmap.initialized',
				scope: {roadmap_id: state.roadmap_id},
				summary: `Initialized roadmap ${state.roadmap_id}.`,
				after: {
					phase: state.phase,
					roadmap_finalized: state.roadmap_finalized,
				},
			})
			return state
		})
	})
}

export async function repairRoadmapImpl(cwd: string, input: RepairRoadmapInput): Promise<RepairRoadmapResult> {
	return await withStoreWriteLock(cwd, async () => {
		const reason = input.reason.trim()
		if (!reason) throw new Error('repair_roadmap requires a reason')

		const loaded = await loadState(cwd)
		if (!loaded.active || !loaded.roadmap) {
			throw new Error('No active roadmap. Run /omr:rm-new first.')
		}

		return await withStoreMutationRollback(cwd, loaded.roadmap.roadmap_id, async () => {
			const roadmap = loaded.roadmap!
			const actor = input.actor?.trim() || 'roadmap-repair'
			const previousRevision = roadmap.roadmap_revision
			const previousContentHash = roadmap.roadmap_content_hash
			const beforeCheck = {...roadmap.roadmap_milestone_check}
			const computedContentHash = roadmapContentHash(roadmap)
			const contentHashChanged = previousContentHash !== computedContentHash
			const expectedDoc = renderRoadmapMarkdown(roadmap)
			let currentDoc = ''
			let docMissing = false
			try {
				currentDoc = await readText(roadmapDocPath(cwd, roadmap.roadmap_id))
			} catch {
				docMissing = true
			}
			const docStale = docMissing || currentDoc !== expectedDoc
			const roadmapMilestoneCheckStale =
				roadmap.roadmap_milestone_check.status !== 'pending' &&
				(roadmap.roadmap_milestone_check.roadmap_revision !== roadmap.roadmap_revision ||
					roadmap.roadmap_milestone_check.roadmap_content_hash !== computedContentHash)

			if (contentHashChanged) {
				roadmap.roadmap_revision += 1
			}
			roadmap.roadmap_content_hash = computedContentHash

			let gateAction: RepairRoadmapResult['gate_action'] = 'unchanged'
			let qualityGateEventId: string | undefined
			if (input.roadmapMilestoneCheck) {
				qualityGateEventId = roadmapEventId()
				roadmap.roadmap_milestone_check = requirePassedRepairRoadmapMilestoneCheck(input.roadmapMilestoneCheck, roadmap)
				roadmap.roadmap_milestone_check.event_id = qualityGateEventId
				gateAction = 'recorded_passed'
			} else if (contentHashChanged || roadmapMilestoneCheckStale) {
				roadmap.roadmap_milestone_check = pendingRoadmapMilestoneCheck(
					roadmap.roadmap_revision,
					roadmap.roadmap_content_hash,
				)
				gateAction = 'reset_pending'
			}

			const stateChanged =
				contentHashChanged ||
				gateAction !== 'unchanged' ||
				previousContentHash !== roadmap.roadmap_content_hash
			const roadmapDocRewritten = contentHashChanged || docStale
			if (stateChanged) await writeRoadmapState(cwd, roadmap)
			if (roadmapDocRewritten && !roadmap.roadmap_finalized) {
				await writeText(roadmapDocPath(cwd, roadmap.roadmap_id), renderRoadmapMarkdown(roadmap))
			} else if (roadmapDocRewritten && !stateChanged) {
				await writeText(roadmapDocPath(cwd, roadmap.roadmap_id), renderRoadmapMarkdown(roadmap))
			}

			const repairEvent = await appendRoadmapEvent(cwd, {
				actor,
				type: 'roadmap.repaired',
				operation: 'repair_roadmap',
				scope: {roadmap_id: roadmap.roadmap_id},
				summary: input.summary?.trim() || `Repaired roadmap ${roadmap.roadmap_id}.`,
				before: {
					roadmap_revision: previousRevision,
					roadmap_content_hash: previousContentHash,
					roadmap_milestone_check: beforeCheck,
				},
				after: {
					roadmap_revision: roadmap.roadmap_revision,
					roadmap_content_hash: roadmap.roadmap_content_hash,
					roadmap_milestone_check: roadmap.roadmap_milestone_check,
				},
				details: {
					reason,
					content_hash_changed: contentHashChanged,
					roadmap_doc_rewritten: roadmapDocRewritten,
					gate_action: gateAction,
					previous_content_hash: previousContentHash,
					current_content_hash: roadmap.roadmap_content_hash,
					previous_revision: previousRevision,
					current_revision: roadmap.roadmap_revision,
				},
			})

			if (qualityGateEventId) {
				await appendRoadmapEvent(cwd, {
					id: qualityGateEventId,
					actor: roadmap.roadmap_milestone_check.checked_by,
					type: 'quality_gate.recorded',
					operation: 'repair_roadmap',
					scope: {roadmap_id: roadmap.roadmap_id, gate: 'roadmap_milestone_check'},
					summary: 'Roadmap milestone check recorded as passed during repair.',
					before: beforeCheck,
					after: {...roadmap.roadmap_milestone_check},
					details: {
						summary: roadmap.roadmap_milestone_check.summary,
						gate_status: roadmap.roadmap_milestone_check.status,
						roadmap_revision: roadmap.roadmap_revision,
						roadmap_content_hash: roadmap.roadmap_content_hash,
						findings: roadmap.roadmap_milestone_check.findings,
						repair_event_id: repairEvent.id,
					},
				})
			}

			return {
				roadmap_id: roadmap.roadmap_id,
				previous_revision: previousRevision,
				current_revision: roadmap.roadmap_revision,
				previous_content_hash: previousContentHash,
				current_content_hash: roadmap.roadmap_content_hash,
				content_hash_changed: contentHashChanged,
				roadmap_doc_rewritten: roadmapDocRewritten,
				gate_action: gateAction,
				repair_event_id: repairEvent.id,
				...(qualityGateEventId ? {quality_gate_event_id: qualityGateEventId} : {}),
			}
		})
	})
}

export async function updateRoadmapImpl(
	cwd: string,
	input: UpdateRoadmapInput,
): Promise<RoadmapState> {
	return await withStoreWriteLock(cwd, async () => {
		const loaded = await loadState(cwd)
		if (!loaded.active || !loaded.roadmap) {
			throw new Error('No active roadmap. Run /omr:rm-new first.')
		}
		const roadmap = loaded.roadmap
		if (!['discovery', 'roadmap_draft'].includes(roadmap.phase)) {
			throw new Error(`update_roadmap requires phase discovery or roadmap_draft; current phase is ${roadmap.phase}`)
		}

		for (const milestone of input.milestones) {
			assertSlug(milestone.id, 'milestone.id')
		}

		return await withStoreMutationRollback(cwd, roadmap.roadmap_id, async () => {
			const state: RoadmapState = {
				...roadmap,
				roadmap_finalized: true,
				roadmap_revision: roadmap.roadmap_revision + 1,
				goal: input.goal,
				success_criteria: input.successCriteria,
				constraints: input.constraints,
				non_goals: input.nonGoals,
				context: input.context,
				evidence: input.evidence,
				risks: input.risks,
				milestones: input.milestones.map((milestone) => ({
					...milestone,
					status: milestone.status ?? 'planned',
				})),
			}
			state.roadmap_content_hash = roadmapContentHash(state)
			if (roadmap.roadmap_milestone_check.status === 'pending') {
				state.roadmap_milestone_check = pendingRoadmapMilestoneCheck(state.roadmap_revision, state.roadmap_content_hash)
			}

			await writeRoadmapState(cwd, state)
			await writeText(roadmapDocPath(cwd, state.roadmap_id), renderRoadmapMarkdown(state))
			await appendRoadmapEvent(cwd, {
				actor: 'user',
				type: 'roadmap.updated',
				scope: {roadmap_id: state.roadmap_id},
				summary: `Updated roadmap ${state.roadmap_id}.`,
				after: {
					phase: state.phase,
					roadmap_finalized: state.roadmap_finalized,
					milestone_count: state.milestones.length,
				},
			})
			return await loadRoadmapState(cwd, state.roadmap_id)
		})
	})
}

export async function initRoadmap(cwd: string, input: InitRoadmapInput): Promise<RoadmapState> {
	return await storeTiming('initRoadmap', cwd, {
		roadmap_id: input.roadmapId,
	}, async () => await initRoadmapImpl(cwd, input))
}

export async function updateRoadmap(
	cwd: string,
	input: UpdateRoadmapInput,
): Promise<RoadmapState> {
	return await storeTiming('updateRoadmap', cwd, {
		milestone_count: input.milestones.length,
	}, async () => await updateRoadmapImpl(cwd, input))
}

export async function repairRoadmap(cwd: string, input: RepairRoadmapInput): Promise<RepairRoadmapResult> {
	return await storeTiming('repairRoadmap', cwd, {
		has_roadmap_milestone_check: input.roadmapMilestoneCheck !== undefined,
	}, async () => await repairRoadmapImpl(cwd, input))
}
