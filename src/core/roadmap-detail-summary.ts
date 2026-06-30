import { nextAction } from "./report";
import { loadState } from "./store";
import type {
  ChangeRequest,
  LoadedState,
  MilestonePlan,
  TaskPlan,
  ValidationIssue,
  ValidationResult,
  WavePlan,
} from "./types";
import type { RoadmapUsageSummary, UsageScopeSummary, UsageTotals } from "./usage";
import { validateImplementationGate, validateRoadmapState } from "./validation";

export const NO_ACTIVE_ROADMAP_MESSAGE =
  "No active roadmap. Run /roadmap:new to start a gated roadmap workflow.";

export type RoadmapDetailSummary = EmptyRoadmapDetailSummary | ActiveRoadmapDetailSummary;

export interface EmptyRoadmapDetailSummary {
  kind: "empty";
  message: string;
}

export interface ActiveRoadmapDetailSummary {
  kind: "active";
  roadmap: {
    id: string;
    title: string;
    phase: string;
    label: string;
  };
  active: {
    milestone: RoadmapDetailReference | null;
    changeRequest: RoadmapDetailReference | null;
  };
  bypass: {
    active: boolean;
    label: string;
    reason?: string;
    requestedBy?: string;
  };
  qualityGate: RoadmapDetailQualityGate;
  validation: RoadmapDetailCheck;
  gate: RoadmapDetailCheck;
  nextAction: string;
  waves: RoadmapDetailWaves;
  activeTasks: RoadmapDetailTask[];
  blockers: RoadmapDetailBlocker[];
  usage: RoadmapDetailUsage | null;
}

export interface RoadmapDetailReference {
  id: string;
  title: string;
  status: string;
  label: string;
}

export interface RoadmapDetailQualityGate {
  gate: "roadmap_milestone_check";
  status: "pending" | "passed" | "failed" | "stale";
  label: string;
  roadmapRevision: number;
  checkedRevision: number;
  roadmapContentHash: string;
  checkedContentHash: string;
  latestFinding?: string;
  eventId?: string;
}

export interface RoadmapDetailCheck {
  valid: boolean;
  status: "valid" | "invalid" | "open" | "closed";
  errors: RoadmapDetailIssue[];
  warnings: RoadmapDetailIssue[];
  issues: RoadmapDetailIssue[];
}

export interface RoadmapDetailIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  label: string;
  path?: string;
}

export interface RoadmapDetailWaves {
  total: number;
  counts: {
    pending: number;
    running: number;
    reviewing: number;
    blocked: number;
    complete: number;
  };
  active: RoadmapDetailWave | null;
}

export interface RoadmapDetailWave {
  id: string;
  status: string;
  goal: string;
  label: string;
}

export interface RoadmapDetailTask {
  id: string;
  worker: string;
  status: string;
  title: string;
  label: string;
}

export interface RoadmapDetailBlocker {
  source: "progress" | "wave" | "task";
  label: string;
  message: string;
  id?: string;
}

export interface RoadmapDetailUsage {
  roadmap: RoadmapDetailUsageTotals;
  topAgents: RoadmapDetailUsageAgent[];
  topAgentsLabel: string;
  milestone?: {
    id: string;
    totals: RoadmapDetailUsageTotals;
    topAgents: RoadmapDetailUsageAgent[];
    topAgentsLabel: string;
  };
  changeRequest?: {
    id: string;
    totals: RoadmapDetailUsageTotals;
    topAgents: RoadmapDetailUsageAgent[];
    topAgentsLabel: string;
  };
}

export interface RoadmapDetailUsageTotals {
  raw: UsageTotals;
  label: string;
  costLabel: string;
  totalTokens: number;
}

export interface RoadmapDetailUsageAgent {
  agent: string;
  totals: RoadmapDetailUsageTotals;
  label: string;
}

type PlanContext = {
  plan: MilestonePlan | ChangeRequest;
  tasks: TaskPlan[];
  waves: WavePlan[];
};

export async function buildRoadmapDetailSummary(cwd: string): Promise<RoadmapDetailSummary> {
  const state = await loadState(cwd);
  if (!state.active || !state.roadmap) {
    return { kind: "empty", message: NO_ACTIVE_ROADMAP_MESSAGE };
  }

  const validation = await validateRoadmapState(cwd);
  const gate = await validateImplementationGate(cwd);
  const context = activePlanContext(state);

  return {
    kind: "active",
    roadmap: {
      id: state.roadmap.roadmap_id,
      title: state.roadmap.title,
      phase: state.roadmap.phase,
      label: `${state.roadmap.roadmap_id} (${state.roadmap.title})`,
    },
    active: {
      milestone: referenceFromPlan(state.active.milestone_id, state.milestone),
      changeRequest: referenceFromPlan(state.active.change_request_id, state.changeRequest),
    },
    bypass: bypassSummary(state),
    qualityGate: qualityGateSummary(state.roadmap),
    validation: checkSummary(validation, validation.valid ? "valid" : "invalid"),
    gate: checkSummary(gate, gate.valid ? "open" : "closed"),
    nextAction: await nextAction(cwd),
    waves: wavesSummary(context),
    activeTasks: activeTasksSummary(context),
    blockers: blockerSummary(context),
    usage: usageSummary(state.usage, state.active.milestone_id, state.active.change_request_id),
  };
}

function qualityGateSummary(roadmap: LoadedState["roadmap"]): RoadmapDetailQualityGate {
  if (!roadmap) throw new Error("Expected active roadmap");
  const check = roadmap.roadmap_milestone_check;
  const stale = check.status !== "pending" && (
    check.roadmap_revision !== roadmap.roadmap_revision ||
    check.roadmap_content_hash !== roadmap.roadmap_content_hash
  );
  const status = stale ? "stale" : check.status;
  return {
    gate: "roadmap_milestone_check",
    status,
    label: `${status} (checked revision ${check.roadmap_revision}, current revision ${roadmap.roadmap_revision})`,
    roadmapRevision: roadmap.roadmap_revision,
    checkedRevision: check.roadmap_revision,
    roadmapContentHash: roadmap.roadmap_content_hash,
    checkedContentHash: check.roadmap_content_hash,
    ...(check.findings[0] ? { latestFinding: check.findings[0] } : {}),
    ...(check.event_id ? { eventId: check.event_id } : {}),
  };
}

function activePlanContext(state: LoadedState): PlanContext | undefined {
  const plan = state.changeRequest ?? state.milestone;
  if (!plan) return undefined;
  return { plan, tasks: plan.tasks, waves: plan.waves };
}

function referenceFromPlan(
  id: string | undefined,
  plan: MilestonePlan | ChangeRequest | undefined,
): RoadmapDetailReference | null {
  if (!id) return null;
  if (!plan) {
    return {
      id,
      title: "missing",
      status: "missing",
      label: `${id} (missing)`,
    };
  }
  return {
    id,
    title: plan.title,
    status: plan.status,
    label: `${id} - ${plan.title} (${plan.status})`,
  };
}

function bypassSummary(state: LoadedState): ActiveRoadmapDetailSummary["bypass"] {
  const bypass = state.roadmap?.bypass;
  if (!bypass?.active) return { active: false, label: "inactive" };
  return {
    active: true,
    label: bypass.reason,
    reason: bypass.reason,
    requestedBy: bypass.requested_by,
  };
}

function checkSummary(
  result: ValidationResult,
  status: RoadmapDetailCheck["status"],
): RoadmapDetailCheck {
  const errors = result.errors.map((issue) => issueSummary("error", issue));
  const warnings = result.warnings.map((issue) => issueSummary("warning", issue));
  return {
    valid: result.valid,
    status,
    errors,
    warnings,
    issues: [...errors, ...warnings],
  };
}

function issueSummary(severity: RoadmapDetailIssue["severity"], issue: ValidationIssue): RoadmapDetailIssue {
  return {
    severity,
    code: issue.code,
    message: issue.message,
    label: `${severity.toUpperCase()} ${issue.code}: ${issue.message}`,
    ...(issue.path ? { path: issue.path } : {}),
  };
}

function wavesSummary(context: PlanContext | undefined): RoadmapDetailWaves {
  const counts = {
    pending: 0,
    running: 0,
    reviewing: 0,
    blocked: 0,
    complete: 0,
  };
  if (!context) return { total: 0, counts, active: null };

  for (const wave of context.waves) counts[wave.status] += 1;
  const activeWave = context.plan.progress.active_wave_id
    ? context.waves.find((wave) => wave.id === context.plan.progress.active_wave_id)
    : undefined;

  return {
    total: context.waves.length,
    counts,
    active: activeWave
      ? {
        id: activeWave.id,
        status: activeWave.status,
        goal: activeWave.goal,
        label: `${activeWave.id} (${activeWave.status})`,
      }
      : null,
  };
}

function activeTasksSummary(context: PlanContext | undefined): RoadmapDetailTask[] {
  if (!context) return [];
  return context.plan.progress.active_task_ids.map((taskId) => {
    const task = context.tasks.find((candidate) => candidate.id === taskId);
    return {
      id: taskId,
      worker: task?.worker ?? "unknown",
      status: task?.status ?? "missing",
      title: task?.title ?? taskId,
      label: task ? `${task.worker} ${task.status}: ${task.title}` : `${taskId} (missing)`,
    };
  });
}

function blockerSummary(context: PlanContext | undefined): RoadmapDetailBlocker[] {
  if (!context) return [];

  const blockers: RoadmapDetailBlocker[] = [];
  if (context.plan.progress.blocked_reason) {
    blockers.push({
      source: "progress",
      label: "Progress blocker",
      message: context.plan.progress.blocked_reason,
    });
  }

  for (const wave of context.waves) {
    if (wave.status !== "blocked") continue;
    blockers.push({
      source: "wave",
      id: wave.id,
      label: `Blocked wave ${wave.id}`,
      message: wave.goal,
    });
  }

  for (const task of context.tasks) {
    if (task.status !== "blocked") continue;
    blockers.push({
      source: "task",
      id: task.id,
      label: `Blocked task ${task.id}`,
      message: task.title,
    });
  }

  return blockers;
}

function usageSummary(
  usage: RoadmapUsageSummary | undefined,
  milestoneId: string | undefined,
  changeRequestId: string | undefined,
): RoadmapDetailUsage | null {
  if (!usage) return null;

  const summary: RoadmapDetailUsage = {
    roadmap: usageTotalsSummary(usage.total),
    topAgents: topAgents(usage),
    topAgentsLabel: topAgentsLabel(usage),
  };

  if (milestoneId) {
    const milestone = usage.milestones[milestoneId];
    if (milestone) {
      summary.milestone = {
        id: milestoneId,
        totals: usageTotalsSummary(milestone.total),
        topAgents: topAgents(milestone),
        topAgentsLabel: topAgentsLabel(milestone),
      };
      if (changeRequestId) {
        const change = milestone.change_requests[changeRequestId];
        if (change) {
          summary.changeRequest = {
            id: changeRequestId,
            totals: usageTotalsSummary(change.total),
            topAgents: topAgents(change),
            topAgentsLabel: topAgentsLabel(change),
          };
        }
      }
    }
  }

  return summary;
}

function usageTotalsSummary(totals: UsageTotals): RoadmapDetailUsageTotals {
  return {
    raw: totals,
    label: formatUsage(totals),
    costLabel: formatUsd(totals),
    totalTokens: totalTokens(totals),
  };
}

function topAgents(scope: UsageScopeSummary): RoadmapDetailUsageAgent[] {
  return Object.entries(scope.by_agent)
    .sort(([, left], [, right]) =>
      right.estimated_usd - left.estimated_usd ||
      totalTokens(right) - totalTokens(left),
    )
    .slice(0, 3)
    .map(([agent, totals]) => ({
      agent,
      totals: usageTotalsSummary(totals),
      label: `${agent}: ${formatUsage(totals)}`,
    }));
}

function topAgentsLabel(scope: UsageScopeSummary): string {
  const agents = topAgents(scope);
  return agents.length > 0 ? agents.map((agent) => agent.label).join(" | ") : "none";
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
