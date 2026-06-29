import * as fs from "node:fs/promises";
import * as path from "node:path";
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
import {
  parseMarkdownDocument,
  parseYaml,
  serializeMarkdownDocument,
  serializeYaml,
} from "./frontmatter";
import type {
  ActivePointer,
  Approval,
  ChangeRequest,
  LoadedState,
  MilestonePlan,
  Phase,
  RoadmapState,
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
  tasks: MilestonePlan["tasks"];
  waves: MilestonePlan["waves"];
  openQuestions?: string[];
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
  tasks: ChangeRequest["tasks"];
  waves: ChangeRequest["waves"];
}

export interface TransitionInput {
  operation:
    | "approve_roadmap"
    | "start_milestone_planning"
    | "create_milestone_plan"
    | "approve_milestone"
    | "start_implementation"
    | "start_reviewing"
    | "start_closeout"
    | "complete_milestone"
    | "request_bypass"
    | "clear_bypass"
    | "approve_change"
    | "close_change";
  approver?: string;
  summary?: string;
  reason?: string;
  milestone?: CreateMilestonePlanInput;
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf8");
}

async function writeText(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function readYamlFile<T>(filePath: string): Promise<T> {
  return parseYaml<T>(await readText(filePath));
}

async function writeYamlFile(filePath: string, data: unknown): Promise<void> {
  await writeText(filePath, serializeYaml(data));
}

export async function loadActive(cwd: string): Promise<ActivePointer | undefined> {
  const filePath = activePointerPath(cwd);
  if (!(await fileExists(filePath))) return undefined;
  return await readYamlFile<ActivePointer>(filePath);
}

export async function writeActive(cwd: string, active: ActivePointer): Promise<void> {
  await writeYamlFile(activePointerPath(cwd), active);
}

export async function loadRoadmapState(cwd: string, roadmapId: string): Promise<RoadmapState> {
  return await readYamlFile<RoadmapState>(roadmapStatePath(cwd, roadmapId));
}

export async function writeRoadmapState(cwd: string, state: RoadmapState): Promise<void> {
  state.updated_at = nowIso();
  await writeYamlFile(roadmapStatePath(cwd, state.roadmap_id), state);
}

export async function loadMilestonePlan(
  cwd: string,
  roadmapId: string,
  milestoneId: string,
): Promise<MilestonePlan> {
  const doc = parseMarkdownDocument<Record<string, unknown>>(
    await readText(milestonePlanPath(cwd, roadmapId, milestoneId)),
  );
  return doc.data as unknown as MilestonePlan;
}

export async function writeMilestonePlan(
  cwd: string,
  plan: MilestonePlan,
  body: string,
): Promise<void> {
  await writeText(
    milestonePlanPath(cwd, plan.roadmap_id, plan.milestone_id),
    serializeMarkdownDocument({ ...plan } as unknown as Record<string, unknown>, body),
  );
}

export async function loadChangeRequest(
  cwd: string,
  roadmapId: string,
  milestoneId: string,
  changeRequestId: string,
): Promise<ChangeRequest> {
  const doc = parseMarkdownDocument<Record<string, unknown>>(
    await readText(changeRequestPath(cwd, roadmapId, milestoneId, changeRequestId)),
  );
  return doc.data as unknown as ChangeRequest;
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

  const loaded: LoadedState = { active, roadmap };
  if (milestone) loaded.milestone = milestone;
  if (changeRequest) loaded.changeRequest = changeRequest;
  return loaded;
}

export async function initRoadmap(cwd: string, input: InitRoadmapInput): Promise<RoadmapState> {
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
    serializeMarkdownDocument(
      { roadmap_id: input.roadmapId, title: input.title, status: "draft" },
      `# ${input.title}\n\n${input.summary ?? "Roadmap intent, milestones, risks, and success criteria are drafted here."}\n`,
    ),
  );
  await writeText(decisionsPath(cwd, input.roadmapId), "# Decision Register\n");
  await writeText(risksPath(cwd, input.roadmapId), "# Risk Register\n");
  return state;
}

export async function createMilestonePlan(
  cwd: string,
  roadmap: RoadmapState,
  input: CreateMilestonePlanInput,
): Promise<MilestonePlan> {
  assertSlug(input.milestoneId, "milestoneId");
  if (roadmap.milestones.some((milestone) => milestone.id === input.milestoneId)) {
    throw new Error(`Milestone already exists: ${input.milestoneId}`);
  }

  const plan: MilestonePlan = {
    roadmap_id: roadmap.roadmap_id,
    milestone_id: input.milestoneId,
    title: input.title,
    status: "milestone_planning",
    approvals: [],
    open_questions: input.openQuestions ?? [],
    verification_commands: input.verificationCommands,
    acceptance_criteria: input.acceptanceCriteria,
    cleanup_policy: "approval-gated",
    tasks: input.tasks,
    waves: input.waves,
  };

  await fs.mkdir(milestoneDir(cwd, roadmap.roadmap_id, input.milestoneId), { recursive: true });
  await writeMilestonePlan(cwd, plan, `# ${input.title}\n\nDecision-complete milestone plan.\n`);
  await writeText(milestoneNotesPath(cwd, roadmap.roadmap_id, input.milestoneId), "# Milestone Notes\n");
  await writeText(
    milestoneCloseoutPath(cwd, roadmap.roadmap_id, input.milestoneId),
    serializeMarkdownDocument(
      {
        roadmap_id: roadmap.roadmap_id,
        milestone_id: input.milestoneId,
        status: "open",
      },
      "# Closeout Evidence\n",
    ),
  );

  roadmap.milestones.push({
    id: input.milestoneId,
    title: input.title,
    status: "milestone_planning",
  });
  roadmap.active_milestone_id = input.milestoneId;
  roadmap.phase = "milestone_planning";
  await writeRoadmapState(cwd, roadmap);
  await writeActive(cwd, {
    roadmap_id: roadmap.roadmap_id,
    milestone_id: input.milestoneId,
    updated_at: nowIso(),
  });

  return plan;
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

export async function transition(cwd: string, input: TransitionInput): Promise<LoadedState> {
  const loaded = await loadState(cwd);
  if (!loaded.active || !loaded.roadmap) {
    throw new Error("No active roadmap. Run /roadmap:new first.");
  }

  const roadmap = loaded.roadmap;
  const activeMilestoneId = loaded.active.milestone_id ?? roadmap.active_milestone_id;

  switch (input.operation) {
    case "approve_roadmap":
      roadmap.phase = "roadmap_approved";
      roadmap.approvals.push(approval(input.approver, input.summary));
      break;
    case "start_milestone_planning":
      roadmap.phase = "milestone_planning";
      break;
    case "create_milestone_plan":
      if (!input.milestone) throw new Error("create_milestone_plan requires milestone input");
      await createMilestonePlan(cwd, roadmap, input.milestone);
      return await loadState(cwd);
    case "approve_milestone": {
      if (!activeMilestoneId || !loaded.milestone) throw new Error("No active milestone to approve");
      const plan = { ...loaded.milestone, status: "milestone_approved" as Phase };
      plan.approvals.push(approval(input.approver, input.summary));
      await writeMilestonePlan(cwd, plan, `# ${plan.title}\n\nDecision-complete milestone plan.\n`);
      roadmap.phase = "milestone_approved";
      setMilestoneStatus(roadmap, activeMilestoneId, "milestone_approved");
      break;
    }
    case "start_implementation":
      roadmap.phase = "implementing";
      if (activeMilestoneId) setMilestoneStatus(roadmap, activeMilestoneId, "implementing");
      break;
    case "start_reviewing":
      roadmap.phase = "reviewing";
      if (activeMilestoneId) setMilestoneStatus(roadmap, activeMilestoneId, "reviewing");
      break;
    case "start_closeout":
      roadmap.phase = "closeout";
      if (activeMilestoneId) setMilestoneStatus(roadmap, activeMilestoneId, "closeout");
      break;
    case "complete_milestone":
      roadmap.phase = "complete";
      if (activeMilestoneId) setMilestoneStatus(roadmap, activeMilestoneId, "complete");
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
      const change = {
        ...loaded.changeRequest,
        status: "approved" as const,
        approvals: [...loaded.changeRequest.approvals, approval(input.approver, input.summary)],
      };
      await writeText(
        changeRequestPath(cwd, roadmap.roadmap_id, activeMilestoneId, change.change_request_id),
        serializeMarkdownDocument({ ...change } as unknown as Record<string, unknown>, `# ${change.title}\n\n${change.request}\n`),
      );
      break;
    }
    case "close_change":
      delete roadmap.active_change_request_id;
      await writeActive(cwd, {
        roadmap_id: roadmap.roadmap_id,
        ...(activeMilestoneId ? { milestone_id: activeMilestoneId } : {}),
        updated_at: nowIso(),
      });
      break;
    default:
      input.operation satisfies never;
  }

  await writeRoadmapState(cwd, roadmap);
  return await loadState(cwd);
}

export async function appendNote(cwd: string, input: AppendNoteInput): Promise<string> {
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
  await fs.appendFile(filePath, entry, "utf8");
  return filePath;
}

export async function amend(cwd: string, input: AmendmentInput): Promise<string> {
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
    await fs.appendFile(decisionsPath(cwd, loaded.active.roadmap_id), entry, "utf8");
    return decisionsPath(cwd, loaded.active.roadmap_id);
  }

  const milestoneId = loaded.active.milestone_id;
  if (!milestoneId) throw new Error("Milestone amendment requires an active milestone");
  await appendNote(cwd, {
    kind: "decision",
    roadmapId: loaded.active.roadmap_id,
    milestoneId,
    title: input.title,
    body: entry,
    blocking: false,
    status: "resolved",
  });
  return milestoneNotesPath(cwd, loaded.active.roadmap_id, milestoneId);
}

export async function createChangeRequest(
  cwd: string,
  input: CreateChangeRequestInput,
): Promise<ChangeRequest> {
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
    tasks: input.tasks,
    waves: input.waves,
  };

  await writeText(
    changeRequestPath(cwd, change.roadmap_id, change.milestone_id, change.change_request_id),
    serializeMarkdownDocument({ ...change } as unknown as Record<string, unknown>, `# ${change.title}\n\n${change.request}\n`),
  );
  loaded.roadmap.active_change_request_id = change.change_request_id;
  await writeRoadmapState(cwd, loaded.roadmap);
  await writeActive(cwd, {
    roadmap_id: change.roadmap_id,
    milestone_id: change.milestone_id,
    change_request_id: change.change_request_id,
    updated_at: nowIso(),
  });
  return change;
}

export async function resetRoadmapStateForTest(cwd: string): Promise<void> {
  await fs.rm(roadmapsDir(cwd), { recursive: true, force: true });
}
