import * as fs from "node:fs/promises";
import { milestoneNotesPath } from "./paths";
import { readText } from "./files";
import { parseMarkdownDocument } from "./frontmatter";
import { roadmapDocPath } from "./paths";
import { loadRoadmapBlockers, loadState, roadmapContentHash, renderRoadmapMarkdown } from "./store";
import { validateCloseoutEvidence } from "./closeout";
import { issue, validateChangeRequest, validateMilestonePlan } from "./plan-validation";
import { PHASES, type LoadedState, type RoadmapBlocker, type RoadmapMilestoneOutline, type RoadmapState, type ValidationIssue, type ValidationResult } from "./types";

const ROADMAP_APPROVED_INDEX = PHASES.indexOf("roadmap_approved");
const MILESTONE_APPROVED_INDEX = PHASES.indexOf("milestone_approved");
const BYPASSABLE_GATE_ERROR_CODES = new Set(["notes.blocking.open"]);

function phaseIndex(phase: string): number {
  return PHASES.indexOf(phase as never);
}

function hasApproval(approvals: { by: string; at: string; summary: string }[]): boolean {
  return approvals.length > 0;
}

function hasContent(value: string | undefined): boolean {
  if (!value || value.trim() === "") return false;
  return !/\b(TBD|TODO)\b/i.test(value);
}

function validateContent(value: string | undefined, code: string, message: string, errors: ValidationIssue[]): void {
  if (!hasContent(value)) errors.push(issue(code, message));
}

function validateContentList(
  values: string[] | undefined,
  code: string,
  message: string,
  errors: ValidationIssue[],
  allowEmpty = false,
): void {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    errors.push(issue(code, message));
    return;
  }
  for (const value of values) {
    if (!hasContent(value)) {
      errors.push(issue(code, `${message}: ${value || "(empty)"}`));
      return;
    }
  }
}

async function validateGeneratedRoadmapDoc(
  cwd: string,
  roadmap: RoadmapState,
  errors: ValidationIssue[],
): Promise<void> {
  if (!roadmap.roadmap_finalized) return;
  if (roadmap.roadmap_content_hash !== roadmapContentHash(roadmap)) {
    errors.push(issue("roadmap.content_hash.stale", "roadmap content hash must match the generated roadmap state"));
  }
  try {
    const actual = await readText(roadmapDocPath(cwd, roadmap.roadmap_id));
    const expected = renderRoadmapMarkdown(roadmap);
    if (actual !== expected) {
      errors.push(issue("roadmap.doc.stale", "roadmap.md must match the generated roadmap state"));
    }
  } catch (error) {
    errors.push(issue("roadmap.doc.missing", error instanceof Error ? error.message : String(error)));
  }
}

function validateRoadmapMilestoneCheck(roadmap: RoadmapState, errors: ValidationIssue[]): void {
  if (!roadmap.roadmap_finalized) return;

  const check = roadmap.roadmap_milestone_check;
  if (!check || check.status === "pending") {
    errors.push(issue(
      "roadmap.milestone_check.pending",
      `Roadmap milestone check is pending for revision ${roadmap.roadmap_revision}`,
    ));
    return;
  }

  if (check.roadmap_revision !== roadmap.roadmap_revision || check.roadmap_content_hash !== roadmap.roadmap_content_hash) {
    errors.push(issue(
      "roadmap.milestone_check.stale",
      `Roadmap milestone check is stale: checked revision ${check.roadmap_revision}, current revision ${roadmap.roadmap_revision}`,
    ));
    return;
  }

  if (check.status === "failed") {
    const latestFinding = check.findings[0] ? ` Latest finding: ${check.findings[0]}` : "";
    errors.push(issue(
      "roadmap.milestone_check.failed",
      `Roadmap milestone check failed.${latestFinding}`,
    ));
    return;
  }

  if (check.status !== "passed") {
    errors.push(issue("roadmap.milestone_check.not_passed", "Roadmap requires a passed roadmap-milestone check before approval"));
    return;
  }

  if (!check.checked_by || check.checked_by.trim() === "") {
    errors.push(issue("roadmap.milestone_check.checked_by.missing", "Passed roadmap-milestone check must record who checked it"));
  }
  if (!check.checked_at || check.checked_at.trim() === "") {
    errors.push(issue("roadmap.milestone_check.checked_at.missing", "Passed roadmap-milestone check must record when it ran"));
  }
  if (!check.summary || check.summary.trim() === "") {
    errors.push(issue("roadmap.milestone_check.summary.missing", "Passed roadmap-milestone check must include a summary"));
  }
  if (!check.event_id || check.event_id.trim() === "") {
    errors.push(issue("roadmap.milestone_check.event_id.missing", "Passed roadmap-milestone check must record its quality gate event id"));
  }
}

function validateMilestoneOutline(
  milestone: RoadmapMilestoneOutline,
  milestoneIds: Set<string>,
  errors: ValidationIssue[],
): void {
  validateContent(milestone.id, "roadmap.milestone.id.missing", "Roadmap milestone ID is required", errors);
  validateContent(milestone.title, "roadmap.milestone.title.missing", `Roadmap milestone ${milestone.id} requires a title`, errors);
  validateContent(milestone.goal, "roadmap.milestone.goal.missing", `Roadmap milestone ${milestone.id} requires a goal`, errors);
  validateContentList(milestone.scope, "roadmap.milestone.scope.missing", `Roadmap milestone ${milestone.id} requires concrete scope`, errors);
  validateContentList(milestone.non_goals, "roadmap.milestone.non_goals.missing", `Roadmap milestone ${milestone.id} requires concrete non-goals`, errors);
  validateContentList(milestone.evidence, "roadmap.milestone.evidence.missing", `Roadmap milestone ${milestone.id} requires concrete evidence`, errors);
  validateContentList(milestone.dependencies, "roadmap.milestone.dependencies.invalid", `Roadmap milestone ${milestone.id} has invalid dependencies`, errors, true);
  validateContentList(milestone.risks, "roadmap.milestone.risks.missing", `Roadmap milestone ${milestone.id} requires concrete risks`, errors);
  validateContentList(milestone.acceptance_intent, "roadmap.milestone.acceptance.missing", `Roadmap milestone ${milestone.id} requires acceptance intent`, errors);
  validateContentList(milestone.verification_intent, "roadmap.milestone.verification.missing", `Roadmap milestone ${milestone.id} requires verification intent`, errors);

  for (const dependency of milestone.dependencies ?? []) {
    if (!milestoneIds.has(dependency)) {
      errors.push(issue("roadmap.milestone.dependency.unknown", `Roadmap milestone ${milestone.id} depends on unknown milestone ${dependency}`));
    }
  }
}

async function validateRoadmapOutline(cwd: string, roadmap: RoadmapState, errors: ValidationIssue[]): Promise<void> {
  if (!roadmap.roadmap_finalized) {
    errors.push(issue("roadmap.finalized.missing", "Roadmap must be finalized with roadmap_engineer_update_roadmap before approval"));
  }
  validateContent(roadmap.goal, "roadmap.goal.missing", "Roadmap requires a concrete goal", errors);
  validateContentList(roadmap.success_criteria, "roadmap.success.missing", "Roadmap requires concrete success criteria", errors);
  validateContentList(roadmap.constraints, "roadmap.constraints.missing", "Roadmap requires concrete constraints", errors);
  validateContentList(roadmap.non_goals, "roadmap.non_goals.missing", "Roadmap requires concrete non-goals", errors);
  validateContentList(roadmap.context, "roadmap.context.missing", "Roadmap requires concrete context", errors);
  validateContentList(roadmap.evidence, "roadmap.evidence.missing", "Roadmap requires concrete evidence", errors);
  validateContentList(roadmap.risks, "roadmap.risks.missing", "Roadmap requires concrete risks", errors);

  if (!Array.isArray(roadmap.milestones) || roadmap.milestones.length === 0) {
    errors.push(issue("roadmap.milestones.missing", "Roadmap requires at least one concrete milestone outline"));
  }

  const milestoneIds = new Set<string>();
  for (const milestone of roadmap.milestones ?? []) {
    if (milestoneIds.has(milestone.id)) {
      errors.push(issue("milestone.duplicate", `Duplicate milestone id: ${milestone.id}`));
    }
    milestoneIds.add(milestone.id);
  }
  for (const milestone of roadmap.milestones ?? []) validateMilestoneOutline(milestone, milestoneIds, errors);
  await validateGeneratedRoadmapDoc(cwd, roadmap, errors);
  validateRoadmapMilestoneCheck(roadmap, errors);
}

async function findOpenBlockingNotes(
  cwd: string,
  state: LoadedState,
  canonicalBlockers: RoadmapBlocker[],
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
      if (
        doc.data.blocking === true &&
        doc.data.status !== "resolved" &&
        doc.data.status !== "deferred" &&
        !hasCanonicalBlockerForNote(doc.data, canonicalBlockers)
      ) {
        errors.push(issue("notes.blocking.open", "Open blocking note must be resolved or explicitly deferred"));
      }
    } catch {
      errors.push(issue("notes.malformed", "Milestone note entry has malformed frontmatter"));
    }
  }
  return errors;
}

function hasCanonicalBlockerForNote(
  metadata: Record<string, unknown>,
  canonicalBlockers: RoadmapBlocker[],
): boolean {
  if (typeof metadata.blocker_id === "string") {
    return canonicalBlockers.some((blocker) => blocker.id === metadata.blocker_id);
  }

  return canonicalBlockers.some((blocker) =>
    blocker.roadmap_id === metadata.roadmap_id &&
    blocker.milestone_id === metadata.milestone_id &&
    (blocker.change_request_id ?? undefined) === (typeof metadata.change_request_id === "string" ? metadata.change_request_id : undefined) &&
    (blocker.task_id ?? undefined) === (typeof metadata.task_id === "string" ? metadata.task_id : undefined) &&
    (blocker.wave_id ?? undefined) === (typeof metadata.wave_id === "string" ? metadata.wave_id : undefined),
  );
}

function openCanonicalBlockingIssues(blockers: RoadmapBlocker[]): ValidationIssue[] {
  return blockers
    .filter((blocker) => blocker.severity === "blocking" && blocker.status === "open")
    .map((blocker) =>
      issue(
        "blockers.blocking.open",
        `Open blocking blocker must be resolved or deferred: ${blocker.title}`,
        blocker.note_path,
      ),
    );
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

  await validateRoadmapOutline(cwd, roadmap, errors);

  if (state.active.milestone_id && !state.milestone) {
    errors.push(issue("milestone.missing", "Active pointer references a missing milestone"));
  }

  if (state.milestone) {
    validateMilestonePlan(state.milestone, errors);
    if (phaseIndex(roadmap.phase) >= MILESTONE_APPROVED_INDEX && !hasApproval(state.milestone.approvals)) {
      errors.push(issue("milestone.approval.missing", "Milestone approval must be recorded"));
    }
    if (roadmap.phase === "complete") {
      validateCloseoutEvidence(
        state.closeout,
        state.milestone.acceptance_criteria,
        state.milestone.verification_commands,
        errors,
        "closeout",
      );
    }
  }

  if (state.active.change_request_id && !state.changeRequest) {
    errors.push(issue("change.missing", "Active pointer references a missing change request"));
  }

  if (state.changeRequest) {
    validateChangeRequest(state.changeRequest, errors);
    if (state.changeRequest.status === "closed") {
      validateCloseoutEvidence(
        state.changeRequest.closeout,
        state.changeRequest.acceptance_criteria,
        state.changeRequest.verification_commands,
        errors,
        "change.closeout",
      );
    }
  }
  const canonicalBlockers = await loadRoadmapBlockers(cwd, roadmap.roadmap_id);
  errors.push(...openCanonicalBlockingIssues(canonicalBlockers));
  errors.push(...(await findOpenBlockingNotes(cwd, state, canonicalBlockers)));

  if (roadmap.bypass?.active) {
    warnings.push(issue("bypass.active", `Bypass is active: ${roadmap.bypass.reason}`));
  }

  return { valid: errors.length === 0, errors, warnings };
}

export async function validateImplementationGate(cwd: string): Promise<ValidationResult> {
  const result = await validateRoadmapState(cwd);
  const state = await loadState(cwd);
  if (!state.active || !state.roadmap) return result;
  if (state.roadmap.bypass?.active) {
    const errors = result.errors.filter((error) => !BYPASSABLE_GATE_ERROR_CODES.has(error.code));
    return { valid: errors.length === 0, errors, warnings: result.warnings };
  }
  if (!result.valid) return result;

  const errors: ValidationIssue[] = [...result.errors];
  const activeChangeApproved =
    state.changeRequest &&
    ["approved", "implementing"].includes(state.changeRequest.status) &&
    ["reviewing", "closeout", "complete"].includes(state.roadmap.phase);
  if (!activeChangeApproved && !["implementing", "reviewing"].includes(state.roadmap.phase)) {
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
  if (state.changeRequest && !["approved", "implementing"].includes(state.changeRequest.status)) {
    errors.push(issue("gate.change.unapproved", "Active change request must be approved before file writes"));
  }

  return { valid: errors.length === 0, errors, warnings: result.warnings };
}
