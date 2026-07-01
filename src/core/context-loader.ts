import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {parseMarkdownDocument} from './frontmatter'
import {fileExists, readText} from './files'
import {loadActive} from './store/index'
import {changeRequestPath, decisionsPath, milestoneNotesPath, milestonePlanPath, risksPath, roadmapDir, roadmapDocPath,} from './paths'
import type {ContextArtifact, ContextEntry} from './context-types'

function titleFromBody(body: string): string {
	const heading = body.match(/^#{1,6}\s+(.+)$/m)
	return heading?.[1]?.trim() || '(untitled)'
}

function noteTitle(body: string): string {
	const heading = body.match(/^##\s+(.+)$/m)
	return heading?.[1]?.trim() || titleFromBody(body)
}

function parseNoteEntries(filePath: string, milestoneId: string, text: string, startOrder: number): ContextEntry[] {
	const entries: ContextEntry[] = []
	const parts = text.split(/\n(?=---\nkind:)/g)
	let noteIndex = 0
	for (const part of parts) {
		if (!part.startsWith('---\n')) continue
		const doc = parseMarkdownDocument<Record<string, unknown>>(part)
		noteIndex += 1
		entries.push({
			id: `notes:${milestoneId}:${noteIndex}`,
			artifact: 'notes',
			path: filePath,
			milestoneId,
			title: noteTitle(doc.body),
			body: doc.body.trim(),
			metadata: doc.data,
			order: startOrder + entries.length,
		})
	}
	return entries
}

function slugify(value: string): string {
	const slug = value
	.toLowerCase()
	.replace(/[^a-z0-9]+/g, '-')
	.replace(/^-+|-+$/g, '')
	return slug || 'section'
}

function parseHeadingEntries(
	artifact: Exclude<ContextArtifact, 'notes'>,
	filePath: string,
	text: string,
	startOrder: number,
	idParts: string[] = [],
): ContextEntry[] {
	const matches = Array.from(text.matchAll(/^(#{1,6})\s+(.+)$/gm))
	const entries: ContextEntry[] = []
	const seenIds = new Map<string, number>()
	for (let index = 0; index < matches.length; index += 1) {
		const match = matches[index]
		if (!match || match.index === undefined) continue
		const level = match[1]?.length ?? 1
		if (index === 0 && level === 1) continue

		let end = text.length
		for (let nextIndex = index + 1; nextIndex < matches.length; nextIndex += 1) {
			const nextMatch = matches[nextIndex]
			if (!nextMatch || nextMatch.index === undefined) continue
			const nextLevel = nextMatch[1]?.length ?? 1
			if (nextLevel <= level) {
				end = nextMatch.index
				break
			}
		}
		const title = match[2]?.trim() || '(untitled)'
		let id = `${artifact}:${entries.length + 1}`
		if (artifact === 'roadmap' || artifact === 'plan') {
			const baseId = [artifact, ...idParts, slugify(title)].join(':')
			const count = seenIds.get(baseId) ?? 0
			seenIds.set(baseId, count + 1)
			id = count === 0 ? baseId : `${baseId}-${count + 1}`
		}
		entries.push({
			id,
			artifact,
			path: filePath,
			...(idParts[0] ? {milestoneId: idParts[0]} : {}),
			title,
			body: text.slice(match.index, end).trim(),
			metadata: {heading_level: level},
			order: startOrder + entries.length,
		})
	}
	return entries
}

async function loadRoadmapEntries(cwd: string, roadmapId: string, startOrder: number): Promise<ContextEntry[]> {
	const filePath = roadmapDocPath(cwd, roadmapId)
	if (!(await fileExists(filePath))) return []
	const doc = parseMarkdownDocument<Record<string, unknown>>(await readText(filePath))
	return parseHeadingEntries('roadmap', filePath, doc.body, startOrder)
}

async function loadPlanEntries(
	cwd: string,
	roadmapId: string,
	milestoneId: string | undefined,
	changeRequestId: string | undefined,
	startOrder: number,
): Promise<ContextEntry[]> {
	if (!milestoneId) return []
	const filePath = changeRequestId
		? changeRequestPath(cwd, roadmapId, milestoneId, changeRequestId)
		: milestonePlanPath(cwd, roadmapId, milestoneId)
	if (!(await fileExists(filePath))) return []
	const doc = parseMarkdownDocument<Record<string, unknown>>(await readText(filePath))
	const idParts = changeRequestId ? [milestoneId, changeRequestId] : [milestoneId]
	return parseHeadingEntries('plan', filePath, doc.body, startOrder, idParts)
}

async function loadNoteEntries(cwd: string, roadmapId: string, startOrder: number): Promise<ContextEntry[]> {
	const milestonesDir = path.join(roadmapDir(cwd, roadmapId), 'milestones')
	let milestoneIds: string[]
	try {
		const dirents = await fs.readdir(milestonesDir, {withFileTypes: true})
		milestoneIds = dirents
		.filter((dirent) => dirent.isDirectory())
		.map((dirent) => dirent.name)
		.sort((a, b) => a.localeCompare(b))
	} catch {
		return []
	}

	const entries: ContextEntry[] = []
	for (const milestoneId of milestoneIds) {
		const filePath = milestoneNotesPath(cwd, roadmapId, milestoneId)
		if (!(await fileExists(filePath))) continue
		entries.push(...parseNoteEntries(filePath, milestoneId, await readText(filePath), startOrder + entries.length))
	}
	return entries
}

export async function loadContextEntries(
	cwd: string,
	artifacts: ContextArtifact[],
): Promise<{ roadmapId?: string; entries: ContextEntry[] }> {
	const active = await loadActive(cwd)
	if (!active) return {entries: []}

	const entries: ContextEntry[] = []
	if (artifacts.includes('notes')) {
		entries.push(...(await loadNoteEntries(cwd, active.roadmap_id, entries.length)))
	}
	if (artifacts.includes('roadmap')) {
		entries.push(...(await loadRoadmapEntries(cwd, active.roadmap_id, entries.length)))
	}
	if (artifacts.includes('plan')) {
		entries.push(...(await loadPlanEntries(
			cwd,
			active.roadmap_id,
			active.milestone_id,
			active.change_request_id,
			entries.length,
		)))
	}
	if (artifacts.includes('decisions')) {
		const filePath = decisionsPath(cwd, active.roadmap_id)
		if (await fileExists(filePath)) {
			entries.push(...parseHeadingEntries('decisions', filePath, await readText(filePath), entries.length))
		}
	}
	if (artifacts.includes('risks')) {
		const filePath = risksPath(cwd, active.roadmap_id)
		if (await fileExists(filePath)) {
			entries.push(...parseHeadingEntries('risks', filePath, await readText(filePath), entries.length))
		}
	}
	return {roadmapId: active.roadmap_id, entries}
}
