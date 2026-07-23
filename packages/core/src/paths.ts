import * as path from 'node:path'
import { ROADMAP_ROOT } from './types'

export function roadmapsDir(cwd: string): string {
	return path.join(cwd, ROADMAP_ROOT)
}

export function storeLockPath(cwd: string): string {
	return path.join(roadmapsDir(cwd), 'store.lock')
}

// Opt-in Moshi notification trace log. One NDJSON record per line under .omr/logs/,
// written only when `moshi.trace` (or OMR_MOSHI_TRACE) is enabled.
export function moshiLogDir(cwd: string): string {
	return path.join(roadmapsDir(cwd), 'logs')
}

export function moshiLogPath(cwd: string): string {
	return path.join(moshiLogDir(cwd), 'moshi.ndjson')
}

export function activePointerPath(cwd: string): string {
	return path.join(roadmapsDir(cwd), 'active.yml')
}

// Ad-hoc plans live under .omr/adhoc/, with their own active pointer.
export function adhocDir(cwd: string): string {
	return path.join(roadmapsDir(cwd), 'adhoc')
}

export function adhocActivePointerPath(cwd: string): string {
	return path.join(adhocDir(cwd), 'active.yml')
}

export function adhocPlanDir(cwd: string, adhocId: string): string {
	return path.join(adhocDir(cwd), adhocId)
}

export function adhocPlanPath(cwd: string, adhocId: string): string {
	return path.join(adhocPlanDir(cwd, adhocId), 'plan.md')
}

export function adhocRuntimePath(cwd: string, adhocId: string): string {
	return path.join(adhocPlanDir(cwd, adhocId), 'runtime.yml')
}

export function adhocNotesPath(cwd: string, adhocId: string): string {
	return path.join(adhocPlanDir(cwd, adhocId), 'notes.md')
}

export function adhocCloseoutPath(cwd: string, adhocId: string): string {
	return path.join(adhocPlanDir(cwd, adhocId), 'closeout.md')
}

export function adhocBlockersPath(cwd: string, adhocId: string): string {
	return path.join(adhocPlanDir(cwd, adhocId), 'blockers.yml')
}

export function roadmapDir(cwd: string, roadmapId: string): string {
	return path.join(roadmapsDir(cwd), roadmapId)
}

export function roadmapStatePath(cwd: string, roadmapId: string): string {
	return path.join(roadmapDir(cwd, roadmapId), 'state.yml')
}

export function roadmapUsagePath(cwd: string, roadmapId: string): string {
	return path.join(roadmapDir(cwd, roadmapId), 'usage.yml')
}

export function roadmapDocPath(cwd: string, roadmapId: string): string {
	return path.join(roadmapDir(cwd, roadmapId), 'roadmap.md')
}

export function roadmapEventsPath(cwd: string, roadmapId: string): string {
	return path.join(roadmapDir(cwd, roadmapId), 'events.ndjson')
}

export function roadmapBlockersPath(cwd: string, roadmapId: string): string {
	return path.join(roadmapDir(cwd, roadmapId), 'blockers.yml')
}
export function roadmapBudgetPath(cwd: string, roadmapId: string): string {
	return path.join(roadmapDir(cwd, roadmapId), 'budget.yml')
}

export function roadmapScoutFindingsPath(cwd: string, roadmapId: string): string {
	return path.join(roadmapDir(cwd, roadmapId), 'scout-findings.jsonl')
}

export function decisionsPath(cwd: string, roadmapId: string): string {
	return path.join(roadmapDir(cwd, roadmapId), 'decisions.md')
}

export function risksPath(cwd: string, roadmapId: string): string {
	return path.join(roadmapDir(cwd, roadmapId), 'risks.md')
}

export function milestoneDir(cwd: string, roadmapId: string, milestoneId: string): string {
	return path.join(roadmapDir(cwd, roadmapId), 'milestones', milestoneId)
}

export function milestonePlanPath(cwd: string, roadmapId: string, milestoneId: string): string {
	return path.join(milestoneDir(cwd, roadmapId, milestoneId), 'plan.md')
}

export function milestoneRuntimePath(cwd: string, roadmapId: string, milestoneId: string): string {
	return path.join(milestoneDir(cwd, roadmapId, milestoneId), 'runtime.yml')
}

export function milestoneNotesPath(cwd: string, roadmapId: string, milestoneId: string): string {
	return path.join(milestoneDir(cwd, roadmapId, milestoneId), 'notes.md')
}

export function milestoneCloseoutPath(cwd: string, roadmapId: string, milestoneId: string): string {
	return path.join(milestoneDir(cwd, roadmapId, milestoneId), 'closeout.md')
}
export function milestoneBudgetPath(cwd: string, roadmapId: string, milestoneId: string): string {
	return path.join(milestoneDir(cwd, roadmapId, milestoneId), 'budget.yml')
}

export function changeRequestPath(
	cwd: string,
	roadmapId: string,
	milestoneId: string,
	changeRequestId: string,
): string {
	return path.join(milestoneDir(cwd, roadmapId, milestoneId), 'changes', `${changeRequestId}.md`)
}

export function changeRequestRuntimePath(
	cwd: string,
	roadmapId: string,
	milestoneId: string,
	changeRequestId: string,
): string {
	return path.join(milestoneDir(cwd, roadmapId, milestoneId), 'changes', `${changeRequestId}.runtime.yml`)
}
