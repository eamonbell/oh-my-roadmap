import * as fs from "node:fs/promises";
import {
  activePointerPath,
  changeRequestPath,
  decisionsPath,
  milestoneCloseoutPath,
  milestoneDir,
  milestoneNotesPath,
  milestonePlanPath,
  roadmapDir,
  roadmapDocPath,
  roadmapsDir,
  roadmapStatePath,
  risksPath,
} from "./paths";
import { loadUsageSummary } from "./usage";
import { withStoreWriteLock } from "./lock";
import { serializeMarkdownDocument, serializeYaml } from "./frontmatter";
import {
  appendText,
  fileExists,
  readMarkdownData,
  readText,
  readYamlFile,
  writeMarkdownData,
  writeText,
  writeYamlFile,
} from "./files";
import {
  loadMilestoneCloseout,
  openCloseoutEvidence,
  validateCloseoutEvidence,
  writeMilestoneCloseout,
} from "./closeout";
import { appendRoadmapEvent } from "./events";
import type {
  ActivePointer,
  Approval,
  ChangeRequest,
  CloseoutEvidence,
  ImplementationProgress,
  ImplementationProgressStep,
  LoadedState,
  MilestonePlan,
  Phase,
  RoadmapMilestoneOutline,
  RoadmapEventScope,
  RoadmapState,
  TaskPlan,
  WaveFlowCheck,
  WaveFlowCheckStatus,
  WavePlan,
} from "./types";

export interface InitRoadmapInput {
  roadmapId: string;
  title: string;
  summary?: string;
  discovery?: Partial<RoadmapState["discovery"]>;
}

export interface CreateMilestonePlanInput {
  milestoneId: string;
  title: string;
  verificationCommands: string[];
  acceptanceCriteria: string[];
  userInterview?: string[];
  relevantExistingCode?: string[];
  relevantDocumentation?: string[];
  decisions?: string[];
  dependencyAnalysis?: string[];
  tasks: MilestonePlan["tasks"];
  waves: MilestonePlan["waves"];
  openQuestions?: string[];
}

export interface UpdateRoadmapInput {
  goal: string;
  successCriteria: string[];
  constraints: string[];
  nonGoals: string[];
  context: string[];
  evidence: string[];
  risks: string[];
  milestones: RoadmapMilestoneOutline[];
}

export interface AppendNoteInput {
  kind: "worker" | "review" | "orchestrator" | "decision" | "issue";
  roadmapId?: string;
  milestoneId?: string;
  waveId?: string;
  taskId?: string;
  workerId?: string;
  blocking?: boolean;
  status?: "open" | "resolved" | "deferred";
  title: string;
  body: string;
}

export interface CreateChangeRequestInput {
  changeRequestId: string;
  title: string;
  request: string;
  verificationCommands: string[];
  acceptanceCriteria: string[];
  userInterview?: string[];
  relevantExistingCode?: string[];
  relevantDocumentation?: string[];
  decisions?: string[];
  dependencyAnalysis?: string[];
  tasks: ChangeRequest["tasks"];
  waves: ChangeRequest["waves"];
}

export interface UpdateImplementationProgressInput {
  activeWaveId?: string;
  step: ImplementationProgressStep;
  activeTaskIds?: string[];
  blockedReason?: string;
}

export interface WaveFlowCheckInput {
  status: WaveFlowCheckStatus;
  checkedBy?: string;
  summary?: string;
  findings?: string[];
}

export interface TransitionInput {
  operation:
    | "record_discovery"
    | "approve_roadmap"
    | "reopen_roadmap"
    | "record_roadmap_milestone_check"
    | "start_milestone_planning"
    | "create_milestone_plan"
    | "approve_milestone"
    | "update_milestone_plan"
    | "start_implementation"
    | "start_reviewing"
    | "start_closeout"
    | "complete_milestone"
    | "request_bypass"
    | "clear_bypass"
    | "approve_change"
    | "update_change_request_plan"
    | "close_change"
    | "update_task_status"
    | "update_wave_status"
    | "update_implementation_progress"
    | "record_closeout"
    | "record_wave_flow_check";
  approver?: string;
  summary?: string;
  reason?: string;
  discovery?: Partial<RoadmapState["discovery"]>;
  milestone?: CreateMilestonePlanInput;
  changeRequest?: CreateChangeRequestInput;
  taskId?: string;
  taskStatus?: TaskPlan["status"];
  waveId?: string;
  waveStatus?: WavePlan["status"];
  progress?: UpdateImplementationProgressInput;
  closeout?: CloseoutEvidence;
  waveFlowCheck?: WaveFlowCheckInput;
  roadmapMilestoneCheck?: WaveFlowCheckInput;
}

export interface AmendmentInput {
  scope: "roadmap" | "milestone";
  title: string;
  body: string;
  material: boolean;
  approvedBy?: string;
  approvalSummary?: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function assertSlug(slug: string, field: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`${field} must be a lower-case slug using letters, numbers, and hyphens`);
  }
}

function scopeFromLoaded(loaded: LoadedState): RoadmapEventScope {
  const roadmapId = loaded.active?.roadmap_id ?? loaded.roadmap?.roadmap_id;
  if (!roadmapId) throw new Error("Cannot record event without a roadmap id");
  const scope: RoadmapEventScope = { roadmap_id: roadmapId };
  const milestoneId = loaded.active?.milestone_id ?? loaded.roadmap?.active_milestone_id ?? loaded.milestone?.milestone_id;
  if (milestoneId) scope.milestone_id = milestoneId;
  const changeRequestId =
    loaded.active?.change_request_id ?? loaded.roadmap?.active_change_request_id ?? loaded.changeRequest?.change_request_id;
  if (changeRequestId) scope.change_request_id = changeRequestId;
  return scope;
}

function loadedSnapshot(loaded: LoadedState): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  if (loaded.roadmap) {
    snapshot.phase = loaded.roadmap.phase;
    snapshot.roadmap_finalized = loaded.roadmap.roadmap_finalized;
    snapshot.active_milestone_id = loaded.roadmap.active_milestone_id ?? null;
    snapshot.active_change_request_id = loaded.roadmap.active_change_request_id ?? null;
  }
  if (loaded.milestone) snapshot.milestone_status = loaded.milestone.status;
  if (loaded.changeRequest) snapshot.change_request_status = loaded.changeRequest.status;
  return snapshot;
}

function taskStatusSnapshot(loaded: LoadedState, taskId: string | undefined): Record<string, unknown> {
  if (!taskId) return loadedSnapshot(loaded);
  const task = (loaded.changeRequest?.tasks ?? loaded.milestone?.tasks ?? []).find((candidate) => candidate.id === taskId);
  return { task_id: taskId, status: task?.status ?? null };
}

function waveStatusSnapshot(loaded: LoadedState, waveId: string | undefined): Record<string, unknown> {
  if (!waveId) return loadedSnapshot(loaded);
  const wave = (loaded.changeRequest?.waves ?? loaded.milestone?.waves ?? []).find((candidate) => candidate.id === waveId);
  return { wave_id: waveId, status: wave?.status ?? null };
}

function progressSnapshot(loaded: LoadedState): Record<string, unknown> {
  const progress = loaded.changeRequest?.progress ?? loaded.milestone?.progress;
  return {
    active_wave_id: progress?.active_wave_id ?? null,
    step: progress?.step ?? null,
    active_task_ids: progress?.active_task_ids ?? [],
    blocked_reason: progress?.blocked_reason ?? null,
  };
}

function waveFlowCheckSnapshot(loaded: LoadedState): Record<string, unknown> {
  const check = loaded.changeRequest?.wave_flow_check ?? loaded.milestone?.wave_flow_check;
  return {
    status: check?.status ?? null,
    checked_by: check?.checked_by ?? "",
    checked_at: check?.checked_at ?? "",
  };
}

function roadmapMilestoneCheckSnapshot(loaded: LoadedState): Record<string, unknown> {
  const check = loaded.roadmap?.roadmap_milestone_check;
  return {
    status: check?.status ?? null,
    checked_by: check?.checked_by ?? "",
    checked_at: check?.checked_at ?? "",
  };
}

function closeoutSnapshot(loaded: LoadedState): Record<string, unknown> {
  const closeout = loaded.changeRequest?.closeout ?? loaded.closeout;
  return { status: closeout?.status ?? null, closed_by: closeout?.closed_by ?? null };
}

function eventSnapshot(loaded: LoadedState, input: TransitionInput): Record<string, unknown> {
  switch (input.operation) {
    case "update_task_status":
      return taskStatusSnapshot(loaded, input.taskId);
    case "update_wave_status":
      return waveStatusSnapshot(loaded, input.waveId);
    case "update_implementation_progress":
      return progressSnapshot(loaded);
    case "record_wave_flow_check":
      return waveFlowCheckSnapshot(loaded);
    case "record_roadmap_milestone_check":
      return roadmapMilestoneCheckSnapshot(loaded);
    case "record_closeout":
      return closeoutSnapshot(loaded);
    default:
      return loadedSnapshot(loaded);
  }
}

function transitionEventScope(loaded: LoadedState, input: TransitionInput): RoadmapEventScope {
  const scope = scopeFromLoaded(loaded);
  if (input.taskId) scope.task_id = input.taskId;
  if (input.waveId) scope.wave_id = input.waveId;
  if (input.operation === "record_wave_flow_check") scope.gate = "wave_flow_check";
  if (input.operation === "record_roadmap_milestone_check") scope.gate = "roadmap_milestone_check";
  return scope;
}

function transitionActor(input: TransitionInput): string {
  if (input.operation === "record_wave_flow_check") {
    return input.waveFlowCheck?.checkedBy?.trim() || "wave-flow-checker";
  }
  if (input.operation === "record_roadmap_milestone_check") {
    return input.roadmapMilestoneCheck?.checkedBy?.trim() || "roadmap-milestone-checker";
  }
  return input.approver?.trim() || "user";
}

function transitionEventType(operation: TransitionInput["operation"]): string {
  switch (operation) {
    case "record_discovery":
      return "roadmap.discovery_recorded";
    case "approve_roadmap":
      return "roadmap.approved";
    case "reopen_roadmap":
      return "roadmap.reopened";
    case "record_roadmap_milestone_check":
    case "record_wave_flow_check":
      return "quality_gate.recorded";
    case "start_milestone_planning":
      return "milestone.planning_started";
    case "create_milestone_plan":
      return "milestone.plan_created";
    case "approve_milestone":
      return "milestone.approved";
    case "update_milestone_plan":
      return "milestone.plan_updated";
    case "start_implementation":
      return "implementation.started";
    case "start_reviewing":
      return "review.started";
    case "start_closeout":
      return "closeout.started";
    case "complete_milestone":
      return "milestone.completed";
    case "request_bypass":
      return "bypass.requested";
    case "clear_bypass":
      return "bypass.cleared";
    case "approve_change":
      return "change.approved";
    case "update_change_request_plan":
      return "change.plan_updated";
    case "close_change":
      return "change.closed";
    case "update_task_status":
      return "task.status_changed";
    case "update_wave_status":
      return "wave.status_changed";
    case "update_implementation_progress":
      return "progress.updated";
    case "record_closeout":
      return "closeout.recorded";
  }
}

function transitionDetails(input: TransitionInput): Record<string, unknown> | undefined {
  const details: Record<string, unknown> = {};
  if (input.summary) details.summary = input.summary;
  if (input.reason) details.reason = input.reason;
  if (input.taskStatus) details.task_status = input.taskStatus;
  if (input.waveStatus) details.wave_status = input.waveStatus;
  if (input.progress) details.progress_step = input.progress.step;
  if (input.closeout) details.closeout_status = input.closeout.status;
  if (input.waveFlowCheck) details.gate_status = input.waveFlowCheck.status;
  if (input.roadmapMilestoneCheck) details.gate_status = input.roadmapMilestoneCheck.status;
  return Object.keys(details).length > 0 ? details : undefined;
}

function transitionSummary(input: TransitionInput): string {
  switch (input.operation) {
    case "update_task_status":
      return `Task ${input.taskId} status changed to ${input.taskStatus}.`;
    case "update_wave_status":
      return `Wave ${input.waveId} status changed to ${input.waveStatus}.`;
    case "update_implementation_progress":
      return `Implementation progress changed to ${input.progress?.step}.`;
    case "record_wave_flow_check":
      return `Wave-flow check recorded as ${input.waveFlowCheck?.status}.`;
    case "record_roadmap_milestone_check":
      return `Roadmap milestone check recorded as ${input.roadmapMilestoneCheck?.status}.`;
    case "record_closeout":
      return `Closeout evidence recorded as ${input.closeout?.status}.`;
    default:
      return `Applied ${input.operation}.`;
  }
}

async function appendTransitionEvent(
  cwd: string,
  input: TransitionInput,
  before: LoadedState,
  after: LoadedState,
): Promise<void> {
  const details = transitionDetails(input);
  await appendRoadmapEvent(cwd, {
    actor: transitionActor(input),
    type: transitionEventType(input.operation),
    operation: input.operation,
    scope: transitionEventScope(before, input),
    summary: transitionSummary(input),
    before: eventSnapshot(before, input),
    after: eventSnapshot(after, input),
    ...(details ? { details } : {}),
  });
}

function list(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)";
}

function valueList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function valueString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function initialProgress(waves: WavePlan[]): ImplementationProgress {
  return {
    ...(waves[0] ? { active_wave_id: waves[0].id } : {}),
    step: "not_started",
    active_task_ids: [],
    updated_at: nowIso(),
  };
}

function pendingWaveFlowCheck(): WaveFlowCheck {
  return {
    status: "pending",
    checked_by: "",
    checked_at: "",
    summary: "",
    findings: [],
  };
}

function recordedCheck(input: WaveFlowCheckInput, fallbackCheckedBy: string): WaveFlowCheck {
  return {
    status: input.status,
    checked_by: input.checkedBy?.trim() || fallbackCheckedBy,
    checked_at: nowIso(),
    summary: input.summary?.trim() ?? "",
    findings: input.findings ?? [],
  };
}

function recordedWaveFlowCheck(input: WaveFlowCheckInput): WaveFlowCheck {
  return recordedCheck(input, "wave-flow-checker");
}

function recordedRoadmapMilestoneCheck(input: WaveFlowCheckInput): WaveFlowCheck {
  return recordedCheck(input, "roadmap-milestone-checker");
}

function normalizeWaveFlowCheck(value: unknown): WaveFlowCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return pendingWaveFlowCheck();
  const raw = value as Partial<WaveFlowCheck>;
  if (!["pending", "passed", "failed"].includes(raw.status ?? "")) return pendingWaveFlowCheck();
  return {
    status: raw.status as WaveFlowCheckStatus,
    checked_by: valueString(raw.checked_by),
    checked_at: valueString(raw.checked_at),
    summary: valueString(raw.summary),
    findings: valueList(raw.findings),
  };
}

function normalizeTask(task: TaskPlan): TaskPlan {
  const raw = task as unknown as Record<string, unknown>;
  return {
    ...task,
    objective: valueString(raw.objective),
    implementation_notes: valueList(raw.implementation_notes),
    done_criteria: valueList(raw.done_criteria),
    verification_commands: valueList(raw.verification_commands),
    depends_on: valueList(raw.depends_on),
    owned_files: valueList(raw.owned_files),
    owned_modules: valueList(raw.owned_modules),
    shared_interfaces: valueList(raw.shared_interfaces),
  };
}

function normalizeWave(wave: WavePlan): WavePlan {
  const raw = wave as unknown as Record<string, unknown>;
  return {
    ...wave,
    goal: valueString(raw.goal),
    exit_criteria: valueList(raw.exit_criteria),
    review_checkpoint: valueString(raw.review_checkpoint),
    tasks: valueList(raw.tasks),
  };
}

function normalizeProgress(value: unknown, waves: WavePlan[]): ImplementationProgress {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ImplementationProgress>
    : {};
  return {
    ...(typeof raw.active_wave_id === "string"
      ? { active_wave_id: raw.active_wave_id }
      : waves[0]
        ? { active_wave_id: waves[0].id }
        : {}),
    step: raw.step ?? "not_started",
    active_task_ids: valueList(raw.active_task_ids),
    ...(typeof raw.blocked_reason === "string" ? { blocked_reason: raw.blocked_reason } : {}),
    updated_at: raw.updated_at ?? nowIso(),
  };
}

function normalizeMilestonePlan(plan: MilestonePlan): MilestonePlan {
  const raw = plan as unknown as Record<string, unknown>;
  const tasks = Array.isArray(plan.tasks) ? plan.tasks.map(normalizeTask) : [];
  const waves = Array.isArray(plan.waves) ? plan.waves.map(normalizeWave) : [];
  return {
    ...plan,
    open_questions: valueList(raw.open_questions),
    verification_commands: valueList(raw.verification_commands),
    acceptance_criteria: valueList(raw.acceptance_criteria),
    user_interview: valueList(raw.user_interview),
    relevant_existing_code: valueList(raw.relevant_existing_code),
    relevant_documentation: valueList(raw.relevant_documentation),
    decisions: valueList(raw.decisions),
    dependency_analysis: valueList(raw.dependency_analysis),
    tasks,
    waves,
    progress: normalizeProgress(raw.progress, waves),
    wave_flow_check: normalizeWaveFlowCheck(raw.wave_flow_check),
  };
}

function normalizeChangeRequest(change: ChangeRequest): ChangeRequest {
  const raw = change as unknown as Record<string, unknown>;
  const tasks = Array.isArray(change.tasks) ? change.tasks.map(normalizeTask) : [];
  const waves = Array.isArray(change.waves) ? change.waves.map(normalizeWave) : [];
  return {
    ...change,
    verification_commands: valueList(raw.verification_commands),
    acceptance_criteria: valueList(raw.acceptance_criteria),
    user_interview: valueList(raw.user_interview),
    relevant_existing_code: valueList(raw.relevant_existing_code),
    relevant_documentation: valueList(raw.relevant_documentation),
    decisions: valueList(raw.decisions),
    dependency_analysis: valueList(raw.dependency_analysis),
    tasks,
    waves,
    progress: normalizeProgress(raw.progress, waves),
    wave_flow_check: normalizeWaveFlowCheck(raw.wave_flow_check),
  };
}

function normalizeRoadmapState(state: RoadmapState): RoadmapState {
  return {
    ...state,
    roadmap_milestone_check: normalizeWaveFlowCheck(
      (state as unknown as Record<string, unknown>).roadmap_milestone_check,
    ),
  };
}

function renderMilestone(milestone: RoadmapMilestoneOutline): string {
  return [
    `### ${milestone.id} - ${milestone.title}`,
    ``,
    `Status: ${milestone.status}`,
    ``,
    `Goal: ${milestone.goal}`,
    ``,
    `Scope:`,
    list(milestone.scope),
    ``,
    `Non-Goals:`,
    list(milestone.non_goals),
    ``,
    `Evidence:`,
    list(milestone.evidence),
    ``,
    `Dependencies:`,
    list(milestone.dependencies),
    ``,
    `Risks:`,
    list(milestone.risks),
    ``,
    `Acceptance Intent:`,
    list(milestone.acceptance_intent),
    ``,
    `Verification Intent:`,
    list(milestone.verification_intent),
  ].join("\n");
}

export function renderRoadmapMarkdown(state: RoadmapState): string {
  const body = [
    `# ${state.title}`,
    ``,
    `## Goal`,
    ``,
    state.goal || "(not finalized)",
    ``,
    `## Success Criteria`,
    ``,
    list(state.success_criteria ?? []),
    ``,
    `## Constraints`,
    ``,
    list(state.constraints ?? []),
    ``,
    `## Non-Goals`,
    ``,
    list(state.non_goals ?? []),
    ``,
    `## Context`,
    ``,
    list(state.context ?? []),
    ``,
    `## Evidence`,
    ``,
    list(state.evidence ?? []),
    ``,
    `## Discovery Findings`,
    ``,
    list(state.discovery.findings ?? []),
    ``,
    `## Milestones`,
    ``,
    (state.milestones ?? []).length > 0 ? state.milestones.map(renderMilestone).join("\n\n") : "- (none)",
    ``,
    `## Risks`,
    ``,
    list(state.risks ?? []),
    ``,
    `## Open Questions`,
    ``,
    list(state.open_questions ?? []),
  ].join("\n");

  return serializeMarkdownDocument(
    {
      roadmap_id: state.roadmap_id,
      title: state.title,
      status: state.roadmap_finalized ? "finalized" : "draft",
    },
    body,
  );
}

function renderPlanSummary(plan: MilestonePlan | ChangeRequest): string {
  const label = "change_request_id" in plan ? `Change request: ${plan.change_request_id}` : `Milestone: ${plan.milestone_id}`;
  return [
    label,
    `Title: ${plan.title}`,
    `Status: ${plan.status}`,
    `Active wave: ${plan.progress.active_wave_id ?? "(none)"}`,
    `Progress step: ${plan.progress.step}`,
    `Active tasks: ${plan.progress.active_task_ids.join(", ") || "(none)"}`,
    `Blocked reason: ${plan.progress.blocked_reason ?? "(none)"}`,
    `Wave flow check: ${plan.wave_flow_check.status}`,
  ].join("\n");
}

function renderTask(task: TaskPlan): string {
  return [
    `### ${task.id} - ${task.title}`,
    ``,
    `Worker: ${task.worker}`,
    `Status: ${task.status}`,
    `Objective: ${task.objective || "(not recorded)"}`,
    ``,
    `Implementation Notes:`,
    list(task.implementation_notes),
    ``,
    `Done Criteria:`,
    list(task.done_criteria),
    ``,
    `Verification Commands:`,
    list(task.verification_commands),
    ``,
    `Depends On:`,
    list(task.depends_on),
    ``,
    `Owned Files:`,
    list(task.owned_files),
    ``,
    `Owned Modules:`,
    list(task.owned_modules),
    ``,
    `Shared Interfaces:`,
    list(task.shared_interfaces),
  ].join("\n");
}

function renderWave(wave: WavePlan): string {
  return [
    `### ${wave.id}`,
    ``,
    `Status: ${wave.status}`,
    `Goal: ${wave.goal || "(not recorded)"}`,
    `Review Checkpoint: ${wave.review_checkpoint || "(not recorded)"}`,
    ``,
    `Tasks:`,
    list(wave.tasks),
    ``,
    `Exit Criteria:`,
    list(wave.exit_criteria),
  ].join("\n");
}

function renderImplementationPlanBody(plan: MilestonePlan | ChangeRequest): string {
  const requestedDelta = "request" in plan ? `\n## Requested Delta\n\n${plan.request}\n` : "";
  return [
    `# ${plan.title}`,
    requestedDelta.trimEnd(),
    `## Summary`,
    ``,
    renderPlanSummary(plan),
    ``,
    `## User Interview`,
    ``,
    list(plan.user_interview),
    ``,
    `## Context`,
    ``,
    `### Relevant Existing Code`,
    ``,
    list(plan.relevant_existing_code),
    ``,
    `### Relevant Documentation`,
    ``,
    list(plan.relevant_documentation),
    ``,
    `### Decisions`,
    ``,
    list(plan.decisions),
    ``,
    `## Required Work`,
    ``,
    plan.tasks.length > 0 ? plan.tasks.map(renderTask).join("\n\n") : "- (none)",
    ``,
    `## Dependency Analysis`,
    ``,
    list(plan.dependency_analysis),
    ``,
    `## Execution Waves`,
    ``,
    plan.waves.length > 0 ? plan.waves.map(renderWave).join("\n\n") : "- (none)",
    ``,
    `## Progress`,
    ``,
    `- Active wave: ${plan.progress.active_wave_id ?? "(none)"}`,
    `- Step: ${plan.progress.step}`,
    `- Active tasks: ${plan.progress.active_task_ids.join(", ") || "(none)"}`,
    `- Blocked reason: ${plan.progress.blocked_reason ?? "(none)"}`,
    `- Updated at: ${plan.progress.updated_at}`,
    ``,
    `## Wave Flow Check`,
    ``,
    `- Status: ${plan.wave_flow_check.status}`,
    `- Checked by: ${plan.wave_flow_check.checked_by || "(none)"}`,
    `- Checked at: ${plan.wave_flow_check.checked_at || "(none)"}`,
    `- Summary: ${plan.wave_flow_check.summary || "(none)"}`,
    `- Findings:`,
    list(plan.wave_flow_check.findings),
    ``,
    `## Verification`,
    ``,
    `### Acceptance Criteria`,
    ``,
    list(plan.acceptance_criteria),
    ``,
    `### Verification Commands`,
    ``,
    list(plan.verification_commands),
  ].filter((section) => section !== "").join("\n");
}

function hasContent(value: string | undefined): boolean {
  if (!value || value.trim() === "") return false;
  return !/\b(TBD|TODO)\b/i.test(value);
}

function hasContentItems(items: string[] | undefined): boolean {
  return Array.isArray(items) && items.length > 0 && items.every(hasContent);
}

async function assertRoadmapReadyForApproval(cwd: string, roadmap: RoadmapState): Promise<void> {
  if (!roadmap.roadmap_finalized) throw new Error("Roadmap approval requires a finalized roadmap");
  if (!hasContent(roadmap.goal)) throw new Error("Roadmap approval requires a concrete goal");
  for (const [label, items] of [
    ["success criteria", roadmap.success_criteria],
    ["constraints", roadmap.constraints],
    ["non-goals", roadmap.non_goals],
    ["context", roadmap.context],
    ["evidence", roadmap.evidence],
    ["risks", roadmap.risks],
  ] as const) {
    if (!hasContentItems(items)) throw new Error(`Roadmap approval requires concrete ${label}`);
  }
  if (!Array.isArray(roadmap.milestones) || roadmap.milestones.length === 0) {
    throw new Error("Roadmap approval requires at least one concrete milestone");
  }

  const milestoneIds = new Set<string>();
  for (const milestone of roadmap.milestones) {
    if (milestoneIds.has(milestone.id)) throw new Error(`Duplicate milestone id: ${milestone.id}`);
    milestoneIds.add(milestone.id);
    if (!hasContent(milestone.id)) throw new Error("Roadmap milestone requires an id");
    if (!hasContent(milestone.title)) throw new Error(`Roadmap milestone ${milestone.id} requires a title`);
    if (!hasContent(milestone.goal)) throw new Error(`Roadmap milestone ${milestone.id} requires a goal`);
    for (const [label, items] of [
      ["scope", milestone.scope],
      ["non-goals", milestone.non_goals],
      ["evidence", milestone.evidence],
      ["risks", milestone.risks],
      ["acceptance intent", milestone.acceptance_intent],
      ["verification intent", milestone.verification_intent],
    ] as const) {
      if (!hasContentItems(items)) throw new Error(`Roadmap milestone ${milestone.id} requires concrete ${label}`);
    }
  }
  for (const milestone of roadmap.milestones) {
    for (const dependency of milestone.dependencies ?? []) {
      if (!milestoneIds.has(dependency)) {
        throw new Error(`Roadmap milestone ${milestone.id} depends on unknown milestone ${dependency}`);
      }
    }
  }

  const expected = renderRoadmapMarkdown(roadmap);
  const actual = await readText(roadmapDocPath(cwd, roadmap.roadmap_id));
  if (actual !== expected) throw new Error("Roadmap approval requires generated roadmap.md to match state");
  if (roadmap.roadmap_milestone_check.status !== "passed") {
    throw new Error("Roadmap approval requires a passed roadmap-milestone check");
  }
  if (roadmap.roadmap_milestone_check.checked_by.trim() === "") {
    throw new Error("Passed roadmap-milestone check must record who checked it");
  }
  if (roadmap.roadmap_milestone_check.checked_at.trim() === "") {
    throw new Error("Passed roadmap-milestone check must record when it ran");
  }
  if (roadmap.roadmap_milestone_check.summary.trim() === "") {
    throw new Error("Passed roadmap-milestone check must include a summary");
  }
}

export async function loadActive(cwd: string): Promise<ActivePointer | undefined> {
  const filePath = activePointerPath(cwd);
  if (!(await fileExists(filePath))) return undefined;
  return await readYamlFile<ActivePointer>(filePath);
}

export async function writeActive(cwd: string, active: ActivePointer): Promise<void> {
  await withStoreWriteLock(cwd, async () => {
    await writeYamlFile(activePointerPath(cwd), active);
  });
}

export async function loadRoadmapState(cwd: string, roadmapId: string): Promise<RoadmapState> {
  return normalizeRoadmapState(await readYamlFile<RoadmapState>(roadmapStatePath(cwd, roadmapId)));
}

export async function writeRoadmapState(cwd: string, state: RoadmapState): Promise<void> {
  await withStoreWriteLock(cwd, async () => {
    state.updated_at = nowIso();
    await writeYamlFile(roadmapStatePath(cwd, state.roadmap_id), state);
    if (state.roadmap_finalized) {
      await writeText(roadmapDocPath(cwd, state.roadmap_id), renderRoadmapMarkdown(state));
    }
  });
}

export async function loadMilestonePlan(
  cwd: string,
  roadmapId: string,
  milestoneId: string,
): Promise<MilestonePlan> {
  return normalizeMilestonePlan(await readMarkdownData<MilestonePlan>(
    milestonePlanPath(cwd, roadmapId, milestoneId),
  ));
}

export async function writeMilestonePlan(
  cwd: string,
  plan: MilestonePlan,
  body?: string,
): Promise<void> {
  await withStoreWriteLock(cwd, async () => {
    const normalized = normalizeMilestonePlan(plan);
    await writeMarkdownData(
      milestonePlanPath(cwd, normalized.roadmap_id, normalized.milestone_id),
      { ...normalized } as unknown as Record<string, unknown>,
      body ?? renderImplementationPlanBody(normalized),
    );
  });
}

export async function loadChangeRequest(
  cwd: string,
  roadmapId: string,
  milestoneId: string,
  changeRequestId: string,
): Promise<ChangeRequest> {
  return normalizeChangeRequest(await readMarkdownData<ChangeRequest>(
    changeRequestPath(cwd, roadmapId, milestoneId, changeRequestId),
  ));
}

export async function loadState(cwd: string): Promise<LoadedState> {
  const active = await loadActive(cwd);
  if (!active) return {};

  const roadmap = await loadRoadmapState(cwd, active.roadmap_id);
  const milestone = active.milestone_id
    ? await loadMilestonePlan(cwd, active.roadmap_id, active.milestone_id)
    : undefined;
  const changeRequest =
    active.milestone_id && active.change_request_id
      ? await loadChangeRequest(cwd, active.roadmap_id, active.milestone_id, active.change_request_id)
      : undefined;
  const closeout =
    active.milestone_id && (await fileExists(milestoneCloseoutPath(cwd, active.roadmap_id, active.milestone_id)))
      ? await loadMilestoneCloseout(cwd, active.roadmap_id, active.milestone_id)
      : undefined;

  const loaded: LoadedState = { active, roadmap };
  if (milestone) loaded.milestone = milestone;
  if (changeRequest) loaded.changeRequest = changeRequest;
  if (closeout) loaded.closeout = closeout;
  loaded.usage = await loadUsageSummary(cwd, active.roadmap_id);
  return loaded;
}

export async function initRoadmap(cwd: string, input: InitRoadmapInput): Promise<RoadmapState> {
  return await withStoreWriteLock(cwd, async () => {
  assertSlug(input.roadmapId, "roadmapId");
  const existingActive = await loadActive(cwd);
  if (existingActive) {
    throw new Error(`Cannot create roadmap: ${existingActive.roadmap_id} is already active`);
  }

  const createdAt = nowIso();
  const state: RoadmapState = {
    roadmap_id: input.roadmapId,
    title: input.title,
    phase: "discovery",
    created_at: createdAt,
    updated_at: createdAt,
    roadmap_finalized: false,
    roadmap_milestone_check: pendingWaveFlowCheck(),
    goal: input.summary ?? "",
    success_criteria: [],
    constraints: [],
    non_goals: [],
    context: [],
    evidence: [],
    risks: [],
    discovery: {
      recorded: input.discovery?.recorded ?? false,
      external_research_required: input.discovery?.external_research_required ?? false,
      external_research_recorded: input.discovery?.external_research_recorded ?? false,
      findings: input.discovery?.findings ?? [],
    },
    approvals: [],
    open_questions: [],
    milestones: [],
  };

  await fs.mkdir(roadmapDir(cwd, input.roadmapId), { recursive: true });
  await writeRoadmapState(cwd, state);
  await writeActive(cwd, { roadmap_id: input.roadmapId, updated_at: createdAt });
  await writeText(
    roadmapDocPath(cwd, input.roadmapId),
    renderRoadmapMarkdown(state),
  );
  await writeText(decisionsPath(cwd, input.roadmapId), "# Decision Register\n");
  await writeText(risksPath(cwd, input.roadmapId), "# Risk Register\n");
  await appendRoadmapEvent(cwd, {
    actor: "user",
    type: "roadmap.initialized",
    scope: { roadmap_id: state.roadmap_id },
    summary: `Initialized roadmap ${state.roadmap_id}.`,
    after: {
      phase: state.phase,
      roadmap_finalized: state.roadmap_finalized,
    },
  });
  return state;
  });
}

export async function updateRoadmap(
  cwd: string,
  input: UpdateRoadmapInput,
): Promise<RoadmapState> {
  return await withStoreWriteLock(cwd, async () => {
  const loaded = await loadState(cwd);
  if (!loaded.active || !loaded.roadmap) {
    throw new Error("No active roadmap. Run /roadmap:new first.");
  }
  if (!["discovery", "roadmap_draft"].includes(loaded.roadmap.phase)) {
    throw new Error(`update_roadmap requires phase discovery or roadmap_draft; current phase is ${loaded.roadmap.phase}`);
  }

  for (const milestone of input.milestones) {
    assertSlug(milestone.id, "milestone.id");
  }

  const state: RoadmapState = {
    ...loaded.roadmap,
    roadmap_finalized: true,
    roadmap_milestone_check: pendingWaveFlowCheck(),
    goal: input.goal,
    success_criteria: input.successCriteria,
    constraints: input.constraints,
    non_goals: input.nonGoals,
    context: input.context,
    evidence: input.evidence,
    risks: input.risks,
    milestones: input.milestones.map((milestone) => ({
      ...milestone,
      status: milestone.status ?? "planned",
    })),
  };

  await writeRoadmapState(cwd, state);
  await writeText(roadmapDocPath(cwd, state.roadmap_id), renderRoadmapMarkdown(state));
  await appendRoadmapEvent(cwd, {
    actor: "user",
    type: "roadmap.updated",
    scope: { roadmap_id: state.roadmap_id },
    summary: `Updated roadmap ${state.roadmap_id}.`,
    after: {
      phase: state.phase,
      roadmap_finalized: state.roadmap_finalized,
      milestone_count: state.milestones.length,
    },
  });
  return await loadRoadmapState(cwd, state.roadmap_id);
  });
}

export async function createMilestonePlan(
  cwd: string,
  roadmap: RoadmapState,
  input: CreateMilestonePlanInput,
): Promise<MilestonePlan> {
  return await withStoreWriteLock(cwd, async () => {
  assertSlug(input.milestoneId, "milestoneId");
  const currentRoadmap = await loadRoadmapState(cwd, roadmap.roadmap_id);
  const roadmapMilestone = currentRoadmap.milestones.find((milestone) => milestone.id === input.milestoneId);
  if (!roadmapMilestone) {
    throw new Error(`Milestone is not defined in roadmap: ${input.milestoneId}`);
  }
  if (roadmapMilestone.status !== "planned" && roadmapMilestone.status !== "blocked") {
    throw new Error(`Milestone already has a plan: ${input.milestoneId}`);
  }
  const before = {
    phase: currentRoadmap.phase,
    milestone_status: roadmapMilestone.status,
  };

  const plan: MilestonePlan = {
    roadmap_id: currentRoadmap.roadmap_id,
    milestone_id: input.milestoneId,
    title: input.title,
    status: "milestone_planning",
    approvals: [],
    open_questions: input.openQuestions ?? [],
    verification_commands: input.verificationCommands,
    acceptance_criteria: input.acceptanceCriteria,
    cleanup_policy: "approval-gated",
    user_interview: input.userInterview ?? [],
    relevant_existing_code: input.relevantExistingCode ?? [],
    relevant_documentation: input.relevantDocumentation ?? [],
    decisions: input.decisions ?? [],
    dependency_analysis: input.dependencyAnalysis ?? [],
    tasks: input.tasks,
    waves: input.waves,
    progress: initialProgress(input.waves),
    wave_flow_check: pendingWaveFlowCheck(),
  };

  await fs.mkdir(milestoneDir(cwd, currentRoadmap.roadmap_id, input.milestoneId), { recursive: true });
  await writeMilestonePlan(cwd, plan);
  await writeText(milestoneNotesPath(cwd, currentRoadmap.roadmap_id, input.milestoneId), "# Milestone Notes\n");
  await writeText(
    milestoneCloseoutPath(cwd, currentRoadmap.roadmap_id, input.milestoneId),
    serializeMarkdownDocument(
      openCloseoutEvidence(currentRoadmap.roadmap_id, input.milestoneId) as unknown as Record<string, unknown>,
      "# Closeout Evidence\n",
    ),
  );

  roadmapMilestone.title = input.title;
  roadmapMilestone.status = "milestone_planning";
  currentRoadmap.active_milestone_id = input.milestoneId;
  currentRoadmap.phase = "milestone_planning";
  await writeRoadmapState(cwd, currentRoadmap);
  await writeActive(cwd, {
    roadmap_id: currentRoadmap.roadmap_id,
    milestone_id: input.milestoneId,
    updated_at: nowIso(),
  });
  await appendRoadmapEvent(cwd, {
    actor: "user",
    type: "milestone.plan_created",
    operation: "create_milestone_plan",
    scope: {
      roadmap_id: currentRoadmap.roadmap_id,
      milestone_id: input.milestoneId,
    },
    summary: `Created milestone plan ${input.milestoneId}.`,
    before,
    after: {
      phase: currentRoadmap.phase,
      milestone_status: roadmapMilestone.status,
    },
  });

  return plan;
  });
}

async function updateMilestonePlanDraft(
  cwd: string,
  plan: MilestonePlan,
  input: CreateMilestonePlanInput,
): Promise<MilestonePlan> {
  if (plan.status !== "milestone_planning") {
    throw new Error("update_milestone_plan requires a draft milestone plan");
  }
  if (plan.approvals.length > 0) throw new Error("Approved milestone plans cannot be updated");
  if (input.milestoneId !== plan.milestone_id) {
    throw new Error(`update_milestone_plan cannot change milestone id from ${plan.milestone_id} to ${input.milestoneId}`);
  }
  const updated: MilestonePlan = {
    ...plan,
    title: input.title,
    open_questions: input.openQuestions ?? [],
    verification_commands: input.verificationCommands,
    acceptance_criteria: input.acceptanceCriteria,
    user_interview: input.userInterview ?? [],
    relevant_existing_code: input.relevantExistingCode ?? [],
    relevant_documentation: input.relevantDocumentation ?? [],
    decisions: input.decisions ?? [],
    dependency_analysis: input.dependencyAnalysis ?? [],
    tasks: input.tasks,
    waves: input.waves,
    progress: initialProgress(input.waves),
    wave_flow_check: pendingWaveFlowCheck(),
  };
  await writeMilestonePlan(cwd, updated);
  await appendRoadmapEvent(cwd, {
    actor: "user",
    type: "milestone.plan_updated",
    operation: "update_milestone_plan",
    scope: {
      roadmap_id: updated.roadmap_id,
      milestone_id: updated.milestone_id,
    },
    summary: `Updated milestone plan ${updated.milestone_id}.`,
    before: {
      title: plan.title,
      task_count: plan.tasks.length,
      wave_count: plan.waves.length,
      wave_flow_check: plan.wave_flow_check.status,
    },
    after: {
      title: updated.title,
      task_count: updated.tasks.length,
      wave_count: updated.waves.length,
      wave_flow_check: updated.wave_flow_check.status,
    },
  });
  return updated;
}

function approval(approver: string | undefined, summary: string | undefined): Approval {
  return {
    by: approver ?? "user",
    at: nowIso(),
    summary: summary ?? "Approved in OMP session",
  };
}

function setMilestoneStatus(roadmap: RoadmapState, milestoneId: string, status: Phase): void {
  const milestone = roadmap.milestones.find((candidate) => candidate.id === milestoneId);
  if (milestone) milestone.status = status;
}

function hasPlannableMilestone(roadmap: RoadmapState): boolean {
  return roadmap.milestones.some((milestone) => ["planned", "blocked"].includes(milestone.status));
}

function requirePhase(actual: Phase, expected: Phase, operation: string): void {
  if (actual !== expected) {
    throw new Error(`${operation} requires phase ${expected}; current phase is ${actual}`);
  }
}

function requireActiveMilestone(
  milestoneId: string | undefined,
  milestone: MilestonePlan | undefined,
): asserts milestone is MilestonePlan {
  if (!milestoneId || !milestone) throw new Error("No active milestone");
}

function requireMilestoneId(milestoneId: string | undefined): string {
  if (!milestoneId) throw new Error("No active milestone");
  return milestoneId;
}

function closeoutOrThrow(
  evidence: CloseoutEvidence | undefined,
  acceptance: string[],
  verification: string[],
): void {
  const errors: { code: string; message: string; path?: string }[] = [];
  validateCloseoutEvidence(evidence, acceptance, verification, errors, "closeout");
  if (errors.length > 0) {
    throw new Error(errors[0]?.message ?? "Closeout evidence is invalid");
  }
}

async function writeChangeRequest(
  cwd: string,
  change: ChangeRequest,
  body?: string,
): Promise<void> {
  const normalized = normalizeChangeRequest(change);
  await writeMarkdownData(
    changeRequestPath(cwd, normalized.roadmap_id, normalized.milestone_id, normalized.change_request_id),
    { ...normalized } as unknown as Record<string, unknown>,
    body ?? renderImplementationPlanBody(normalized),
  );
}

async function writeActivePointer(
  cwd: string,
  roadmapId: string,
  milestoneId: string | undefined,
  changeRequestId?: string,
): Promise<void> {
  await writeActive(cwd, {
    roadmap_id: roadmapId,
    ...(milestoneId ? { milestone_id: milestoneId } : {}),
    ...(changeRequestId ? { change_request_id: changeRequestId } : {}),
    updated_at: nowIso(),
  });
}

export async function transition(cwd: string, input: TransitionInput): Promise<LoadedState> {
  return await withStoreWriteLock(cwd, async () => {
  const loaded = await loadState(cwd);
  if (!loaded.active || !loaded.roadmap) {
    throw new Error("No active roadmap. Run /roadmap:new first.");
  }

  const beforeEvent = structuredClone(loaded) as LoadedState;
  const roadmap = loaded.roadmap;
  const activeMilestoneId = loaded.active.milestone_id ?? roadmap.active_milestone_id;

  switch (input.operation) {
    case "record_discovery":
      if (!["discovery", "roadmap_draft"].includes(roadmap.phase)) {
        throw new Error(`record_discovery requires phase discovery or roadmap_draft; current phase is ${roadmap.phase}`);
      }
      roadmap.discovery = {
        recorded: input.discovery?.recorded ?? true,
        external_research_required:
          input.discovery?.external_research_required ?? roadmap.discovery.external_research_required,
        external_research_recorded:
          input.discovery?.external_research_recorded ?? roadmap.discovery.external_research_recorded,
        findings: input.discovery?.findings ?? roadmap.discovery.findings,
      };
      roadmap.phase = "roadmap_draft";
      break;
    case "approve_roadmap":
      requirePhase(roadmap.phase, "roadmap_draft", input.operation);
      if (!roadmap.discovery.recorded) throw new Error("Roadmap approval requires recorded repo discovery");
      if (roadmap.discovery.external_research_required && !roadmap.discovery.external_research_recorded) {
        throw new Error("Roadmap approval requires recorded external research");
      }
      if (roadmap.open_questions.length > 0) {
        throw new Error("Roadmap approval requires all material questions to be resolved");
      }
      await assertRoadmapReadyForApproval(cwd, roadmap);
      roadmap.phase = "roadmap_approved";
      roadmap.approvals.push(approval(input.approver, input.summary));
      break;
    case "record_roadmap_milestone_check":
      requirePhase(roadmap.phase, "roadmap_draft", input.operation);
      if (!roadmap.roadmap_finalized) {
        throw new Error("record_roadmap_milestone_check requires a finalized roadmap");
      }
      if (!input.roadmapMilestoneCheck) {
        throw new Error("record_roadmap_milestone_check requires checker input");
      }
      roadmap.roadmap_milestone_check = recordedRoadmapMilestoneCheck(input.roadmapMilestoneCheck);
      break;
    case "reopen_roadmap": {
      requirePhase(roadmap.phase, "roadmap_approved", input.operation);
      const reason = input.reason?.trim();
      if (!reason) throw new Error("reopen_roadmap requires a reason");
      if (activeMilestoneId) throw new Error("reopen_roadmap requires no active milestone");
      if (loaded.active.change_request_id || roadmap.active_change_request_id) {
        throw new Error("reopen_roadmap requires no active change request");
      }

      roadmap.phase = "roadmap_draft";
      roadmap.roadmap_finalized = false;
      roadmap.roadmap_milestone_check = pendingWaveFlowCheck();
      await appendText(
        decisionsPath(cwd, roadmap.roadmap_id),
        `\n## Roadmap Reopened\n\n- Reason: ${reason}\n- At: ${nowIso()}\n\nRoadmap reopened for pre-milestone changes. Regenerate the structured roadmap and require reapproval before milestone planning.\n`,
      );
      break;
    }
    case "start_milestone_planning":
      if (!["roadmap_approved", "complete"].includes(roadmap.phase)) {
        throw new Error(`start_milestone_planning requires phase roadmap_approved or complete; current phase is ${roadmap.phase}`);
      }
      if (roadmap.phase === "complete") {
        if (loaded.active.change_request_id || roadmap.active_change_request_id) {
          throw new Error("start_milestone_planning requires no active change request");
        }
        if (!hasPlannableMilestone(roadmap)) {
          throw new Error("start_milestone_planning requires a planned or blocked milestone");
        }
        delete roadmap.active_milestone_id;
        await writeActivePointer(cwd, roadmap.roadmap_id, undefined);
      }
      roadmap.phase = "milestone_planning";
      break;
    case "create_milestone_plan":
      requirePhase(roadmap.phase, "milestone_planning", input.operation);
      if (!input.milestone) throw new Error("create_milestone_plan requires milestone input");
      await createMilestonePlan(cwd, roadmap, input.milestone);
      return await loadState(cwd);
    case "approve_milestone": {
      requirePhase(roadmap.phase, "milestone_planning", input.operation);
      requireActiveMilestone(activeMilestoneId, loaded.milestone);
      const milestoneId = requireMilestoneId(activeMilestoneId);
      const plan = { ...loaded.milestone, status: "milestone_approved" as Phase };
      if (plan.open_questions.length > 0) throw new Error("Milestone approval requires open questions to be resolved");
      if (plan.wave_flow_check.status !== "passed") {
        throw new Error("Milestone approval requires a passed wave-flow check");
      }
      if (plan.approvals.length > 0) throw new Error("Milestone is already approved");
      plan.approvals.push(approval(input.approver, input.summary));
      await writeMilestonePlan(cwd, plan);
      roadmap.phase = "milestone_approved";
      setMilestoneStatus(roadmap, milestoneId, "milestone_approved");
      break;
    }
    case "update_milestone_plan": {
      requirePhase(roadmap.phase, "milestone_planning", input.operation);
      requireActiveMilestone(activeMilestoneId, loaded.milestone);
      if (!input.milestone) throw new Error("update_milestone_plan requires milestone input");
      await updateMilestonePlanDraft(cwd, loaded.milestone, input.milestone);
      return await loadState(cwd);
    }
    case "start_implementation": {
      if (loaded.changeRequest) {
        if (!["reviewing", "closeout", "complete"].includes(roadmap.phase)) {
          throw new Error("Change implementation can start only from reviewing, closeout, or complete");
        }
        if (!["approved", "implementing"].includes(loaded.changeRequest.status)) {
          throw new Error("Change implementation requires an approved change request");
        }
        const change = { ...loaded.changeRequest, status: "implementing" as const };
        await writeChangeRequest(cwd, change);
        break;
      }
      requirePhase(roadmap.phase, "milestone_approved", input.operation);
      requireActiveMilestone(activeMilestoneId, loaded.milestone);
      const milestoneId = requireMilestoneId(activeMilestoneId);
      if (loaded.milestone.approvals.length === 0) throw new Error("Implementation requires milestone approval");
      roadmap.phase = "implementing";
      setMilestoneStatus(roadmap, milestoneId, "implementing");
      break;
    }
    case "start_reviewing":
      requirePhase(roadmap.phase, "implementing", input.operation);
      requireActiveMilestone(activeMilestoneId, loaded.milestone);
      const reviewingMilestoneId = requireMilestoneId(activeMilestoneId);
      roadmap.phase = "reviewing";
      setMilestoneStatus(roadmap, reviewingMilestoneId, "reviewing");
      break;
    case "start_closeout":
      requirePhase(roadmap.phase, "reviewing", input.operation);
      requireActiveMilestone(activeMilestoneId, loaded.milestone);
      const closeoutMilestoneId = requireMilestoneId(activeMilestoneId);
      roadmap.phase = "closeout";
      setMilestoneStatus(roadmap, closeoutMilestoneId, "closeout");
      break;
    case "complete_milestone":
      requirePhase(roadmap.phase, "closeout", input.operation);
      requireActiveMilestone(activeMilestoneId, loaded.milestone);
      const completedMilestoneId = requireMilestoneId(activeMilestoneId);
      closeoutOrThrow(
        loaded.closeout,
        loaded.milestone.acceptance_criteria,
        loaded.milestone.verification_commands,
      );
      roadmap.phase = "complete";
      setMilestoneStatus(roadmap, completedMilestoneId, "complete");
      break;
    case "request_bypass":
      if (!input.reason) throw new Error("Bypass requires a reason");
      roadmap.bypass = {
        active: true,
        reason: input.reason,
        requested_by: input.approver ?? "user",
        requested_at: nowIso(),
      };
      break;
    case "clear_bypass":
      delete roadmap.bypass;
      break;
    case "approve_change": {
      if (!loaded.changeRequest || !activeMilestoneId) {
        throw new Error("No active change request to approve");
      }
      if (loaded.changeRequest.status !== "draft") throw new Error("Only draft change requests can be approved");
      if (loaded.changeRequest.wave_flow_check.status !== "passed") {
        throw new Error("Change approval requires a passed wave-flow check");
      }
      const change = {
        ...loaded.changeRequest,
        status: "approved" as const,
        approvals: [...loaded.changeRequest.approvals, approval(input.approver, input.summary)],
      };
      await writeChangeRequest(cwd, change);
      break;
    }
    case "update_change_request_plan": {
      if (!loaded.changeRequest || !activeMilestoneId) {
        throw new Error("No active change request to update");
      }
      if (!input.changeRequest) throw new Error("update_change_request_plan requires change request input");
      if (loaded.changeRequest.status !== "draft") throw new Error("Only draft change requests can be updated");
      if (input.changeRequest.changeRequestId !== loaded.changeRequest.change_request_id) {
        throw new Error(
          `update_change_request_plan cannot change request id from ${loaded.changeRequest.change_request_id} to ${input.changeRequest.changeRequestId}`,
        );
      }
      const change: ChangeRequest = {
        ...loaded.changeRequest,
        title: input.changeRequest.title,
        request: input.changeRequest.request,
        verification_commands: input.changeRequest.verificationCommands,
        acceptance_criteria: input.changeRequest.acceptanceCriteria,
        user_interview: input.changeRequest.userInterview ?? [],
        relevant_existing_code: input.changeRequest.relevantExistingCode ?? [],
        relevant_documentation: input.changeRequest.relevantDocumentation ?? [],
        decisions: input.changeRequest.decisions ?? [],
        dependency_analysis: input.changeRequest.dependencyAnalysis ?? [],
        tasks: input.changeRequest.tasks,
        waves: input.changeRequest.waves,
        progress: initialProgress(input.changeRequest.waves),
        wave_flow_check: pendingWaveFlowCheck(),
      };
      await writeChangeRequest(cwd, change);
      break;
    }
    case "close_change": {
      if (!loaded.changeRequest || !activeMilestoneId) throw new Error("No active change request to close");
      const milestoneId = requireMilestoneId(activeMilestoneId);
      if (!loaded.changeRequest.closeout) throw new Error("Change closeout evidence is required");
      closeoutOrThrow(
        loaded.changeRequest.closeout,
        loaded.changeRequest.acceptance_criteria,
        loaded.changeRequest.verification_commands,
      );
      const change = { ...loaded.changeRequest, status: "closed" as const };
      await writeChangeRequest(cwd, change);
      delete roadmap.active_change_request_id;
      await writeActivePointer(cwd, roadmap.roadmap_id, milestoneId);
      break;
    }
    case "update_task_status": {
      if (!input.taskId || !input.taskStatus) throw new Error("update_task_status requires taskId and taskStatus");
      if (loaded.changeRequest) {
        const tasks = updateTaskStatus(loaded.changeRequest.tasks, input.taskId, input.taskStatus);
        await writeChangeRequest(cwd, { ...loaded.changeRequest, tasks });
        break;
      }
      requireActiveMilestone(activeMilestoneId, loaded.milestone);
      const tasks = updateTaskStatus(loaded.milestone.tasks, input.taskId, input.taskStatus);
      await writeMilestonePlan(cwd, { ...loaded.milestone, tasks });
      break;
    }
    case "update_wave_status": {
      if (!input.waveId || !input.waveStatus) throw new Error("update_wave_status requires waveId and waveStatus");
      if (loaded.changeRequest) {
        const waves = updateWaveStatus(loaded.changeRequest.waves, input.waveId, input.waveStatus);
        await writeChangeRequest(cwd, { ...loaded.changeRequest, waves });
        break;
      }
      requireActiveMilestone(activeMilestoneId, loaded.milestone);
      const waves = updateWaveStatus(loaded.milestone.waves, input.waveId, input.waveStatus);
      await writeMilestonePlan(cwd, { ...loaded.milestone, waves });
      break;
    }
    case "update_implementation_progress": {
      if (!input.progress) throw new Error("update_implementation_progress requires progress input");
      const progress = {
        ...(input.progress.activeWaveId ? { active_wave_id: input.progress.activeWaveId } : {}),
        step: input.progress.step,
        active_task_ids: input.progress.activeTaskIds ?? [],
        ...(input.progress.blockedReason ? { blocked_reason: input.progress.blockedReason } : {}),
        updated_at: nowIso(),
      } satisfies ImplementationProgress;
      if (loaded.changeRequest) {
        await writeChangeRequest(cwd, { ...loaded.changeRequest, progress });
        break;
      }
      requireActiveMilestone(activeMilestoneId, loaded.milestone);
      await writeMilestonePlan(cwd, { ...loaded.milestone, progress });
      break;
    }
    case "record_closeout": {
      if (!input.closeout) throw new Error("record_closeout requires closeout evidence");
      requireActiveMilestone(activeMilestoneId, loaded.milestone);
      const milestoneId = requireMilestoneId(activeMilestoneId);
      const evidence = {
        ...input.closeout,
        roadmap_id: roadmap.roadmap_id,
        milestone_id: milestoneId,
        status: input.closeout.status,
        ...(input.closeout.status === "closed" && !input.closeout.closed_at
          ? { closed_at: nowIso() }
          : {}),
      };
      if (loaded.changeRequest) {
        const changeEvidence = {
          ...evidence,
          change_request_id: loaded.changeRequest.change_request_id,
        };
        const change = { ...loaded.changeRequest, closeout: changeEvidence };
        await writeChangeRequest(cwd, change);
        break;
      }
      await writeMilestoneCloseout(cwd, evidence);
      break;
    }
    case "record_wave_flow_check": {
      if (!input.waveFlowCheck) throw new Error("record_wave_flow_check requires wave flow check input");
      const waveFlowCheck = recordedWaveFlowCheck(input.waveFlowCheck);
      if (loaded.changeRequest) {
        if (loaded.changeRequest.status !== "draft") throw new Error("record_wave_flow_check requires a draft change request");
        await writeChangeRequest(cwd, { ...loaded.changeRequest, wave_flow_check: waveFlowCheck });
        break;
      }
      requireActiveMilestone(activeMilestoneId, loaded.milestone);
      if (loaded.milestone.status !== "milestone_planning") {
        throw new Error("record_wave_flow_check requires a draft milestone plan");
      }
      await writeMilestonePlan(cwd, { ...loaded.milestone, wave_flow_check: waveFlowCheck });
      break;
    }
    default:
      input.operation satisfies never;
  }

  await writeRoadmapState(cwd, roadmap);
  const after = await loadState(cwd);
  await appendTransitionEvent(cwd, input, beforeEvent, after);
  return after;
  });
}

function updateTaskStatus(
  tasks: TaskPlan[],
  taskId: string,
  status: TaskPlan["status"],
): TaskPlan[] {
  let found = false;
  const updated = tasks.map((task) => {
    if (task.id !== taskId) return task;
    found = true;
    return { ...task, status };
  });
  if (!found) throw new Error(`Unknown task: ${taskId}`);
  return updated;
}

function updateWaveStatus(
  waves: WavePlan[],
  waveId: string,
  status: WavePlan["status"],
): WavePlan[] {
  let found = false;
  const updated = waves.map((wave) => {
    if (wave.id !== waveId) return wave;
    found = true;
    return { ...wave, status };
  });
  if (!found) throw new Error(`Unknown wave: ${waveId}`);
  return updated;
}

async function appendNoteEntry(cwd: string, input: AppendNoteInput): Promise<{ filePath: string; scope: RoadmapEventScope }> {
  const loaded = await loadState(cwd);
  const roadmapId = input.roadmapId ?? loaded.active?.roadmap_id;
  const milestoneId = input.milestoneId ?? loaded.active?.milestone_id;
  if (!roadmapId || !milestoneId) {
    throw new Error("append_note requires an active roadmap and milestone");
  }

  const metadata = {
    kind: input.kind,
    roadmap_id: roadmapId,
    milestone_id: milestoneId,
    wave_id: input.waveId,
    task_id: input.taskId,
    worker_id: input.workerId,
    blocking: input.blocking ?? false,
    status: input.status ?? "open",
    at: nowIso(),
  };
  const entry = `\n---\n${serializeYaml(metadata).trimEnd()}\n---\n\n## ${input.title}\n\n${input.body.trimEnd()}\n`;
  const filePath = milestoneNotesPath(cwd, roadmapId, milestoneId);
  await appendText(filePath, entry);
  const scope: RoadmapEventScope = { roadmap_id: roadmapId, milestone_id: milestoneId };
  if (input.waveId) scope.wave_id = input.waveId;
  if (input.taskId) scope.task_id = input.taskId;
  return { filePath, scope };
}

export async function appendNote(cwd: string, input: AppendNoteInput): Promise<string> {
  return await withStoreWriteLock(cwd, async () => {
  const { filePath, scope } = await appendNoteEntry(cwd, input);
  await appendRoadmapEvent(cwd, {
    actor: input.workerId?.trim() || input.kind,
    type: "note.appended",
    scope,
    summary: `Appended ${input.kind} note: ${input.title}.`,
    details: {
      kind: input.kind,
      blocking: input.blocking ?? false,
      status: input.status ?? "open",
    },
  });
  return filePath;
  });
}

export async function amend(cwd: string, input: AmendmentInput): Promise<string> {
  return await withStoreWriteLock(cwd, async () => {
  const loaded = await loadState(cwd);
  if (!loaded.active?.roadmap_id || !loaded.roadmap) throw new Error("No active roadmap");
  if (input.material && !input.approvedBy) {
    throw new Error("Material amendments require approval");
  }

  const approvedLine = input.approvedBy
    ? `Approved by ${input.approvedBy}: ${input.approvalSummary ?? "No summary provided"}`
    : "Clerical amendment; approval not required.";
  const entry = `\n## ${input.title}\n\n- Scope: ${input.scope}\n- Material: ${input.material ? "yes" : "no"}\n- ${approvedLine}\n- At: ${nowIso()}\n\n${input.body.trimEnd()}\n`;

  if (input.scope === "roadmap") {
    await appendText(decisionsPath(cwd, loaded.active.roadmap_id), entry);
    await appendRoadmapEvent(cwd, {
      actor: input.approvedBy?.trim() || "user",
      type: "amendment.recorded",
      scope: { roadmap_id: loaded.active.roadmap_id },
      summary: `Recorded ${input.scope} amendment: ${input.title}.`,
      details: {
        scope: input.scope,
        material: input.material,
      },
    });
    return decisionsPath(cwd, loaded.active.roadmap_id);
  }

  const milestoneId = loaded.active.milestone_id;
  if (!milestoneId) throw new Error("Milestone amendment requires an active milestone");
  const { filePath, scope } = await appendNoteEntry(cwd, {
    kind: "decision",
    roadmapId: loaded.active.roadmap_id,
    milestoneId,
    title: input.title,
    body: entry,
    blocking: false,
    status: "resolved",
  });
  await appendRoadmapEvent(cwd, {
    actor: input.approvedBy?.trim() || "user",
    type: "amendment.recorded",
    scope,
    summary: `Recorded ${input.scope} amendment: ${input.title}.`,
    details: {
      scope: input.scope,
      material: input.material,
    },
  });
  return filePath;
  });
}

export async function createChangeRequest(
  cwd: string,
  input: CreateChangeRequestInput,
): Promise<ChangeRequest> {
  return await withStoreWriteLock(cwd, async () => {
  assertSlug(input.changeRequestId, "changeRequestId");
  const loaded = await loadState(cwd);
  if (!loaded.active?.roadmap_id || !loaded.active.milestone_id || !loaded.roadmap) {
    throw new Error("Change requests require an active roadmap and milestone");
  }
  if (loaded.active.change_request_id || loaded.roadmap.active_change_request_id) {
    throw new Error("Only one active change request is allowed");
  }
  if (!["reviewing", "closeout", "complete"].includes(loaded.roadmap.phase)) {
    throw new Error("Change requests are allowed only after implementation has produced changes");
  }

  const change: ChangeRequest = {
    roadmap_id: loaded.active.roadmap_id,
    milestone_id: loaded.active.milestone_id,
    change_request_id: input.changeRequestId,
    title: input.title,
    status: "draft",
    requested_at: nowIso(),
    request: input.request,
    approvals: [],
    verification_commands: input.verificationCommands,
    acceptance_criteria: input.acceptanceCriteria,
    user_interview: input.userInterview ?? [],
    relevant_existing_code: input.relevantExistingCode ?? [],
    relevant_documentation: input.relevantDocumentation ?? [],
    decisions: input.decisions ?? [],
    dependency_analysis: input.dependencyAnalysis ?? [],
    tasks: input.tasks,
    waves: input.waves,
    progress: initialProgress(input.waves),
    wave_flow_check: pendingWaveFlowCheck(),
  };

  await writeChangeRequest(cwd, change);
  loaded.roadmap.active_change_request_id = change.change_request_id;
  await writeRoadmapState(cwd, loaded.roadmap);
  await writeActive(cwd, {
    roadmap_id: change.roadmap_id,
    milestone_id: change.milestone_id,
    change_request_id: change.change_request_id,
    updated_at: nowIso(),
  });
  await appendRoadmapEvent(cwd, {
    actor: "user",
    type: "change.created",
    scope: {
      roadmap_id: change.roadmap_id,
      milestone_id: change.milestone_id,
      change_request_id: change.change_request_id,
    },
    summary: `Created change request ${change.change_request_id}.`,
    after: {
      status: change.status,
      task_count: change.tasks.length,
      wave_count: change.waves.length,
    },
  });
  return change;
  });
}

export async function resetRoadmapStateForTest(cwd: string): Promise<void> {
  await fs.rm(roadmapsDir(cwd), { recursive: true, force: true });
}
