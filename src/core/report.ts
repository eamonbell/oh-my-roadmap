import { loadState } from "./store";
import { validateImplementationGate, validateRoadmapState } from "./validation";

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
    ``,
    `Validation: ${validation.valid ? "valid" : "invalid"}`,
  ];

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

  switch (state.roadmap.phase) {
    case "discovery":
      return "Record repo discovery and draft the roadmap.";
    case "roadmap_draft":
      return "Answer all open roadmap questions, then approve the roadmap.";
    case "roadmap_approved":
      return "Plan the next milestone with /milestone:plan.";
    case "milestone_planning":
      return "Complete dependency analysis, waves, ownership, verification commands, then approve the milestone.";
    case "milestone_approved":
      return "Start implementation with /milestone:implement.";
    case "implementing":
      return "Execute the current wave, append worker notes, then run wave review.";
    case "reviewing":
      return "Resolve or defer blocking findings, then continue or enter closeout.";
    case "closeout":
      return "Attach evidence and close the milestone with /milestone:close.";
    case "complete":
      return "Start the next milestone or create a post-implementation change request.";
  }
}
