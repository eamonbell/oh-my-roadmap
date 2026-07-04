import {milestoneCloseoutPath} from './paths'
import {readMarkdownData, writeMarkdownData} from './files'
import {withStoreWriteLock} from './lock'
import type {CloseoutEvidence, EvidenceResult, RiskDisposition, ValidationIssue,} from './types'
import {issue} from './plan-validation'

export function openCloseoutEvidence(
	roadmapId: string,
	milestoneId: string,
	changeRequestId?: string,
): CloseoutEvidence {
	return {
		roadmap_id: roadmapId,
		milestone_id: milestoneId,
		...(changeRequestId ? {change_request_id: changeRequestId} : {}),
		status: 'open',
		acceptance_results: [],
		verification_results: [],
		worker_notes_reviewed: false,
		review_summary: '',
		unresolved_risks: [],
	}
}

export type CloseoutItemKind = 'acceptance' | 'verification';

export function closeoutItemId(kind: CloseoutItemKind, index: number): string {
	return `${kind}:${index + 1}`
}

export interface CloseoutRequirement {
	id: string;
	item: string;
	result?: EvidenceResult;
}

export function closeoutRequirements(
	acceptance: string[],
	verification: string[],
	evidence?: CloseoutEvidence,
): {acceptance: CloseoutRequirement[]; verification: CloseoutRequirement[]} {
	const mapItems = (items: string[], kind: CloseoutItemKind, results: EvidenceResult[] | undefined): CloseoutRequirement[] =>
		items.map((item, index) => {
			const result = results?.find((candidate) => candidate.item === item)
			return {
				id: closeoutItemId(kind, index),
				item,
				...(result ? {result} : {}),
			}
		})
	return {
		acceptance: mapItems(acceptance, 'acceptance', evidence?.acceptance_results),
		verification: mapItems(verification, 'verification', evidence?.verification_results),
	}
}

export interface EvidenceResultInput extends Omit<EvidenceResult, 'item'> {
	item?: string;
	itemId?: string;
}

export interface CloseoutEvidenceInput extends Omit<CloseoutEvidence, 'acceptance_results' | 'verification_results'> {
	acceptance_results: EvidenceResultInput[];
	verification_results: EvidenceResultInput[];
}

function canonicalCloseoutItem(kind: CloseoutItemKind, itemId: string, expected: string[]): string {
	const match = /^(acceptance|verification):(\d+)$/.exec(itemId)
	if (!match || match[1] !== kind) throw new Error(`Unknown closeout itemId: ${itemId}`)
	const index = Number(match[2]) - 1
	if (!Number.isInteger(index) || index < 0 || index >= expected.length) {
		throw new Error(`Unknown closeout itemId: ${itemId}`)
	}
	return expected[index]!
}

function normalizeCloseoutResult(result: EvidenceResultInput, kind: CloseoutItemKind, expected: string[]): EvidenceResult {
	const {item, itemId, ...rest} = result
	if (itemId !== undefined) {
		const canonical = canonicalCloseoutItem(kind, itemId, expected)
		if (item !== undefined && item !== canonical) {
			throw new Error(`Closeout itemId ${itemId} does not match item text.`)
		}
		return {...rest, item: canonical}
	}
	if (item !== undefined) {
		return {...rest, item}
	}
	throw new Error('Closeout result requires itemId or item.')
}

export function normalizeCloseoutEvidenceInput(
	input: CloseoutEvidenceInput,
	expectedAcceptance: string[],
	expectedVerification: string[],
): CloseoutEvidence {
	return {
		...input,
		acceptance_results: input.acceptance_results.map((result) => normalizeCloseoutResult(result, 'acceptance', expectedAcceptance)),
		verification_results: input.verification_results.map((result) => normalizeCloseoutResult(result, 'verification', expectedVerification)),
	}
}

export async function loadMilestoneCloseout(
	cwd: string,
	roadmapId: string,
	milestoneId: string,
): Promise<CloseoutEvidence> {
	return await readMarkdownData<CloseoutEvidence>(
		milestoneCloseoutPath(cwd, roadmapId, milestoneId),
	)
}

export async function writeMilestoneCloseout(
	cwd: string,
	evidence: CloseoutEvidence,
): Promise<void> {
	await withStoreWriteLock(cwd, async () => {
		await writeMarkdownData(
			milestoneCloseoutPath(cwd, evidence.roadmap_id, evidence.milestone_id),
			{...evidence} as unknown as Record<string, unknown>,
			renderCloseoutBody(evidence),
		)
	})
}

export function closeoutBodySummary(evidence: CloseoutEvidence): string {
	const scope = evidence.change_request_id
		? `Change request: ${evidence.change_request_id}`
		: `Milestone: ${evidence.milestone_id}`
	return `${scope}\nStatus: ${evidence.status}\nReview: ${evidence.review_summary || '(not recorded)'}`
}

function renderCloseoutBody(evidence: CloseoutEvidence): string {
	const acceptance = renderResults('Acceptance Criteria', evidence.acceptance_results)
	const verification = renderResults('Verification Commands', evidence.verification_results)
	const risks = renderRisks(evidence.unresolved_risks)
	return `# Closeout Evidence\n\n${closeoutBodySummary(evidence)}\n\n${acceptance}\n\n${verification}\n\n${risks}\n`
}

function renderResults(title: string, results: EvidenceResult[]): string {
	const lines = [`## ${title}`]
	for (const result of results) {
		const suffix = result.reason ? ` - ${result.reason}` : ''
		lines.push(`- ${result.status}: ${result.item}${suffix}`)
	}
	return lines.join('\n')
}

function renderRisks(risks: RiskDisposition[]): string {
	const lines = ['## Unresolved Risks']
	for (const risk of risks) {
		const suffix = risk.reason ? ` - ${risk.reason}` : ''
		lines.push(`- ${risk.disposition}: ${risk.risk}${suffix}`)
	}
	return lines.join('\n')
}

export function validateCloseoutEvidence(
	evidence: CloseoutEvidence | undefined,
	expectedAcceptance: string[],
	expectedVerification: string[],
	errors: ValidationIssue[],
	codePrefix: 'closeout' | 'change.closeout',
): void {
	if (!evidence) {
		errors.push(issue(`${codePrefix}.missing`, 'Closeout evidence is required'))
		return
	}
	if (evidence.status !== 'closed') {
		errors.push(issue(`${codePrefix}.open`, 'Closeout evidence must be closed before completion'))
	}
	if (!evidence.worker_notes_reviewed) {
		errors.push(issue(`${codePrefix}.notes.unreviewed`, 'Closeout must confirm worker notes were reviewed'))
	}
	if (!evidence.review_summary.trim()) {
		errors.push(issue(`${codePrefix}.review.missing`, 'Closeout must include a review summary'))
	}
	validateResultSet(
		evidence.acceptance_results,
		expectedAcceptance,
		errors,
		`${codePrefix}.acceptance`,
		'acceptance criterion',
	)
	validateResultSet(
		evidence.verification_results,
		expectedVerification,
		errors,
		`${codePrefix}.verification`,
		'verification command',
	)
	for (const risk of evidence.unresolved_risks) {
		if (!risk.risk.trim()) errors.push(issue(`${codePrefix}.risk.missing`, 'Risk entry requires text'))
		if (!risk.reason?.trim()) {
			errors.push(issue(`${codePrefix}.risk.reason.missing`, `Risk ${risk.risk} requires a disposition reason`))
		}
		if (risk.disposition === 'deferred' && !risk.approver?.trim()) {
			errors.push(issue(`${codePrefix}.risk.approver.missing`, `Deferred risk ${risk.risk} requires an approver`))
		}
	}
}

function validateResultSet(
	results: EvidenceResult[],
	expectedItems: string[],
	errors: ValidationIssue[],
	codePrefix: string,
	label: string,
): void {
	const byItem = new Map(results.map((result) => [result.item, result]))
	for (const item of expectedItems) {
		const result = byItem.get(item)
		if (!result) {
			errors.push(issue(`${codePrefix}.missing`, `Missing closeout result for ${label}: ${item}`))
			continue
		}
		if (result.status === 'failed' || result.status === 'open') {
			errors.push(issue(`${codePrefix}.failed`, `${label} is not passed or deferred: ${item}`))
		}
		if (result.status === 'deferred' && (!result.reason?.trim() || !result.approver?.trim())) {
			errors.push(issue(`${codePrefix}.defer.incomplete`, `Deferred ${label} requires reason and approver: ${item}`))
		}
	}
	for (const result of results) {
		if (!expectedItems.includes(result.item)) {
			errors.push(issue(`${codePrefix}.unknown`, `Closeout result references unknown ${label}: ${result.item}`))
		}
	}
}
