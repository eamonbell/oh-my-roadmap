import * as path from "node:path";
import { ROADMAP_ROOT } from "./types";

export function roadmapsDir(cwd: string): string {
  return path.join(cwd, ROADMAP_ROOT);
}

export function storeLockPath(cwd: string): string {
  return path.join(roadmapsDir(cwd), "store.lock");
}

export function activePointerPath(cwd: string): string {
  return path.join(roadmapsDir(cwd), "active.yml");
}

export function roadmapDir(cwd: string, roadmapId: string): string {
  return path.join(roadmapsDir(cwd), roadmapId);
}

export function roadmapStatePath(cwd: string, roadmapId: string): string {
  return path.join(roadmapDir(cwd, roadmapId), "state.yml");
}

export function roadmapUsagePath(cwd: string, roadmapId: string): string {
  return path.join(roadmapDir(cwd, roadmapId), "usage.yml");
}

export function roadmapDocPath(cwd: string, roadmapId: string): string {
  return path.join(roadmapDir(cwd, roadmapId), "roadmap.md");
}

export function roadmapEventsPath(cwd: string, roadmapId: string): string {
  return path.join(roadmapDir(cwd, roadmapId), "events.ndjson");
}

export function decisionsPath(cwd: string, roadmapId: string): string {
  return path.join(roadmapDir(cwd, roadmapId), "decisions.md");
}

export function risksPath(cwd: string, roadmapId: string): string {
  return path.join(roadmapDir(cwd, roadmapId), "risks.md");
}

export function milestoneDir(cwd: string, roadmapId: string, milestoneId: string): string {
  return path.join(roadmapDir(cwd, roadmapId), "milestones", milestoneId);
}

export function milestonePlanPath(cwd: string, roadmapId: string, milestoneId: string): string {
  return path.join(milestoneDir(cwd, roadmapId, milestoneId), "plan.md");
}

export function milestoneRuntimePath(cwd: string, roadmapId: string, milestoneId: string): string {
  return path.join(milestoneDir(cwd, roadmapId, milestoneId), "runtime.yml");
}

export function milestoneNotesPath(cwd: string, roadmapId: string, milestoneId: string): string {
  return path.join(milestoneDir(cwd, roadmapId, milestoneId), "notes.md");
}

export function milestoneCloseoutPath(cwd: string, roadmapId: string, milestoneId: string): string {
  return path.join(milestoneDir(cwd, roadmapId, milestoneId), "closeout.md");
}

export function changeRequestPath(
  cwd: string,
  roadmapId: string,
  milestoneId: string,
  changeRequestId: string,
): string {
  return path.join(milestoneDir(cwd, roadmapId, milestoneId), "changes", `${changeRequestId}.md`);
}

export function changeRequestRuntimePath(
  cwd: string,
  roadmapId: string,
  milestoneId: string,
  changeRequestId: string,
): string {
  return path.join(milestoneDir(cwd, roadmapId, milestoneId), "changes", `${changeRequestId}.runtime.yml`);
}
