import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { readRoadmapEvents } from "../../src/core/events";
import { shouldBlockToolCall } from "../../src/core/gate";
import { applyNextAction, nextActionPlan, renderReport } from "../../src/core/report/index";
import {
  appendNote,
  createChangeRequest,
  deferBlocker,
  initRoadmap,
  listBlockers,
  loadRoadmapBlockers,
  loadState,
  listQualityGates,
  openBlocker,
  repairRoadmap,
  renderRoadmapMarkdown,
  resetRoadmapStateForTest,
  resolveBlocker,
  transition,
  updateRoadmap,
  writeRoadmapState,
} from "../../src/core/store/index";
import {
  changeRequestPath,
  changeRequestRuntimePath,
  decisionsPath,
  milestoneNotesPath,
  milestonePlanPath,
  milestoneRuntimePath,
  roadmapBlockersPath,
  roadmapDocPath,
  storeLockPath,
} from "../../src/core/paths";
import { validateImplementationGate, validateRoadmapState } from "../../src/core/validation";
import { summarizeState } from "../../src/core/state-summary";
import { readYamlFile, writeYamlFile } from "../../src/core/files";
import {
  prepareWaveDispatch,
  prepareWaveReview,
  recordWorkerAbandoned,
  recordWorkerDispatch,
  recordWorkerTransportFailed,
  recordWaveResult,
  recordWaveReview,
} from "../../src/core/wave-orchestration/index";
import {
  additionalMilestone,
  approvedMilestone as approvedMilestoneForCwd,
  approvedRoadmap as approvedRoadmapForCwd,
  removeTempRoadmapCwd,
  closeoutPhase as closeoutPhaseForCwd,
  closedEvidence,
  createTempRoadmapCwd,
  manuallyWriteRoadmapState as manuallyWriteRoadmapStateForCwd,
  milestoneInput,
  recordPassedRoadmapMilestoneCheck as recordPassedRoadmapMilestoneCheckForCwd,
  recordPassedWaveFlowCheck as recordPassedWaveFlowCheckForCwd,
  roadmapInput,
  testWave,
} from "./helpers";

let cwd = "";

beforeEach(async () => {
  cwd = await createTempRoadmapCwd();
});

afterEach(async () => {
  await removeTempRoadmapCwd(cwd);
  cwd = "";
});

function approvedRoadmap(): Promise<void> {
  return approvedRoadmapForCwd(cwd);
}

function recordPassedWaveFlowCheck(summary?: string): Promise<void> {
  return recordPassedWaveFlowCheckForCwd(cwd, summary);
}

function recordPassedRoadmapMilestoneCheck(summary?: string): Promise<void> {
  return recordPassedRoadmapMilestoneCheckForCwd(cwd, summary);
}

function approvedMilestone(): Promise<void> {
  return approvedMilestoneForCwd(cwd);
}

function manuallyWriteRoadmapState(update: Parameters<typeof manuallyWriteRoadmapStateForCwd>[1]): Promise<void> {
  return manuallyWriteRoadmapStateForCwd(cwd, update);
}

function closeoutPhase(): Promise<void> {
  return closeoutPhaseForCwd(cwd);
}

describe("roadmap state lifecycle", () => {
  test("initializes active roadmap and blocks implementation before approvals", async () => {
    await initRoadmap(cwd, { roadmapId: "test-roadmap", title: "Test Roadmap" });

    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.finalized.missing");

    const gate = await validateImplementationGate(cwd);
    expect(gate.valid).toBe(false);
    expect(gate.errors.map((error) => error.code)).toContain("roadmap.finalized.missing");
  });

  test("enforces discovery before roadmap approval and rejects repeated approval", async () => {
    await initRoadmap(cwd, { roadmapId: "strict-roadmap", title: "Strict Roadmap" });

    await expect(
      transition(cwd, { operation: "approve_roadmap", approver: "user" }),
    ).rejects.toThrow("approve_roadmap requires phase roadmap_draft");

    await transition(cwd, { operation: "record_discovery" });
    await updateRoadmap(cwd, roadmapInput());
    await recordPassedRoadmapMilestoneCheck();
    await transition(cwd, { operation: "approve_roadmap", approver: "user" });

    await expect(
      transition(cwd, { operation: "approve_roadmap", approver: "user" }),
    ).rejects.toThrow("approve_roadmap requires phase roadmap_draft");
  });

  test("requires external research before roadmap approval when discovery says it is needed", async () => {
    await initRoadmap(cwd, { roadmapId: "research-roadmap", title: "Research Roadmap" });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: { external_research_required: true, external_research_recorded: false },
    });

    await expect(
      transition(cwd, { operation: "approve_roadmap", approver: "user" }),
    ).rejects.toThrow("external research");

    await transition(cwd, {
      operation: "record_discovery",
      discovery: { external_research_recorded: true },
    });
    await updateRoadmap(cwd, roadmapInput());
    await recordPassedRoadmapMilestoneCheck();
    await transition(cwd, { operation: "approve_roadmap", approver: "user" });

    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(true);
  });

  test("requires finalized structured roadmap before approval", async () => {
    await initRoadmap(cwd, { roadmapId: "unfinalized-roadmap", title: "Unfinalized Roadmap" });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: { findings: ["Inspected local sources."] },
    });

    await expect(
      transition(cwd, { operation: "approve_roadmap", approver: "user" }),
    ).rejects.toThrow("finalized roadmap");
  });

  test("accepts a complete generated roadmap before approval", async () => {
    await initRoadmap(cwd, { roadmapId: "complete-roadmap", title: "Complete Roadmap" });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: { findings: ["Inspected local sources."] },
    });
    const state = await updateRoadmap(cwd, roadmapInput());

    expect(await fs.readFile(roadmapDocPath(cwd, state.roadmap_id), "utf8")).toBe(
      renderRoadmapMarkdown(state),
    );

    await recordPassedRoadmapMilestoneCheck();

    await transition(cwd, { operation: "approve_roadmap", approver: "user" });
    expect((await validateRoadmapState(cwd)).valid).toBe(true);
  });

  test("requires current passed roadmap-milestone check to record its event id", async () => {
    await initRoadmap(cwd, { roadmapId: "event-id-roadmap", title: "Event ID Roadmap" });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: { findings: ["Inspected local sources."] },
    });
    await updateRoadmap(cwd, roadmapInput());
    await recordPassedRoadmapMilestoneCheck();

    const state = await loadState(cwd);
    if (!state.roadmap) throw new Error("Expected roadmap state");
    expect(state.roadmap.roadmap_milestone_check.event_id).toMatch(/^evt_/);
    state.roadmap.roadmap_milestone_check.event_id = "";
    await writeRoadmapState(cwd, state.roadmap);

    const validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.milestone_check.event_id.missing");
    await expect(
      transition(cwd, { operation: "approve_roadmap", approver: "user" }),
    ).rejects.toThrow("quality gate event id");
  });

  test("draft roadmap updates make the previous roadmap-milestone check stale", async () => {
    await initRoadmap(cwd, { roadmapId: "reset-check-roadmap", title: "Reset Check Roadmap" });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: { findings: ["Inspected local sources."] },
    });
    await updateRoadmap(cwd, roadmapInput());
    await recordPassedRoadmapMilestoneCheck();
    const checked = await loadState(cwd);
    const checkedRevision = checked.roadmap?.roadmap_milestone_check.roadmap_revision;

    await updateRoadmap(cwd, roadmapInput({
      goal: "Refactor roadmap-engineer state safely after checker rerun.",
    }));

    const state = await loadState(cwd);
    expect(state.roadmap?.roadmap_revision).toBe((checkedRevision ?? 0) + 1);
    expect(state.roadmap?.roadmap_milestone_check.status).toBe("passed");
    expect(state.roadmap?.roadmap_milestone_check.roadmap_revision).toBe(checkedRevision);
    const validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.milestone_check.stale");
    await expect(
      transition(cwd, { operation: "approve_roadmap", approver: "user" }),
    ).rejects.toThrow("current roadmap revision");

    await recordPassedRoadmapMilestoneCheck("Rerun roadmap milestone check passed.");
    const refreshed = await loadState(cwd);
    expect(refreshed.roadmap?.roadmap_milestone_check.roadmap_revision).toBe(refreshed.roadmap?.roadmap_revision);
    expect(refreshed.roadmap?.roadmap_milestone_check.roadmap_content_hash).toBe(refreshed.roadmap?.roadmap_content_hash);
    expect(refreshed.roadmap?.roadmap_milestone_check.event_id).toMatch(/^evt_/);
    await transition(cwd, { operation: "approve_roadmap", approver: "user" });
  });

  test("draft discovery updates revision and resets the roadmap-milestone check", async () => {
    await initRoadmap(cwd, { roadmapId: "discovery-update-roadmap", title: "Discovery Update Roadmap" });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: { findings: ["Inspected local sources."] },
    });
    await updateRoadmap(cwd, roadmapInput());
    await recordPassedRoadmapMilestoneCheck();
    const checked = await loadState(cwd);
    if (!checked.roadmap) throw new Error("Expected roadmap state");

    await transition(cwd, {
      operation: "record_discovery",
      discovery: { findings: ["Inspected local sources.", "Found an extra roadmap input."] },
    });

    const updated = await loadState(cwd);
    if (!updated.roadmap) throw new Error("Expected updated roadmap state");
    expect(updated.roadmap.roadmap_revision).toBe(checked.roadmap.roadmap_revision + 1);
    expect(updated.roadmap.roadmap_content_hash).not.toBe(checked.roadmap.roadmap_content_hash);
    expect(updated.roadmap.roadmap_milestone_check).toMatchObject({
      status: "pending",
      roadmap_revision: updated.roadmap.roadmap_revision,
      roadmap_content_hash: updated.roadmap.roadmap_content_hash,
      event_id: "",
    });
    expect(await fs.readFile(roadmapDocPath(cwd, updated.roadmap.roadmap_id), "utf8")).toBe(
      renderRoadmapMarkdown(updated.roadmap),
    );
  });

  test("post-approval workflow transitions do not change roadmap definition revision or stale the gate", async () => {
    await approvedRoadmap();
    const approved = await loadState(cwd);
    if (!approved.roadmap) throw new Error("Expected approved roadmap");
    const revision = approved.roadmap.roadmap_revision;
    const contentHash = approved.roadmap.roadmap_content_hash;
    const checkedHash = approved.roadmap.roadmap_milestone_check.roadmap_content_hash;

    await transition(cwd, { operation: "start_milestone_planning" });
    await transition(cwd, {
      operation: "create_milestone_plan",
      milestone: { ...milestoneInput(), title: "Implementation plan title" },
    });
    await recordPassedWaveFlowCheck();
    await transition(cwd, { operation: "approve_milestone", approver: "user" });
    await transition(cwd, { operation: "start_implementation" });
    await transition(cwd, { operation: "start_reviewing" });

    const state = await loadState(cwd);
    expect(state.roadmap?.roadmap_revision).toBe(revision);
    expect(state.roadmap?.roadmap_content_hash).toBe(contentHash);
    expect(state.roadmap?.roadmap_milestone_check.roadmap_content_hash).toBe(checkedHash);
    expect((summarizeState(state, "roadmap").roadmap as Record<string, unknown>).roadmap_milestone_check_status).toBe("passed");
    expect(await renderReport(cwd)).toContain("Roadmap milestone check: passed");
    expect((await validateRoadmapState(cwd)).errors.map((error) => error.code)).not.toContain("roadmap.milestone_check.stale");
  });

  test("repairs manually edited implementing roadmap state with a fresh checker result", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    const before = await loadState(cwd);
    if (!before.roadmap || !before.active?.milestone_id) throw new Error("Expected active implementation state");
    const runtimePath = milestoneRuntimePath(cwd, before.roadmap.roadmap_id, before.active.milestone_id);
    const runtimeBefore = await fs.readFile(runtimePath, "utf8");
    const previousRevision = before.roadmap.roadmap_revision;
    const previousHash = before.roadmap.roadmap_content_hash;

    await manuallyWriteRoadmapState((roadmap) => {
      roadmap.context = ["Manual recovery removed incorrect discovery context."];
    });

    let validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.content_hash.stale");
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.doc.stale");

    const result = await repairRoadmap(cwd, {
      reason: "Manual state recovery changed roadmap context during implementation.",
      actor: "repair-test",
      roadmapMilestoneCheck: {
        status: "passed",
        checkedBy: "roadmap-milestone-checker",
        summary: "Fresh roadmap-milestone checker pass after manual recovery.",
        findings: [],
      },
    });

    expect(result).toMatchObject({
      previous_revision: previousRevision,
      current_revision: previousRevision + 1,
      previous_content_hash: previousHash,
      content_hash_changed: true,
      roadmap_doc_rewritten: true,
      gate_action: "recorded_passed",
    });
    expect(result.current_content_hash).not.toBe(previousHash);
    expect(result.repair_event_id).toMatch(/^evt_/);
    expect(result.quality_gate_event_id).toMatch(/^evt_/);

    const after = await loadState(cwd);
    expect(after.roadmap?.phase).toBe("implementing");
    expect(after.active).toEqual(before.active);
    expect(after.milestone?.progress).toEqual(before.milestone?.progress);
    expect(await fs.readFile(runtimePath, "utf8")).toBe(runtimeBefore);
    expect(after.roadmap?.roadmap_milestone_check).toMatchObject({
      status: "passed",
      roadmap_revision: previousRevision + 1,
      roadmap_content_hash: result.current_content_hash,
      event_id: result.quality_gate_event_id,
    });
    validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(true);

    const gates = await listQualityGates(cwd, { gate: "roadmap_milestone_check", limit: 1 });
    expect(gates.history[0]).toMatchObject({
      id: result.quality_gate_event_id,
      type: "quality_gate.recorded",
      operation: "repair_roadmap",
      details: {
        gate_status: "passed",
        roadmap_revision: previousRevision + 1,
        roadmap_content_hash: result.current_content_hash,
        repair_event_id: result.repair_event_id,
      },
    });
  });

  test("repair resets the roadmap-milestone check when manual state edits have no fresh checker result", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    const before = await loadState(cwd);
    if (!before.roadmap) throw new Error("Expected roadmap state");

    await manuallyWriteRoadmapState((roadmap) => {
      roadmap.evidence = ["Manual recovery removed incorrect evidence."];
    });

    const result = await repairRoadmap(cwd, {
      reason: "Manual state recovery changed roadmap evidence without a checker rerun.",
    });

    expect(result).toMatchObject({
      previous_revision: before.roadmap.roadmap_revision,
      current_revision: before.roadmap.roadmap_revision + 1,
      content_hash_changed: true,
      roadmap_doc_rewritten: true,
      gate_action: "reset_pending",
    });
    const repaired = await loadState(cwd);
    expect(repaired.roadmap?.roadmap_milestone_check).toMatchObject({
      status: "pending",
      roadmap_revision: result.current_revision,
      roadmap_content_hash: result.current_content_hash,
      event_id: "",
    });
    const validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.milestone_check.pending");
  });

  test("repair rewrites stale roadmap markdown without bumping revision or invalidating the gate", async () => {
    await approvedRoadmap();
    const before = await loadState(cwd);
    if (!before.roadmap) throw new Error("Expected roadmap state");
    await fs.writeFile(roadmapDocPath(cwd, before.roadmap.roadmap_id), "# Hand edited\n", "utf8");

    const result = await repairRoadmap(cwd, {
      reason: "Generated roadmap markdown was hand edited.",
    });

    expect(result).toMatchObject({
      previous_revision: before.roadmap.roadmap_revision,
      current_revision: before.roadmap.roadmap_revision,
      previous_content_hash: before.roadmap.roadmap_content_hash,
      current_content_hash: before.roadmap.roadmap_content_hash,
      content_hash_changed: false,
      roadmap_doc_rewritten: true,
      gate_action: "unchanged",
    });
    const after = await loadState(cwd);
    expect(after.roadmap?.roadmap_milestone_check).toEqual(before.roadmap.roadmap_milestone_check);
    expect(await fs.readFile(roadmapDocPath(cwd, before.roadmap.roadmap_id), "utf8")).toBe(
      renderRoadmapMarkdown(after.roadmap!),
    );
    expect((await validateRoadmapState(cwd)).valid).toBe(true);
  });

  test("no-op repair records an audit event and leaves valid state unchanged", async () => {
    await approvedRoadmap();
    const before = await loadState(cwd);
    if (!before.roadmap) throw new Error("Expected roadmap state");

    const result = await repairRoadmap(cwd, {
      reason: "Operator verified roadmap state after a manual recovery attempt.",
      actor: "repair-test",
    });

    expect(result).toMatchObject({
      previous_revision: before.roadmap.roadmap_revision,
      current_revision: before.roadmap.roadmap_revision,
      previous_content_hash: before.roadmap.roadmap_content_hash,
      current_content_hash: before.roadmap.roadmap_content_hash,
      content_hash_changed: false,
      roadmap_doc_rewritten: false,
      gate_action: "unchanged",
    });
    const after = await loadState(cwd);
    expect(after.roadmap).toEqual(before.roadmap);
    expect((await validateRoadmapState(cwd)).valid).toBe(true);
    const events = await readRoadmapEvents(cwd, { type: ["roadmap.repaired"] });
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({
      id: result.repair_event_id,
      actor: "repair-test",
      operation: "repair_roadmap",
      details: {
        reason: "Operator verified roadmap state after a manual recovery attempt.",
        gate_action: "unchanged",
      },
    });
  });

  test("reopens an approved roadmap and requires regenerated approval", async () => {
    await approvedRoadmap();
    const approved = await loadState(cwd);
    if (!approved.roadmap) throw new Error("Expected roadmap state");
    const approvedRevision = approved.roadmap.roadmap_revision;
    const approvedHash = approved.roadmap.roadmap_content_hash;
    const approvedCheckEventId = approved.roadmap.roadmap_milestone_check.event_id;

    await transition(cwd, {
      operation: "reopen_roadmap",
      reason: "Add a missing migration milestone before planning starts.",
    });

    const reopened = await loadState(cwd);
    if (!reopened.roadmap) throw new Error("Expected reopened roadmap state");
    expect(reopened.roadmap.phase).toBe("roadmap_draft");
    expect(reopened.roadmap.roadmap_finalized).toBe(false);
    expect(reopened.roadmap.approvals).toHaveLength(1);
    expect(reopened.roadmap.roadmap_revision).toBe(approvedRevision + 1);
    expect(reopened.roadmap.roadmap_content_hash).not.toBe(approvedHash);
    expect(reopened.roadmap.roadmap_milestone_check).toMatchObject({
      status: "pending",
      roadmap_revision: reopened.roadmap.roadmap_revision,
      roadmap_content_hash: reopened.roadmap.roadmap_content_hash,
      event_id: "",
    });
    expect(reopened.roadmap.roadmap_milestone_check.event_id).not.toBe(approvedCheckEventId);
    expect(await fs.readFile(roadmapDocPath(cwd, reopened.roadmap.roadmap_id), "utf8")).toBe(
      renderRoadmapMarkdown(reopened.roadmap),
    );

    const decisions = await fs.readFile(decisionsPath(cwd, reopened.roadmap.roadmap_id), "utf8");
    expect(decisions).toContain("## Roadmap Reopened");
    expect(decisions).toContain("Add a missing migration milestone before planning starts.");

    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.finalized.missing");
    await expect(
      transition(cwd, { operation: "approve_roadmap", approver: "user" }),
    ).rejects.toThrow("finalized roadmap");

    await updateRoadmap(cwd, roadmapInput({
      goal: "Refactor roadmap-engineer state safely after reopening.",
    }));
    await recordPassedRoadmapMilestoneCheck("Reopened roadmap milestone check passed.");
    await transition(cwd, {
      operation: "approve_roadmap",
      approver: "user",
      summary: "Reapproved after roadmap reopen",
    });

    const reapproved = await loadState(cwd);
    expect(reapproved.roadmap?.phase).toBe("roadmap_approved");
    expect(reapproved.roadmap?.approvals).toHaveLength(2);
    expect((await validateRoadmapState(cwd)).valid).toBe(true);
  });

  test("rejects roadmap reopen without a reason or outside roadmap approval", async () => {
    await initRoadmap(cwd, { roadmapId: "draft-roadmap", title: "Draft Roadmap" });

    await expect(
      transition(cwd, { operation: "reopen_roadmap", reason: "Need to change scope." }),
    ).rejects.toThrow("reopen_roadmap requires phase roadmap_approved");

    await transition(cwd, { operation: "record_discovery" });
    await updateRoadmap(cwd, roadmapInput());
    await recordPassedRoadmapMilestoneCheck();
    await transition(cwd, { operation: "approve_roadmap", approver: "user" });

    await expect(
      transition(cwd, { operation: "reopen_roadmap" }),
    ).rejects.toThrow("reopen_roadmap requires a reason");
  });

  test("rejects incomplete roadmap milestone outlines", async () => {
    await initRoadmap(cwd, { roadmapId: "bad-roadmap", title: "Bad Roadmap" });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: { findings: ["Inspected local sources."] },
    });

    await updateRoadmap(cwd, roadmapInput({ milestones: [] }));
    let validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.milestones.missing");
    await expect(transition(cwd, { operation: "approve_roadmap", approver: "user" })).rejects.toThrow(
      "at least one concrete milestone",
    );

    await updateRoadmap(cwd, roadmapInput({
      milestones: [{ ...roadmapInput().milestones[0]!, goal: "" }],
    }));
    validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.milestone.goal.missing");

    await updateRoadmap(cwd, roadmapInput({
      milestones: [
        roadmapInput().milestones[0]!,
        { ...roadmapInput().milestones[0]!, title: "Duplicate core" },
      ],
    }));
    validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("milestone.duplicate");

    await updateRoadmap(cwd, roadmapInput({
      milestones: [{ ...roadmapInput().milestones[0]!, dependencies: ["missing"] }],
    }));
    validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.milestone.dependency.unknown");

    await updateRoadmap(cwd, roadmapInput({ goal: "TODO" }));
    validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.goal.missing");
  });

  test("rejects approval when generated roadmap markdown is stale", async () => {
    await initRoadmap(cwd, { roadmapId: "stale-roadmap", title: "Stale Roadmap" });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: { findings: ["Inspected local sources."] },
    });
    const state = await updateRoadmap(cwd, roadmapInput());
    await fs.writeFile(roadmapDocPath(cwd, state.roadmap_id), "# Hand edited\n", "utf8");

    const validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.doc.stale");
    await expect(transition(cwd, { operation: "approve_roadmap", approver: "user" })).rejects.toThrow(
      "generated roadmap.md",
    );
  });

  test("rejects incomplete task, wave, and progress detail", async () => {
    await approvedRoadmap();
    await transition(cwd, { operation: "start_milestone_planning" });
    const input = milestoneInput();
    input.tasks[0] = {
      ...input.tasks[0]!,
      objective: "",
      implementation_notes: [],
      done_criteria: [],
      verification_commands: [],
    };
    input.waves[0] = {
      ...input.waves[0]!,
      goal: "",
      exit_criteria: [],
      review_checkpoint: "",
    };
    await transition(cwd, { operation: "create_milestone_plan", milestone: input });

    let validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("task.objective.missing");
    expect(validation.errors.map((error) => error.code)).toContain("task.implementation.missing");
    expect(validation.errors.map((error) => error.code)).toContain("task.done.missing");
    expect(validation.errors.map((error) => error.code)).toContain("task.verify.missing");
    expect(validation.errors.map((error) => error.code)).toContain("wave.goal.missing");
    expect(validation.errors.map((error) => error.code)).toContain("wave.exit.missing");
    expect(validation.errors.map((error) => error.code)).toContain("wave.review.missing");

    await transition(cwd, {
      operation: "update_implementation_progress",
      progress: {
        activeWaveId: "missing-wave",
        step: "resolving_blockers",
        activeTaskIds: ["missing-task"],
      },
    });
    validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("progress.wave.unknown");
    expect(validation.errors.map((error) => error.code)).toContain("progress.task.unknown");
    expect(validation.errors.map((error) => error.code)).toContain("progress.blocked_reason.missing");
  });

  test("requires valid implementation worker roles and a passed wave-flow check before milestone approval", async () => {
    await approvedRoadmap();
    await transition(cwd, { operation: "start_milestone_planning" });
    const input = milestoneInput();
    input.tasks = [
      { ...input.tasks[0]!, worker: "worker-light" },
      { ...input.tasks[1]!, worker: "worker-heavy" },
      {
        ...input.tasks[0]!,
        id: "t03-normal",
        title: "Normal worker",
        worker: "worker",
        owned_files: ["src/core/validation.ts"],
      },
    ];
    input.waves = [
      testWave("w01", ["t01-state"]),
      testWave("w02", ["t02-report"]),
      testWave("w03", ["t03-normal"]),
    ];
    await transition(cwd, { operation: "create_milestone_plan", milestone: input });

    let validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("milestone.wave_flow_check.not_passed");
    await expect(transition(cwd, { operation: "approve_milestone" })).rejects.toThrow("passed wave-flow check");

    await transition(cwd, {
      operation: "record_wave_flow_check",
      waveFlowCheck: {
        status: "failed",
        checkedBy: "wave-flow-checker",
        summary: "Future-wave verification conflict.",
        findings: ["w02 verification depends on w03."],
      },
    });
    await expect(transition(cwd, { operation: "approve_milestone" })).rejects.toThrow("passed wave-flow check");

    await recordPassedWaveFlowCheck();
    validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(true);
    await transition(cwd, { operation: "approve_milestone", approver: "user" });
  });

  test("rejects invalid implementation worker roles", async () => {
    await approvedRoadmap();
    await transition(cwd, { operation: "start_milestone_planning" });
    const input = milestoneInput();
    input.tasks[0] = { ...input.tasks[0]!, worker: "worker-custom" as never };
    await transition(cwd, { operation: "create_milestone_plan", milestone: input });
    await recordPassedWaveFlowCheck();

    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("task.worker.invalid");
  });

  test("draft milestone updates reset wave-flow check state", async () => {
    await approvedRoadmap();
    await transition(cwd, { operation: "start_milestone_planning" });
    await transition(cwd, { operation: "create_milestone_plan", milestone: milestoneInput() });
    await recordPassedWaveFlowCheck();

    await transition(cwd, {
      operation: "update_milestone_plan",
      milestone: {
        ...milestoneInput(),
        title: "Updated core milestone",
      },
    });

    const state = await loadState(cwd);
    expect(state.milestone?.title).toBe("Updated core milestone");
    expect(state.milestone?.wave_flow_check.status).toBe("pending");
    await expect(transition(cwd, { operation: "approve_milestone" })).rejects.toThrow("passed wave-flow check");
  });

  test("writes milestone runtime and overlays implementation progress", async () => {
    await approvedRoadmap();
    await transition(cwd, { operation: "start_milestone_planning" });
    await transition(cwd, { operation: "create_milestone_plan", milestone: milestoneInput() });

    let state = await loadState(cwd);
    expect(state.milestone?.progress).toMatchObject({
      active_wave_id: "w01",
      step: "not_started",
      active_task_ids: [],
    });
    expect(summarizeState(state, "active_milestone")).toMatchObject({
      milestone: { wave_flow_check: { status: "pending" } },
    });
    if (!state.milestone) throw new Error("Expected milestone");
    let planMarkdown = await fs.readFile(milestonePlanPath(cwd, state.milestone.roadmap_id, state.milestone.milestone_id), "utf8");
    expect(planMarkdown).toContain("## Required Work");
    expect(planMarkdown).toContain("### t01-state - State engine");
    expect(planMarkdown).toContain("## Execution Waves");
    expect(planMarkdown).not.toContain("## Wave Flow Check");
    expect(planMarkdown).not.toContain("## Progress");
    expect(planMarkdown).not.toContain("Status: assigned");
    expect(planMarkdown).not.toContain("Status: pending");
    const runtimeMarkdown = await fs.readFile(
      milestoneRuntimePath(cwd, state.milestone.roadmap_id, state.milestone.milestone_id),
      "utf8",
    );
    expect(runtimeMarkdown).toContain("status: assigned");
    expect(runtimeMarkdown).toContain("step: not_started");
    const originalPlanMarkdown = planMarkdown;

    await transition(cwd, {
      operation: "update_implementation_progress",
      progress: {
        activeWaveId: "w01",
        step: "workers_running",
        activeTaskIds: ["t01-state"],
      },
    });
    state = await loadState(cwd);
    expect(state.milestone?.progress).toMatchObject({
      active_wave_id: "w01",
      step: "workers_running",
      active_task_ids: ["t01-state"],
    });
    if (!state.milestone) throw new Error("Expected milestone");
    planMarkdown = await fs.readFile(milestonePlanPath(cwd, state.milestone.roadmap_id, state.milestone.milestone_id), "utf8");
    expect(planMarkdown).toBe(originalPlanMarkdown);
    const updatedRuntimeMarkdown = await fs.readFile(
      milestoneRuntimePath(cwd, state.milestone.roadmap_id, state.milestone.milestone_id),
      "utf8",
    );
    expect(updatedRuntimeMarkdown).toContain("step: workers_running");
    expect(updatedRuntimeMarkdown).toContain("- t01-state");
  });

  test("task and wave status updates mutate runtime without rewriting milestone plan", async () => {
    await approvedMilestone();
    const state = await loadState(cwd);
    if (!state.milestone) throw new Error("Expected milestone");
    const planPath = milestonePlanPath(cwd, state.milestone.roadmap_id, state.milestone.milestone_id);
    const originalPlanMarkdown = await fs.readFile(planPath, "utf8");

    await transition(cwd, { operation: "update_task_status", taskId: "t01-state", taskStatus: "started" });
    await transition(cwd, { operation: "update_wave_status", waveId: "w01", waveStatus: "running" });

    const updated = await loadState(cwd);
    expect(updated.milestone?.tasks.find((task) => task.id === "t01-state")?.status).toBe("started");
    expect(updated.milestone?.waves.find((wave) => wave.id === "w01")?.status).toBe("running");
    expect(await fs.readFile(planPath, "utf8")).toBe(originalPlanMarkdown);
    const runtimeMarkdown = await fs.readFile(milestoneRuntimePath(cwd, "complex-refactor", "m01-core"), "utf8");
    expect(runtimeMarkdown).toContain("status: started");
    expect(runtimeMarkdown).toContain("status: running");
  });

  test("rejects illegal phase skips", async () => {
    await approvedRoadmap();

    await expect(transition(cwd, { operation: "start_implementation" })).rejects.toThrow(
      "start_implementation requires phase milestone_approved",
    );

    await transition(cwd, { operation: "start_milestone_planning" });
    await expect(transition(cwd, { operation: "approve_milestone" })).rejects.toThrow(
      "No active milestone",
    );
  });

  test("updates task and wave status and rejects multiple active waves", async () => {
    await approvedMilestone();

    await transition(cwd, { operation: "update_task_status", taskId: "t01-state", taskStatus: "started" });
    await transition(cwd, { operation: "update_wave_status", waveId: "w01", waveStatus: "running" });
    await transition(cwd, { operation: "update_wave_status", waveId: "w02", waveStatus: "running" });

    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("wave.active.multiple");
    expect(validation.errors.map((error) => error.code)).toContain("wave.order.blocked");
  });

  test("preserves concurrent store updates and recovers stale write locks", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await fs.writeFile(
      storeLockPath(cwd),
      JSON.stringify({ pid: 999999, created_at: new Date(Date.now() - 120_000).toISOString() }),
      "utf8",
    );

    await Promise.all([
      transition(cwd, { operation: "update_task_status", taskId: "t01-state", taskStatus: "started" }),
      transition(cwd, {
        operation: "update_implementation_progress",
        progress: {
          activeWaveId: "w01",
          step: "workers_running",
          activeTaskIds: ["t01-state"],
        },
      }),
      appendNote(cwd, {
        kind: "worker",
        taskId: "t01-state",
        workerId: "worker-light",
        title: "Concurrent note",
        body: "Recorded while another store mutation was in flight.",
        status: "resolved",
      }),
    ]);

    const state = await loadState(cwd);
    expect(state.milestone?.tasks.find((task) => task.id === "t01-state")?.status).toBe("started");
    expect(state.milestone?.progress).toMatchObject({
      active_wave_id: "w01",
      step: "workers_running",
      active_task_ids: ["t01-state"],
    });
    const notes = await fs.readFile(milestoneNotesPath(cwd, "complex-refactor", "m01-core"), "utf8");
    expect(notes).toContain("## Concurrent note");
  });

  test("rejects duplicate wave membership, unknown dependencies, and dependency cycles", async () => {
    await approvedRoadmap();
    await transition(cwd, { operation: "start_milestone_planning" });
    const input = milestoneInput();
    const firstTask = input.tasks[0];
    const secondTask = input.tasks[1];
    if (!firstTask || !secondTask) throw new Error("test fixture is missing tasks");
    input.tasks = [
      { ...firstTask, depends_on: ["t02-report", "missing-task"] },
      { ...secondTask, depends_on: ["t01-state"] },
    ];
    input.waves = [
      testWave("w01", ["t01-state", "t02-report"]),
      testWave("w02", ["t01-state"]),
    ];
    await transition(cwd, { operation: "create_milestone_plan", milestone: input });

    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("wave.task.duplicate");
    expect(validation.errors.map((error) => error.code)).toContain("task.dependency.unknown");
    expect(validation.errors.map((error) => error.code)).toContain("task.dependency.cycle");
  });

  test("rejects overlapping ownership in the same wave", async () => {
    await approvedRoadmap();
    await transition(cwd, { operation: "start_milestone_planning" });
    const input = milestoneInput();
    const reportTask = input.tasks[1];
    if (!reportTask) throw new Error("test fixture missing report task");
    input.tasks[1] = { ...reportTask, owned_files: ["src/core/store.ts"] };
    input.waves = [testWave("w01", ["t01-state", "t02-report"])];
    await transition(cwd, { operation: "create_milestone_plan", milestone: input });

    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("wave.ownership.overlap");
  });

  test("requires structured closeout evidence before completing a milestone", async () => {
    await closeoutPhase();

    await expect(transition(cwd, { operation: "complete_milestone" })).rejects.toThrow(
      "Closeout evidence must be closed",
    );

    await transition(cwd, {
      operation: "record_closeout",
      closeout: closedEvidence({
        acceptance_results: [
          { item: "State validates", status: "passed" },
          { item: "Gate opens only during implementation", status: "failed" },
        ],
      }),
    });
    await expect(transition(cwd, { operation: "complete_milestone" })).rejects.toThrow(
      "acceptance criterion is not passed or deferred",
    );

    await transition(cwd, {
      operation: "record_closeout",
      closeout: closedEvidence({
        acceptance_results: [
          { item: "State validates", status: "passed" },
          {
            item: "Gate opens only during implementation",
            status: "deferred",
            reason: "Follow-up accepted by user.",
            approver: "user",
          },
        ],
      }),
    });
    await transition(cwd, { operation: "complete_milestone" });

    const state = await loadState(cwd);
    expect(state.roadmap?.phase).toBe("complete");
    expect(state.active?.milestone_id).toBe("m01-core");
  });

  test("starts planning the next roadmap milestone after a completed milestone", async () => {
    await initRoadmap(cwd, { roadmapId: "complex-refactor", title: "Complex Refactor" });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: { findings: ["Inspected local roadmap-engineer sources."] },
    });
    await updateRoadmap(cwd, roadmapInput({
      milestones: [
        roadmapInput().milestones[0]!,
        additionalMilestone("m02-runtime", "Runtime prompts"),
      ],
    }));
    await recordPassedRoadmapMilestoneCheck();
    await transition(cwd, {
      operation: "approve_roadmap",
      approver: "user",
      summary: "Roadmap approved",
    });
    await transition(cwd, { operation: "start_milestone_planning" });
    await transition(cwd, { operation: "create_milestone_plan", milestone: milestoneInput() });
    await recordPassedWaveFlowCheck();
    await transition(cwd, {
      operation: "approve_milestone",
      approver: "user",
      summary: "Milestone approved",
    });
    await transition(cwd, { operation: "start_implementation" });
    await transition(cwd, { operation: "start_reviewing" });
    await transition(cwd, { operation: "start_closeout" });
    await transition(cwd, { operation: "record_closeout", closeout: closedEvidence() });
    await transition(cwd, { operation: "complete_milestone" });

    expect(await renderReport(cwd)).toContain("Start the next planned milestone with /milestone:plan");

    await transition(cwd, { operation: "start_milestone_planning" });
    let state = await loadState(cwd);
    expect(state.roadmap?.phase).toBe("milestone_planning");
    expect(state.active?.milestone_id).toBeUndefined();
    expect(state.roadmap?.active_milestone_id).toBeUndefined();
    expect(state.roadmap?.milestones.find((milestone) => milestone.id === "m01-core")?.status).toBe("complete");
    expect(state.roadmap?.milestones.find((milestone) => milestone.id === "m02-runtime")?.status).toBe("planned");

    await transition(cwd, {
      operation: "create_milestone_plan",
      milestone: {
        ...milestoneInput(),
        milestoneId: "m02-runtime",
        title: "Runtime prompts",
      },
    });
    state = await loadState(cwd);
    expect(state.roadmap?.phase).toBe("milestone_planning");
    expect(state.active?.milestone_id).toBe("m02-runtime");
    expect(state.roadmap?.active_milestone_id).toBe("m02-runtime");
  });

  test("rejects next milestone planning after complete when no roadmap milestones remain", async () => {
    await closeoutPhase();
    await transition(cwd, { operation: "record_closeout", closeout: closedEvidence() });
    await transition(cwd, { operation: "complete_milestone" });

    await expect(transition(cwd, { operation: "start_milestone_planning" })).rejects.toThrow(
      "start_milestone_planning requires a planned or blocked milestone",
    );
  });

  test("requires reviewed worker notes and review summary in closeout evidence", async () => {
    await closeoutPhase();
    await transition(cwd, {
      operation: "record_closeout",
      closeout: closedEvidence({ worker_notes_reviewed: false, review_summary: "" }),
    });

    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(true);
    await expect(transition(cwd, { operation: "complete_milestone" })).rejects.toThrow(
      "worker notes were reviewed",
    );
  });

  test("creates, implements, and closes an approved post-implementation change request", async () => {
    await closeoutPhase();
    await createChangeRequest(cwd, {
      changeRequestId: "c01-adjust",
      title: "Adjust behavior",
      request: "Change the implementation after review.",
      verificationCommands: ["bun test"],
      acceptanceCriteria: ["Requested delta is implemented"],
      tasks: [
        {
          ...milestoneInput().tasks[0]!,
          id: "t01-change",
          depends_on: [],
        },
      ],
      waves: [testWave("w01", ["t01-change"])],
    });

    expect((await validateImplementationGate(cwd)).valid).toBe(false);
    await recordPassedWaveFlowCheck("Change flow check passed.");
    await transition(cwd, {
      operation: "approve_change",
      approver: "user",
      summary: "Change plan approved",
    });
    expect((await validateImplementationGate(cwd)).valid).toBe(true);

    await transition(cwd, { operation: "start_implementation" });
    await transition(cwd, {
      operation: "record_closeout",
      closeout: {
        ...closedEvidence({
          acceptance_results: [{ item: "Requested delta is implemented", status: "passed" }],
          verification_results: [{ item: "bun test", status: "passed" }],
        }),
        change_request_id: "c01-adjust",
      },
    });
    await transition(cwd, { operation: "close_change" });

    const state = await loadState(cwd);
    expect(state.active?.change_request_id).toBeUndefined();
    expect(state.roadmap?.phase).toBe("closeout");
    const report = await renderReport(cwd);
    expect(report).toContain("Active change request: none");
  });

  test("requires wave-flow check before change approval and resets it on draft update", async () => {
    await closeoutPhase();
    await createChangeRequest(cwd, {
      changeRequestId: "c01-flow",
      title: "Flow checked change",
      request: "Adjust a completed workflow.",
      verificationCommands: ["bun test"],
      acceptanceCriteria: ["Change flow is checked"],
      tasks: [{ ...milestoneInput().tasks[0]!, id: "t01-flow", depends_on: [] }],
      waves: [testWave("w01", ["t01-flow"])],
    });

    await expect(transition(cwd, { operation: "approve_change" })).rejects.toThrow("passed wave-flow check");
    let validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("change.wave_flow_check.not_passed");

    await recordPassedWaveFlowCheck("Initial change flow passed.");
    await transition(cwd, {
      operation: "update_change_request_plan",
      changeRequest: {
        changeRequestId: "c01-flow",
        title: "Updated flow checked change",
        request: "Adjust a completed workflow with a revised plan.",
        verificationCommands: ["bun test"],
        acceptanceCriteria: ["Updated change flow is checked"],
        tasks: [{ ...milestoneInput().tasks[0]!, id: "t01-flow-updated", depends_on: [] }],
        waves: [testWave("w01", ["t01-flow-updated"])],
      },
    });

    let state = await loadState(cwd);
    expect(state.changeRequest?.title).toBe("Updated flow checked change");
    expect(state.changeRequest?.wave_flow_check.status).toBe("pending");
    await expect(transition(cwd, { operation: "approve_change" })).rejects.toThrow("passed wave-flow check");

    await recordPassedWaveFlowCheck("Updated change flow passed.");
    validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(true);
    await transition(cwd, { operation: "approve_change", approver: "user" });
    state = await loadState(cwd);
    expect(state.changeRequest?.status).toBe("approved");
  });

  test("change request runtime overlays mutable execution state", async () => {
    await closeoutPhase();
    await createChangeRequest(cwd, {
      changeRequestId: "c01-runtime",
      title: "Runtime-backed change",
      request: "Adjust a completed workflow.",
      verificationCommands: ["bun test"],
      acceptanceCriteria: ["Runtime state is overlaid"],
      tasks: [{ ...milestoneInput().tasks[0]!, id: "t01-runtime", depends_on: [] }],
      waves: [testWave("w01", ["t01-runtime"])],
    });

    let state = await loadState(cwd);
    expect(state.changeRequest?.tasks.find((task) => task.id === "t01-runtime")?.status).toBe("assigned");
    if (!state.changeRequest) throw new Error("Expected change request");
    const changePath = changeRequestPath(cwd, "complex-refactor", "m01-core", "c01-runtime");
    const originalChangeMarkdown = await fs.readFile(changePath, "utf8");
    expect(originalChangeMarkdown).not.toContain("Status: assigned");
    expect(originalChangeMarkdown).not.toContain("## Progress");
    const runtimePath = changeRequestRuntimePath(cwd, "complex-refactor", "m01-core", "c01-runtime");
    expect(await fs.readFile(runtimePath, "utf8")).toContain("status: assigned");

    await transition(cwd, { operation: "update_task_status", taskId: "t01-runtime", taskStatus: "started" });
    await transition(cwd, {
      operation: "update_implementation_progress",
      progress: {
        activeWaveId: "w01",
        step: "workers_running",
        activeTaskIds: ["t01-runtime"],
      },
    });

    state = await loadState(cwd);
    expect(state.changeRequest?.tasks.find((task) => task.id === "t01-runtime")?.status).toBe("started");
    expect(state.changeRequest?.progress).toMatchObject({
      active_wave_id: "w01",
      step: "workers_running",
      active_task_ids: ["t01-runtime"],
    });
    expect(await fs.readFile(changePath, "utf8")).toBe(originalChangeMarkdown);
    const runtimeMarkdown = await fs.readFile(runtimePath, "utf8");
    expect(runtimeMarkdown).toContain("status: started");
    expect(runtimeMarkdown).toContain("step: workers_running");
  });

  test("allows change requests from reviewing, closeout, and complete phases", async () => {
    for (const phase of ["reviewing", "closeout", "complete"] as const) {
      await resetRoadmapStateForTest(cwd);
      await closeoutPhase();
      if (phase === "reviewing") {
        await resetRoadmapStateForTest(cwd);
        await approvedMilestone();
        await transition(cwd, { operation: "start_implementation" });
        await transition(cwd, { operation: "start_reviewing" });
      }
      if (phase === "complete") {
        await transition(cwd, { operation: "record_closeout", closeout: closedEvidence() });
        await transition(cwd, { operation: "complete_milestone" });
      }

      const change = await createChangeRequest(cwd, {
        changeRequestId: `c-${phase}`,
        title: `Change from ${phase}`,
        request: "Adjust completed work.",
        verificationCommands: ["bun test"],
        acceptanceCriteria: ["Change works"],
        tasks: [{ ...milestoneInput().tasks[0]!, id: `t-${phase}`, depends_on: [] }],
        waves: [testWave("w01", [`t-${phase}`])],
      });
      expect(change.status).toBe("draft");
    }
  });

  test("reset helper removes roadmap state", async () => {
    await initRoadmap(cwd, { roadmapId: "reset-roadmap", title: "Reset Roadmap" });
    await resetRoadmapStateForTest(cwd);
    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(true);
  });
});
