import * as fs from "node:fs/promises";
import { milestoneNotesPath } from "./paths";
import { parseMarkdownDocument } from "./frontmatter";
import { loadState } from "./store";
import { PHASES, type ChangeRequest, type LoadedState, type MilestonePlan, type ValidationIssue, type ValidationResult } from "./types";

const ROADMAP_APPROVED_INDEX = PHASES.indexOf("roadmap_approved");
const MILESTONE_APPROVED_INDEX = PHASES.indexOf("milestone_approved");

function issue(code: string, message: string, path?: string): ValidationIssue {
  return path ? { code, message, path } : { code, message };
}

function phaseIndex(phase: string): number {
  return PHASES.indexOf(phase as never);
}

function hasApproval(approvals: { by: string; at: string; summary: string }[]): boolean {
  return approvals.length > 0;
}

function validateMilestonePlan(plan: MilestonePlan, errors: ValidationIssue[]): void {
  if (!plan.milestone_id) errors.push(issue("milestone.id.missing", "Milestone ID is required"));
  if (!plan.title) errors.push(issue("milestone.title.missing", "Milestone title is required"));
  if (plan.cleanup_policy !== "approval-gated") {
    errors.push(issue("milestone.cleanup.invalid", "Cleanup policy must be approval-gated"));
  }
  if (plan.open_questions.length > 0) {
    errors.push(issue("milestone.questions.open", "Milestone has open material questions"));
  }
  if (plan.verification_commands.length === 0) {
    errors.push(issue("milestone.verify.missing", "Milestone plan must define verification commands"));
  }
  if (plan.acceptance_criteria.length === 0) {
    errors.push(issue("milestone.acceptance.missing", "Milestone plan must define acceptance criteria"));
  }
  if (plan.tasks.length === 0) errors.push(issue("milestone.tasks.missing", "Milestone plan must define tasks"));
  if (plan.waves.length === 0) errors.push(issue("milestone.waves.missing", "Milestone plan must define waves"));

  const taskIds = new Set<string>();
  for (const task of plan.tasks) {
    if (taskIds.has(task.id)) errors.push(issue("task.duplicate", `Duplicate task id: ${task.id}`));
    taskIds.add(task.id);
    if (!task.worker) errors.push(issue("task.worker.missing", `Task ${task.id} must assign a worker`));
    if (task.owned_files.length === 0 && task.owned_modules.length === 0) {
      errors.push(issue("task.ownership.missing", `Task ${task.id} must own files or modules`));
    }
  }

  const waveIds = new Set<string>();
  for (const wave of plan.waves) {
    if (waveIds.has(wave.id)) errors.push(issue("wave.duplicate", `Duplicate wave id: ${wave.id}`));
    waveIds.add(wave.id);
    const owned = new Map<string, string>();
    for (const taskId of wave.tasks) {
      const task = plan.tasks.find((candidate) => candidate.id === taskId);
      if (!task) {
        errors.push(issue("wave.task.unknown", `Wave ${wave.id} references unknown task ${taskId}`));
        continue;
      }
      for (const owner of [...task.owned_files, ...task.owned_modules]) {
        const previous = owned.get(owner);
        if (previous) {
          errors.push(
            issue(
              "wave.ownership.overlap",
              `Wave ${wave.id} has overlapping ownership for ${owner}: ${previous} and ${task.id}`,
            ),
          );
        }
        owned.set(owner, task.id);
      }
    }
  }
}

function validateChangeRequest(change: ChangeRequest, errors: ValidationIssue[]): void {
  if (change.status !== "draft" && !hasApproval(change.approvals)) {
    errors.push(issue("change.approval.missing", "Change request implementation requires plan approval"));
  }
  validateMilestonePlan(
    {
      roadmap_id: change.roadmap_id,
      milestone_id: change.milestone_id,
      title: change.title,
      status: "milestone_approved",
      approvals: change.approvals,
      open_questions: [],
      verification_commands: change.verification_commands,
      acceptance_criteria: change.acceptance_criteria,
      cleanup_policy: "approval-gated",
      tasks: change.tasks,
      waves: change.waves,
    },
    errors,
  );
}

async function findOpenBlockingNotes(
  cwd: string,
  state: LoadedState,
): Promise<ValidationIssue[]> {
  if (!state.active?.roadmap_id || !state.active.milestone_id) return [];
  const filePath = milestoneNotesPath(cwd, state.active.roadmap_id, state.active.milestone_id);
  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const errors: ValidationIssue[] = [];
  const entries = text.split(/\n(?=---\nkind:)/g);
  for (const entry of entries) {
    if (!entry.startsWith("---\n")) continue;
    try {
      const doc = parseMarkdownDocument<Record<string, unknown>>(entry);
      if (doc.data.blocking === true && doc.data.status !== "resolved" && doc.data.status !== "deferred") {
        errors.push(issue("notes.blocking.open", "Open blocking note must be resolved or explicitly deferred"));
      }
    } catch {
      errors.push(issue("notes.malformed", "Milestone note entry has malformed frontmatter"));
    }
  }
  return errors;
}

export async function validateRoadmapState(cwd: string): Promise<ValidationResult> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  let state: LoadedState;

  try {
    state = await loadState(cwd);
  } catch (error) {
    return {
      valid: false,
      errors: [issue("state.unreadable", error instanceof Error ? error.message : String(error))],
      warnings,
    };
  }

  if (!state.active) return { valid: true, errors, warnings };
  if (!state.roadmap) {
    errors.push(issue("roadmap.missing", "Active pointer references a missing roadmap"));
    return { valid: false, errors, warnings };
  }

  const roadmap = state.roadmap;
  if (phaseIndex(roadmap.phase) === -1) errors.push(issue("phase.invalid", `Invalid phase: ${roadmap.phase}`));
  if (!roadmap.roadmap_id) errors.push(issue("roadmap.id.missing", "Roadmap ID is required"));
  if (!roadmap.title) errors.push(issue("roadmap.title.missing", "Roadmap title is required"));
  if (roadmap.open_questions.length > 0 && phaseIndex(roadmap.phase) >= ROADMAP_APPROVED_INDEX) {
    errors.push(issue("roadmap.questions.open", "Roadmap cannot be approved while material questions remain"));
  }
  if (phaseIndex(roadmap.phase) >= ROADMAP_APPROVED_INDEX) {
    if (!roadmap.discovery.recorded) {
      errors.push(issue("discovery.missing", "Roadmap approval requires recorded repo discovery"));
    }
    if (roadmap.discovery.external_research_required && !roadmap.discovery.external_research_recorded) {
      errors.push(issue("research.missing", "Required external research has not been recorded"));
    }
    if (!hasApproval(roadmap.approvals)) {
      errors.push(issue("roadmap.approval.missing", "Roadmap approval must be recorded"));
    }
  }

  const milestoneIds = new Set<string>();
  for (const milestone of roadmap.milestones) {
    if (milestoneIds.has(milestone.id)) {
      errors.push(issue("milestone.duplicate", `Duplicate milestone id: ${milestone.id}`));
    }
    milestoneIds.add(milestone.id);
  }

  if (state.active.milestone_id && !state.milestone) {
    errors.push(issue("milestone.missing", "Active pointer references a missing milestone"));
  }

  if (state.milestone) {
    validateMilestonePlan(state.milestone, errors);
    if (phaseIndex(roadmap.phase) >= MILESTONE_APPROVED_INDEX && !hasApproval(state.milestone.approvals)) {
      errors.push(issue("milestone.approval.missing", "Milestone approval must be recorded"));
    }
  }

  if (state.active.change_request_id && !state.changeRequest) {
    errors.push(issue("change.missing", "Active pointer references a missing change request"));
  }

  if (state.changeRequest) validateChangeRequest(state.changeRequest, errors);
  errors.push(...(await findOpenBlockingNotes(cwd, state)));

  if (roadmap.bypass?.active) {
    warnings.push(issue("bypass.active", `Bypass is active: ${roadmap.bypass.reason}`));
  }

  return { valid: errors.length === 0, errors, warnings };
}

export async function validateImplementationGate(cwd: string): Promise<ValidationResult> {
  const result = await validateRoadmapState(cwd);
  if (!result.valid) return result;
  const state = await loadState(cwd);
  if (!state.active || !state.roadmap) return result;
  if (state.roadmap.bypass?.active) return result;

  const errors: ValidationIssue[] = [...result.errors];
  if (!["implementing", "reviewing"].includes(state.roadmap.phase)) {
    errors.push(
      issue(
        "gate.phase.closed",
        `File writes require phase implementing or reviewing; current phase is ${state.roadmap.phase}`,
      ),
    );
  }
  if (!state.milestone || !hasApproval(state.milestone.approvals)) {
    errors.push(issue("gate.milestone.unapproved", "File writes require an approved milestone plan"));
  }
  if (state.changeRequest && state.changeRequest.status !== "approved" && state.changeRequest.status !== "implementing") {
    errors.push(issue("gate.change.unapproved", "Active change request must be approved before file writes"));
  }

  return { valid: errors.length === 0, errors, warnings: result.warnings };
}
