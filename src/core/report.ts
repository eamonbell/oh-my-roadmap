import { loadRoadmapBlockers, loadState } from "./store";
import type { ImplementationProgress, RoadmapState, TaskPlan, WavePlan } from "./types";
import type { RoadmapUsageSummary, UsageScopeSummary, UsageTotals } from "./usage";
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

function totalTokens(usage: UsageTotals): number {
  return usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
}

function formatUsd(usage: UsageTotals): string {
  const value = `$${usage.estimated_usd.toFixed(4)}`;
  return usage.usd_unavailable ? `${value} + unknown` : value;
}

function formatUsage(usage: UsageTotals): string {
  return [
    formatUsd(usage),
    `${usage.requests} req`,
    `${totalTokens(usage)} tok`,
    `in ${usage.input_tokens}`,
    `out ${usage.output_tokens}`,
    `cache ${usage.cache_read_tokens}/${usage.cache_write_tokens}`,
    `reasoning ${usage.reasoning_tokens}`,
  ].join(", ");
}

function topAgents(scope: UsageScopeSummary): string {
  const agents = Object.entries(scope.by_agent)
    .sort(([, left], [, right]) =>
      right.estimated_usd - left.estimated_usd ||
      totalTokens(right) - totalTokens(left),
    )
    .slice(0, 3)
    .map(([agent, usage]) => `${agent}: ${formatUsage(usage)}`);
  return agents.length > 0 ? agents.join(" | ") : "none";
}

function usageLines(stateUsage: RoadmapUsageSummary | undefined, milestoneId?: string, changeRequestId?: string): string[] {
  if (!stateUsage) return [];
  const lines = [
    `Usage roadmap: ${formatUsage(stateUsage.total)}`,
    `Usage top agents: ${topAgents(stateUsage)}`,
  ];
  if (milestoneId) {
    const milestone = stateUsage.milestones[milestoneId];
    lines.push(
      `Usage milestone ${milestoneId}: ${milestone ? formatUsage(milestone.total) : formatUsage({
        estimated_usd: 0,
        usd_unavailable: false,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
      })}`,
    );
    if (milestone) lines.push(`Usage milestone top agents: ${topAgents(milestone)}`);
    if (changeRequestId) {
      const change = milestone?.change_requests[changeRequestId];
      lines.push(`Usage change ${changeRequestId}: ${change ? formatUsage(change.total) : "none"}`);
      if (change) lines.push(`Usage change top agents: ${topAgents(change)}`);
    }
  }
  return lines;
}

function hasPlannableMilestone(state: Awaited<ReturnType<typeof loadState>>): boolean {
  return state.roadmap?.milestones.some((milestone) => ["planned", "blocked"].includes(milestone.status)) ?? false;
}

function roadmapMilestoneCheckLabel(roadmap: RoadmapState): string {
  const check = roadmap.roadmap_milestone_check;
  const stale = check.status !== "pending" && (
    check.roadmap_revision !== roadmap.roadmap_revision ||
    check.roadmap_content_hash !== roadmap.roadmap_content_hash
  );
  const status = stale ? "stale" : check.status;
  return `${status} (checked revision ${check.roadmap_revision}, current revision ${roadmap.roadmap_revision})`;
}

function roadmapCheckNextAction(roadmap: RoadmapState): string | undefined {
  const check = roadmap.roadmap_milestone_check;
  if (!roadmap.roadmap_finalized || roadmap.phase !== "roadmap_draft") return undefined;
  if (check.status === "pending") {
    return `Dispatch roadmap-milestone checker for revision ${roadmap.roadmap_revision}.`;
  }
  if (check.roadmap_revision !== roadmap.roadmap_revision || check.roadmap_content_hash !== roadmap.roadmap_content_hash) {
    return `Rerun roadmap-milestone checker: checked revision ${check.roadmap_revision}, current revision ${roadmap.roadmap_revision}.`;
  }
  if (check.status === "failed") {
    const finding = check.findings[0] ? ` Latest finding: ${check.findings[0]}` : "";
    return `Revise roadmap, regenerate roadmap.md, then rerun roadmap-milestone checker.${finding}`;
  }
  return undefined;
}

export async function renderReport(cwd: string): Promise<string> {
  const state = await loadState(cwd);
  if (!state.active || !state.roadmap) {
    return "No active roadmap. Run /roadmap:new to start a gated roadmap workflow.";
  }

  const validation = await validateRoadmapState(cwd);
  const gate = await validateImplementationGate(cwd);
  const blockers = await loadRoadmapBlockers(cwd, state.roadmap.roadmap_id);
  const openBlockers = blockers.filter((blocker) => blocker.status === "open");
  const lines = [
    `# roadmap-engineer status`,
    ``,
    `Roadmap: ${state.roadmap.roadmap_id} (${state.roadmap.title})`,
    `Phase: ${state.roadmap.phase}`,
    `Roadmap milestone check: ${roadmapMilestoneCheckLabel(state.roadmap)}`,
    `Active milestone: ${state.active.milestone_id ?? "none"}`,
    `Active change request: ${state.active.change_request_id ?? "none"}`,
    `Bypass: ${state.roadmap.bypass?.active ? state.roadmap.bypass.reason : "inactive"}`,
    `Open blockers: ${openBlockers.length > 0 ? openBlockers.map((blocker) => `${blocker.id}:${blocker.severity}`).join(", ") : "none"}`,
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
  lines.push(...usageLines(state.usage, state.active.milestone_id, state.active.change_request_id));

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
  const roadmapCheckAction = roadmapCheckNextAction(state.roadmap);
  if (roadmapCheckAction) return roadmapCheckAction;
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
      if (hasPlannableMilestone(state)) {
        return "Start the next planned milestone with /milestone:plan or create a post-implementation change request.";
      }
      return "Create a post-implementation change request or start a new roadmap.";
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
