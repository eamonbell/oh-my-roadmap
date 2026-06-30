import { readRoadmapEvents } from "./events";
import { applyNextAction, nextActionPlan, type NextActionPlan } from "./report";
import { listQualityGates, loadRoadmapBlockers, loadState } from "./store";
import type {
  ChangeRequest,
  LoadedState,
  MilestonePlan,
  RoadmapEvent,
  RoadmapBlocker,
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
  roadmapHealth: RoadmapDetailHealth;
  nextAction: NextActionPlan;
  waves: RoadmapDetailWaves;
  activeExecution: RoadmapDetailActiveExecution | null;
  activeTasks: RoadmapDetailTask[];
  blockers: RoadmapDetailBlocker[];
  canonicalBlockers: RoadmapDetailCanonicalBlockers;
  recentEvents: RoadmapDetailEvent[];
  availableControls: RoadmapDetailControl[];
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
  history: RoadmapDetailEvent[];
}

export interface RoadmapDetailHealth {
  status: "healthy" | "attention" | "blocked";
  label: string;
  activePhase: string;
  validationStatus: RoadmapDetailCheck["status"];
  implementationGateStatus: RoadmapDetailCheck["status"];
  qualityGateStatus: RoadmapDetailQualityGate["status"];
  openBlockerCount: number;
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

export interface RoadmapDetailActiveExecution {
  activeWave: RoadmapDetailWave | null;
  progressStep: string;
  activeTasks: RoadmapDetailTask[];
  waveCounts: RoadmapDetailWaves["counts"];
  taskCounts: {
    assigned: number;
    started: number;
    done: number;
    blocked: number;
  };
}

export interface RoadmapDetailBlocker {
  source: "canonical" | "progress" | "wave" | "task";
  label: string;
  message: string;
  id?: string;
  status?: string;
  severity?: string;
}

export interface RoadmapDetailCanonicalBlockers {
  counts: {
    open: number;
    resolved: number;
    deferred: number;
  };
  open: RoadmapDetailCanonicalBlocker[];
}

export interface RoadmapDetailCanonicalBlocker {
  id: string;
  title: string;
  status: RoadmapBlocker["status"];
  severity: RoadmapBlocker["severity"];
  scope: {
    roadmapId: string;
    milestoneId?: string;
    changeRequestId?: string;
    taskId?: string;
    waveId?: string;
  };
  label: string;
}

export interface RoadmapDetailEvent {
  id: string;
  at: string;
  type: string;
  actor: string;
  summary: string;
  label: string;
}

export type RoadmapDetailControlAction = "apply_next_action" | "insert_tool_call" | "insert_prompt";

export interface RoadmapDetailControl {
  key: string;
  label: string;
  action: RoadmapDetailControlAction;
  enabled: boolean;
  reason?: string;
  tool?: {
    name: string;
    input: Record<string, unknown>;
  };
  prompt?: string;
}

export type RoadmapDetailControlResult =
  | {
    action: "applied_next_action";
    control: RoadmapDetailControl;
    result: Awaited<ReturnType<typeof applyNextAction>>;
  }
  | {
    action: "insert_prompt";
    control: RoadmapDetailControl;
    prompt: string;
  };

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
  const canonicalBlockers = await loadRoadmapBlockers(cwd, state.roadmap.roadmap_id);
  const openCanonicalBlockers = canonicalBlockers.filter((blocker) => blocker.status === "open");
  const qualityGateHistory = (await listQualityGates(cwd, {
    roadmapId: state.roadmap.roadmap_id,
    gate: "roadmap_milestone_check",
    limit: 3,
  })).history.map(eventSummary).reverse();
  const events = (await readRoadmapEvents(cwd, {
    roadmapId: state.roadmap.roadmap_id,
    limit: 6,
  })).events.map(eventSummary).reverse();
  const qualityGate = qualityGateSummary(state.roadmap, qualityGateHistory);
  const validationSummary = checkSummary(validation, validation.valid ? "valid" : "invalid");
  const gateSummary = checkSummary(gate, gate.valid ? "open" : "closed");
  const waves = wavesSummary(context);
  const activeTasks = activeTasksSummary(context);
  const next = await nextActionPlan(cwd);
  const canonicalBlockerDetails = canonicalBlockersSummary(canonicalBlockers);

  const summary: ActiveRoadmapDetailSummary = {
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
    qualityGate,
    validation: validationSummary,
    gate: gateSummary,
    roadmapHealth: roadmapHealthSummary(state, qualityGate, validationSummary, gateSummary, openCanonicalBlockers.length),
    nextAction: next,
    waves,
    activeExecution: activeExecutionSummary(context, waves, activeTasks),
    activeTasks,
    blockers: blockerSummary(context, canonicalBlockers),
    canonicalBlockers: canonicalBlockerDetails,
    recentEvents: events,
    availableControls: [],
    usage: usageSummary(state.usage, state.active.milestone_id, state.active.change_request_id),
  };

  summary.availableControls = availableControls(summary);
  return summary;
}

export async function applyRoadmapDetailControl(cwd: string, key: string): Promise<RoadmapDetailControlResult> {
  const summary = await buildRoadmapDetailSummary(cwd);
  if (summary.kind !== "active") throw new Error("No active roadmap control is available");
  const control = summary.availableControls.find((candidate) => candidate.key === key);
  if (!control) throw new Error(`Unknown roadmap detail control: ${key}`);
  if (!control.enabled) throw new Error(`Roadmap detail control ${key} is disabled: ${control.reason ?? control.label}`);

  if (control.action === "apply_next_action") {
    const actionId = typeof control.tool?.input.actionId === "string" ? control.tool.input.actionId : "";
    const result = await applyNextAction(cwd, actionId);
    return { action: "applied_next_action", control, result };
  }

  if (!control.prompt) throw new Error(`Roadmap detail control ${key} has no prompt to insert`);
  return { action: "insert_prompt", control, prompt: control.prompt };
}

function qualityGateSummary(
  roadmap: LoadedState["roadmap"],
  history: RoadmapDetailEvent[],
): RoadmapDetailQualityGate {
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
    history,
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

function roadmapHealthSummary(
  state: LoadedState,
  qualityGate: RoadmapDetailQualityGate,
  validation: RoadmapDetailCheck,
  gate: RoadmapDetailCheck,
  openBlockerCount: number,
): RoadmapDetailHealth {
  const status = openBlockerCount > 0 || gate.status === "closed"
    ? "blocked"
    : validation.status === "invalid" || qualityGate.status !== "passed"
      ? "attention"
      : "healthy";
  return {
    status,
    label: `${status}; ${openBlockerCount} open blocker${openBlockerCount === 1 ? "" : "s"}`,
    activePhase: state.roadmap?.phase ?? "none",
    validationStatus: validation.status,
    implementationGateStatus: gate.status,
    qualityGateStatus: qualityGate.status,
    openBlockerCount,
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

function activeExecutionSummary(
  context: PlanContext | undefined,
  waves: RoadmapDetailWaves,
  activeTasks: RoadmapDetailTask[],
): RoadmapDetailActiveExecution | null {
  if (!context) return null;
  const taskCounts = {
    assigned: 0,
    started: 0,
    done: 0,
    blocked: 0,
  };
  for (const task of context.tasks) taskCounts[task.status] += 1;
  return {
    activeWave: waves.active,
    progressStep: context.plan.progress.step,
    activeTasks,
    waveCounts: waves.counts,
    taskCounts,
  };
}

function blockerSummary(context: PlanContext | undefined, canonicalBlockers: RoadmapBlocker[]): RoadmapDetailBlocker[] {
  const blockers: RoadmapDetailBlocker[] = [];
  for (const blocker of canonicalBlockers) {
    if (blocker.status !== "open") continue;
    blockers.push({
      source: "canonical",
      id: blocker.id,
      label: `Open ${blocker.severity} blocker ${blocker.id}`,
      message: blocker.title,
      status: blocker.status,
      severity: blocker.severity,
    });
  }

  if (!context) return blockers;

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

function canonicalBlockersSummary(blockers: RoadmapBlocker[]): RoadmapDetailCanonicalBlockers {
  const counts = {
    open: 0,
    resolved: 0,
    deferred: 0,
  };
  for (const blocker of blockers) counts[blocker.status] += 1;
  return {
    counts,
    open: blockers.filter((blocker) => blocker.status === "open").map(canonicalBlockerSummary),
  };
}

function canonicalBlockerSummary(blocker: RoadmapBlocker): RoadmapDetailCanonicalBlocker {
  return {
    id: blocker.id,
    title: blocker.title,
    status: blocker.status,
    severity: blocker.severity,
    scope: {
      roadmapId: blocker.roadmap_id,
      ...(blocker.milestone_id ? { milestoneId: blocker.milestone_id } : {}),
      ...(blocker.change_request_id ? { changeRequestId: blocker.change_request_id } : {}),
      ...(blocker.task_id ? { taskId: blocker.task_id } : {}),
      ...(blocker.wave_id ? { waveId: blocker.wave_id } : {}),
    },
    label: `${blocker.id} ${blocker.severity}: ${blocker.title}`,
  };
}

function eventSummary(event: RoadmapEvent): RoadmapDetailEvent {
  return {
    id: event.id,
    at: event.at,
    type: event.type,
    actor: event.actor,
    summary: event.summary,
    label: `${event.type} ${event.id}: ${event.summary}`,
  };
}

function availableControls(summary: ActiveRoadmapDetailSummary): RoadmapDetailControl[] {
  return [
    safeNextActionControl(summary.nextAction),
    approvalControl(summary.nextAction),
    waveDispatchControl(summary),
    waveReviewControl(summary),
    checkerControl(summary),
    blockerControl(summary),
  ];
}

function safeNextActionControl(next: NextActionPlan): RoadmapDetailControl {
  const enabled = next.status === "ready" && next.safe_to_apply;
  return {
    key: "a",
    label: "Apply safe next action",
    action: "apply_next_action",
    enabled,
    ...(enabled ? {} : { reason: `Next action is ${next.status} and safe_to_apply=${next.safe_to_apply}` }),
    tool: {
      name: "roadmap_engineer_apply_next_action",
      input: { actionId: next.id },
    },
    prompt: toolPrompt("roadmap_engineer_apply_next_action", { actionId: next.id }),
  };
}

function approvalControl(next: NextActionPlan): RoadmapDetailControl {
  const enabled = next.status === "approval_required";
  return {
    key: "p",
    label: "Ask for required approval",
    action: "insert_prompt",
    enabled,
    ...(enabled ? {} : { reason: "Next action does not require approval" }),
    prompt: `Ask the user for explicit approval before changing roadmap state:
${next.description}`,
  };
}

function waveDispatchControl(summary: ActiveRoadmapDetailSummary): RoadmapDetailControl {
  const input = targetInput(summary);
  const enabled = !!summary.activeExecution?.activeWave &&
    summary.activeExecution.progressStep === "not_started" &&
    summary.gate.status === "open" &&
    summary.canonicalBlockers.counts.open === 0;
  return {
    key: "d",
    label: "Prepare wave dispatch",
    action: "insert_tool_call",
    enabled,
    ...(enabled ? {} : { reason: "No dispatchable active wave" }),
    tool: { name: "roadmap_engineer_prepare_wave_dispatch", input },
    prompt: `${toolPrompt("roadmap_engineer_prepare_wave_dispatch", input)}

Dispatch only the returned assignments with the built-in task/subagent mechanism. Do not spawn workers directly from the dashboard.`,
  };
}

function waveReviewControl(summary: ActiveRoadmapDetailSummary): RoadmapDetailControl {
  const input = targetInput(summary);
  const enabled = !!summary.activeExecution?.activeWave && summary.activeExecution.progressStep === "wave_review";
  return {
    key: "r",
    label: "Prepare wave review",
    action: "insert_tool_call",
    enabled,
    ...(enabled ? {} : { reason: "Active progress is not at wave_review" }),
    tool: { name: "roadmap_engineer_prepare_wave_review", input },
    prompt: `${toolPrompt("roadmap_engineer_prepare_wave_review", input)}

Dispatch only the returned reviewer package with the built-in task/subagent mechanism. Do not perform the review in the dashboard.`,
  };
}

function checkerControl(summary: ActiveRoadmapDetailSummary): RoadmapDetailControl {
  const waveFlowCheck = summary.nextAction.id.includes("wave-flow-check");
  const roadmapCheck = summary.nextAction.id.includes("milestone-check") || summary.qualityGate.status !== "passed";
  const enabled = waveFlowCheck || roadmapCheck;
  const prompt = waveFlowCheck
    ? `Dispatch wave-flow-checker for the active plan. After the checker returns, record the result with:
${toolPrompt("roadmap_engineer_transition", {
  operation: "record_wave_flow_check",
  waveFlowCheck: {
    status: "passed",
    checkedBy: "wave-flow-checker",
    summary: "<checker summary>",
    findings: [],
  },
})}`
    : `Dispatch roadmap-milestone-checker for roadmap ${summary.roadmap.id}. After the checker returns, record the result with:
${toolPrompt("roadmap_engineer_transition", {
  operation: "record_roadmap_milestone_check",
  roadmapMilestoneCheck: {
    status: "passed",
    checkedBy: "roadmap-milestone-checker",
    summary: "<checker summary>",
    findings: [],
  },
})}`;
  return {
    key: "c",
    label: "Checker rerun instructions",
    action: "insert_prompt",
    enabled,
    ...(enabled ? {} : { reason: "No checker rerun is pending" }),
    prompt,
  };
}

function blockerControl(summary: ActiveRoadmapDetailSummary): RoadmapDetailControl {
  const blockers = summary.canonicalBlockers.open;
  const enabled = blockers.length > 0;
  const prompt = blockers.length === 0
    ? "No open canonical blockers."
    : blockers.map((blocker) => `For blocker ${blocker.id} (${blocker.title}), use one of:
${toolPrompt("roadmap_engineer_resolve_blocker", {
  roadmapId: blocker.scope.roadmapId,
  blockerId: blocker.id,
  resolution: "<resolution>",
})}
${toolPrompt("roadmap_engineer_defer_blocker", {
  roadmapId: blocker.scope.roadmapId,
  blockerId: blocker.id,
  deferReason: "<defer reason>",
})}`).join("\n\n");
  return {
    key: "b",
    label: "Blocker resolve/defer templates",
    action: "insert_prompt",
    enabled,
    ...(enabled ? {} : { reason: "No open canonical blockers" }),
    prompt,
  };
}

function targetInput(summary: ActiveRoadmapDetailSummary): Record<string, unknown> {
  return {
    roadmapId: summary.roadmap.id,
    ...(summary.active.milestone?.id ? { milestoneId: summary.active.milestone.id } : {}),
    ...(summary.active.changeRequest?.id ? { changeRequestId: summary.active.changeRequest.id } : {}),
  };
}

function toolPrompt(name: string, input: Record<string, unknown>): string {
  return `Call ${name} with input:
${JSON.stringify(input, null, 2)}`;
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
