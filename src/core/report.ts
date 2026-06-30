import { loadState } from "./store";
import type { ImplementationProgress, TaskPlan, WavePlan } from "./types";
import { validateImplementationGate, validateRoadmapState } from "./validation";

function progressLines(label: string, progress: ImplementationProgress, waves: WavePlan[], tasks: TaskPlan[]): string[] {
  const activeWave = progress.active_wave_id
    ? waves.find((wave) => wave.id === progress.active_wave_id)
    : undefined;
  const activeTasks = progress.active_task_ids
    .map((taskId) => tasks.find((task) => task.id === taskId)?.title ?? taskId)
    .join(", ");

  return [
    `${label} active wave: ${progress.active_wave_id ?? "none"}${activeWave ? ` (${activeWave.status})` : ""}`,
    `${label} progress: ${progress.step}`,
    `${label} active tasks: ${activeTasks || "none"}`,
    `${label} blocker: ${progress.blocked_reason ?? "none"}`,
  ];
}

export async function renderReport(cwd: string): Promise<string> {
  const state = await loadState(cwd);
  if (!state.active || !state.roadmap) {
    return "No active roadmap. Run /roadmap:new to start a gated roadmap workflow.";
  }

  const validation = await validateRoadmapState(cwd);
  const gate = await validateImplementationGate(cwd);
  const lines = [
    `# roadmap-engineer status`,
    ``,
    `Roadmap: ${state.roadmap.roadmap_id} (${state.roadmap.title})`,
    `Phase: ${state.roadmap.phase}`,
    `Active milestone: ${state.active.milestone_id ?? "none"}`,
    `Active change request: ${state.active.change_request_id ?? "none"}`,
    `Bypass: ${state.roadmap.bypass?.active ? state.roadmap.bypass.reason : "inactive"}`,
  ];

  if (state.milestone) {
    lines.push(
      `Milestone status: ${state.milestone.status}`,
      `Waves: ${state.milestone.waves.map((wave) => `${wave.id}:${wave.status}`).join(", ") || "none"}`,
      ...progressLines("Milestone", state.milestone.progress, state.milestone.waves, state.milestone.tasks),
    );
  }
  if (state.changeRequest) {
    lines.push(
      `Change status: ${state.changeRequest.status}`,
      `Change waves: ${state.changeRequest.waves.map((wave) => `${wave.id}:${wave.status}`).join(", ") || "none"}`,
      ...progressLines("Change", state.changeRequest.progress, state.changeRequest.waves, state.changeRequest.tasks),
      `Change closeout: ${state.changeRequest.closeout?.status ?? "not recorded"}`,
    );
  }
  if (state.closeout) lines.push(`Milestone closeout: ${state.closeout.status}`);

  lines.push(``, `Validation: ${validation.valid ? "valid" : "invalid"}`);

  for (const error of validation.errors) lines.push(`- ERROR ${error.code}: ${error.message}`);
  for (const warning of validation.warnings) lines.push(`- WARN ${warning.code}: ${warning.message}`);

  lines.push(``, `Implementation gate: ${gate.valid ? "open" : "closed"}`);
  for (const error of gate.errors) lines.push(`- ${error.message}`);
  lines.push(``, `Next action: ${await nextAction(cwd)}`);

  return lines.join("\n");
}

export async function nextAction(cwd: string): Promise<string> {
  const state = await loadState(cwd);
  if (!state.active || !state.roadmap) return "Create a roadmap with /roadmap:new.";
  const validation = await validateRoadmapState(cwd);
  if (!validation.valid) return `Resolve validation errors: ${validation.errors[0]?.message}`;
  if (state.changeRequest) {
    switch (state.changeRequest.status) {
      case "draft":
        return "Approve the change request plan before implementation.";
      case "approved":
        return "Start change implementation with /milestone:implement.";
      case "implementing":
        return progressNextAction(state.changeRequest.progress);
      case "reviewing":
        return "Review the change request and record closeout evidence.";
      case "closed":
        return "Change request is closed; continue from the current roadmap phase.";
    }
  }

  switch (state.roadmap.phase) {
    case "discovery":
      return "Record repo discovery with roadmap_engineer_transition record_discovery.";
    case "roadmap_draft":
      return "Answer all open roadmap questions, then approve the roadmap.";
    case "roadmap_approved":
      return "Plan the next milestone with /milestone:plan.";
    case "milestone_planning":
      return "Complete dependency analysis, waves, ownership, verification commands, then approve the milestone.";
    case "milestone_approved":
      return "Start implementation with /milestone:implement.";
    case "implementing":
      if (state.milestone) return progressNextAction(state.milestone.progress);
      return "Execute the current wave, append worker notes, then run wave review.";
    case "reviewing":
      return "Resolve or defer blocking findings, then continue or enter closeout.";
    case "closeout":
      return "Record structured closeout evidence, then close the milestone with /milestone:close.";
    case "complete":
      return "Start the next milestone or create a post-implementation change request.";
  }
}

function progressNextAction(progress: ImplementationProgress): string {
  const wave = progress.active_wave_id ? ` ${progress.active_wave_id}` : "";
  switch (progress.step) {
    case "not_started":
      return `Dispatch wave${wave} and update progress to dispatching.`;
    case "dispatching":
      return `Start assigned tasks for wave${wave} and update progress to workers_running.`;
    case "workers_running":
      return `Collect worker notes for active tasks, then update progress to wave_review.`;
    case "wave_review":
      return `Run review for wave${wave}; resolve blockers or mark the wave complete.`;
    case "resolving_blockers":
      return `Resolve blocker: ${progress.blocked_reason ?? "not recorded"}.`;
    case "ready_for_next_wave":
      return "Advance progress to the next wave, or mark closeout_ready if no waves remain.";
    case "closeout_ready":
      return "Enter closeout and record structured closeout evidence.";
  }
}
