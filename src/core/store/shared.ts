import * as crypto from 'node:crypto'
import {validateCloseoutEvidence} from '../closeout'
import type {Approval, CloseoutEvidence, MilestonePlan, Phase, RoadmapState} from '../types'

export function nowIso(): string {
	return new Date().toISOString()
}

export function assertSlug(slug: string, field: string): void {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
		throw new Error(`${field} must be a lower-case slug using letters, numbers, and hyphens`)
	}
}

export function roadmapBlockerId(): string {
	return `blk_${crypto.randomUUID()}`
}

export function list(items: string[]): string {
	return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- (none)'
}

export function valueList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function valueString(value: unknown): string {
	return typeof value === 'string' ? value : ''
}

export function valueNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function approval(approver: string | undefined, summary: string | undefined): Approval {
	return {
		by: approver ?? 'user',
		at: nowIso(),
		summary: summary ?? 'Approved in OMP session',
	}
}

export function setMilestoneStatus(roadmap: RoadmapState, milestoneId: string, status: Phase): void {
	const milestone = roadmap.milestones.find((candidate) => candidate.id === milestoneId)
	if (milestone) milestone.status = status
}

export function hasPlannableMilestone(roadmap: RoadmapState): boolean {
	return roadmap.milestones.some((milestone) => ['planned', 'blocked'].includes(milestone.status))
}

export function requirePhase(actual: Phase, expected: Phase, operation: string, remediation?: string): void {
	if (actual !== expected) {
		const base = `${operation} requires phase ${expected}; current phase is ${actual}`
		throw new Error(remediation ? `${base}. ${remediation}` : base)
	}
}

export function requireActiveMilestone(
	milestoneId: string | undefined,
	milestone: MilestonePlan | undefined,
): asserts milestone is MilestonePlan {
	if (!milestoneId || !milestone) throw new Error('No active milestone')
}

export function requireMilestoneId(milestoneId: string | undefined): string {
	if (!milestoneId) throw new Error('No active milestone')
	return milestoneId
}

export function closeoutOrThrow(
	evidence: CloseoutEvidence | undefined,
	acceptance: string[],
	verification: string[],
): void {
	const errors: { code: string; message: string; path?: string }[] = []
	validateCloseoutEvidence(evidence, acceptance, verification, errors, 'closeout')
	if (errors.length > 0) {
		throw new Error(errors[0]?.message ?? 'Closeout evidence is invalid')
	}
}
