import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { readRoadmapEvents } from "@oh-my-roadmap/core/events";
import { shouldBlockToolCall } from "@oh-my-roadmap/core/gate";
import { applyNextAction, nextActionPlan, renderReport } from "@oh-my-roadmap/core/report/index";
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
} from "@oh-my-roadmap/core/store/index";
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
} from "@oh-my-roadmap/core/paths";
import { validateImplementationGate, validateRoadmapState } from "@oh-my-roadmap/core/validation";
import { summarizeState } from "@oh-my-roadmap/core/state-summary";
import { readYamlFile, writeYamlFile } from "@oh-my-roadmap/core/files";
import {
  prepareWaveDispatch,
  prepareWaveReview,
  recordWorkerAbandoned,
  recordWorkerDispatch,
  recordWorkerTransportFailed,
  recordWaveResult,
  recordWaveReview,
} from "@oh-my-roadmap/core/wave-orchestration/index";
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

describe("roadmap report and next actions", () => {
  test("requires a passed roadmap-milestone check before roadmap approval", async () => {
    await initRoadmap(cwd, { roadmapId: "checker-roadmap", title: "Checker Roadmap" });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: { findings: ["Inspected local sources."] },
    });
    await updateRoadmap(cwd, roadmapInput());

    let validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.milestone_check.pending");
    await expect(
      transition(cwd, { operation: "approve_roadmap", approver: "user" }),
    ).rejects.toThrow("passed roadmap-milestone check");

    await transition(cwd, {
      operation: "record_roadmap_milestone_check",
      roadmapMilestoneCheck: {
        status: "failed",
        checkedBy: "roadmap-milestone-checker",
        summary: "Milestones conflict.",
        findings: ["m01-core relies on later migration work."],
      },
    });
    await expect(
      transition(cwd, { operation: "approve_roadmap", approver: "user" }),
    ).rejects.toThrow("passed roadmap-milestone check");

    await recordPassedRoadmapMilestoneCheck();
    validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(true);
    await transition(cwd, { operation: "approve_roadmap", approver: "user" });
  });

  test("builds structured next actions for roadmap quality gate states", async () => {
    await initRoadmap(cwd, { roadmapId: "next-action-gates", title: "Next Action Gates" });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: { findings: ["Inspected local sources."] },
    });
    await updateRoadmap(cwd, roadmapInput());

    let action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Run roadmap milestone checker",
      status: "agent_required",
      safe_to_apply: false,
      scope: { roadmap_id: "next-action-gates" },
    });
    expect(action.id).toContain("milestone-check:pending");

    await transition(cwd, {
      operation: "record_roadmap_milestone_check",
      roadmapMilestoneCheck: {
        status: "failed",
        checkedBy: "roadmap-milestone-checker",
        summary: "Milestones conflict.",
        findings: ["m01-core needs a clearer exit criterion."],
      },
    });
    action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Revise roadmap after failed checker",
      status: "needs_input",
      missing_inputs: ["revised roadmap"],
    });
    expect(action.description).toContain("m01-core needs a clearer exit criterion");

    await recordPassedRoadmapMilestoneCheck();
    await updateRoadmap(cwd, roadmapInput({
      successCriteria: ["Roadmap approval requires concrete milestones.", "Checker must be current."],
    }));
    action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Rerun roadmap milestone checker",
      status: "stale",
      safe_to_apply: false,
    });
    expect(action.description).toContain("checked revision");
    await expect(applyNextAction(cwd, action.id)).rejects.toThrow("action status is stale");
  });

  test("preserves failed roadmap-milestone check findings in quality gate history", async () => {
    await initRoadmap(cwd, { roadmapId: "failed-history-roadmap", title: "Failed History Roadmap" });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: { findings: ["Inspected local sources."] },
    });
    await updateRoadmap(cwd, roadmapInput());
    await transition(cwd, {
      operation: "record_roadmap_milestone_check",
      roadmapMilestoneCheck: {
        status: "failed",
        checkedBy: "roadmap-milestone-checker",
        summary: "Milestone sequence is incomplete.",
        findings: ["m01-core lacks rollout evidence."],
      },
    });
    await recordPassedRoadmapMilestoneCheck("Roadmap milestone check passed after revision.");

    const gates = await listQualityGates(cwd, { gate: "roadmap_milestone_check" });
    expect(gates.current).toMatchObject({ status: "passed" });
    expect(gates.history.map((event) => event.details?.gate_status)).toEqual(["failed", "passed"]);
    expect(gates.history[0]?.details?.findings).toEqual(["m01-core lacks rollout evidence."]);
  });

  test("stale roadmap-milestone checks surface outside roadmap draft", async () => {
    await approvedRoadmap();
    const state = await loadState(cwd);
    if (!state.roadmap) throw new Error("Expected approved roadmap");
    state.roadmap.roadmap_milestone_check.roadmap_content_hash = "sha256:stale";
    await writeRoadmapState(cwd, state.roadmap);

    const validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).toContain("roadmap.milestone_check.stale");
    expect((summarizeState(await loadState(cwd), "roadmap").roadmap as Record<string, unknown>).roadmap_milestone_check_status).toBe("stale");
    expect(await renderReport(cwd)).toContain("Roadmap milestone check: stale");
    const action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Rerun roadmap milestone checker",
      status: "stale",
      safe_to_apply: false,
    });
    expect(action.description).toContain("checked revision");
    await expect(applyNextAction(cwd, action.id)).rejects.toThrow("action status is stale");
  });

  test("opens implementation gate only after milestone approval and implementation phase", async () => {
    await approvedMilestone();
    expect((await validateImplementationGate(cwd)).valid).toBe(false);

    await transition(cwd, { operation: "start_implementation" });
    const gate = await validateImplementationGate(cwd);
    expect(gate.valid).toBe(true);
  });

  test("builds structured next actions for wave-flow gate and blockers", async () => {
    await approvedRoadmap();
    await transition(cwd, { operation: "start_milestone_planning" });
    await transition(cwd, { operation: "create_milestone_plan", milestone: milestoneInput() });

    let action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Run wave-flow checker",
      status: "agent_required",
      safe_to_apply: false,
      scope: { roadmap_id: "complex-refactor", milestone_id: "m01-core" },
    });

    await transition(cwd, {
      operation: "record_wave_flow_check",
      waveFlowCheck: {
        status: "failed",
        checkedBy: "wave-flow-checker",
        summary: "Wave order is wrong.",
        findings: ["t02-report cannot run before t01-state."],
      },
    });
    action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Revise plan after failed wave-flow check",
      status: "needs_input",
      missing_inputs: ["revised milestone plan"],
    });
    expect(action.description).toContain("t02-report cannot run before t01-state");

    await openBlocker(cwd, {
      title: "Worker unavailable",
      description: "The assigned worker needs a replacement.",
      waveId: "w01",
      severity: "blocking",
    });
    action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Resolve blocking blockers",
      status: "blocked",
      safe_to_apply: false,
      scope: { roadmap_id: "complex-refactor", milestone_id: "m01-core" },
    });
    expect(action.blockers[0]).toContain("Worker unavailable");
    await expect(applyNextAction(cwd, action.id)).rejects.toThrow("action status is blocked");
  });

  test("applies only current safe next actions", async () => {
    await approvedRoadmap();

    let action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Start milestone planning",
      status: "ready",
      safe_to_apply: true,
      tool: { name: "omr_transition", input: { operation: "start_milestone_planning" } },
    });
    await expect(applyNextAction(cwd, "wrong-action")).rejects.toThrow("current next action is");
    await applyNextAction(cwd, action.id);
    expect((await loadState(cwd)).roadmap?.phase).toBe("milestone_planning");

    await transition(cwd, { operation: "create_milestone_plan", milestone: milestoneInput() });
    await recordPassedWaveFlowCheck();
    action = await nextActionPlan(cwd);
    expect(action.status).toBe("approval_required");
    await expect(applyNextAction(cwd, action.id)).rejects.toThrow("action status is approval_required");

    await transition(cwd, { operation: "approve_milestone", approver: "user" });
    action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Start implementation",
      status: "ready",
      safe_to_apply: true,
      tool: { input: { operation: "start_implementation" } },
    });
    await applyNextAction(cwd, action.id);
    expect((await loadState(cwd)).roadmap?.phase).toBe("implementing");
  });

  test("applies safe progress advancement when the next wave is unambiguous", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await transition(cwd, { operation: "update_wave_status", waveId: "w01", waveStatus: "complete" });
    await transition(cwd, {
      operation: "update_implementation_progress",
      progress: { activeWaveId: "w01", step: "ready_for_next_wave", activeTaskIds: [] },
    });

    let action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Advance to next wave",
      status: "ready",
      safe_to_apply: true,
      scope: { wave_id: "w02" },
      tool: {
        input: {
          operation: "update_implementation_progress",
          progress: { activeWaveId: "w02", step: "not_started", activeTaskIds: [] },
        },
      },
    });
    await applyNextAction(cwd, action.id);
    expect((await loadState(cwd)).milestone?.progress).toMatchObject({
      active_wave_id: "w02",
      step: "not_started",
      active_task_ids: [],
    });

    await transition(cwd, { operation: "update_wave_status", waveId: "w02", waveStatus: "complete" });
    await transition(cwd, {
      operation: "update_implementation_progress",
      progress: { activeWaveId: "w02", step: "ready_for_next_wave", activeTaskIds: [] },
    });
    action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Mark closeout ready",
      status: "ready",
      safe_to_apply: true,
    });
    await applyNextAction(cwd, action.id);
    expect((await loadState(cwd)).milestone?.progress).toMatchObject({
      step: "closeout_ready",
      active_task_ids: [],
    });
  });

  test("advances to the immediate next pending wave in a three-wave plan", async () => {
    await approvedRoadmap();
    await transition(cwd, { operation: "start_milestone_planning" });
    const input = milestoneInput();
    input.tasks = [
      ...input.tasks,
      {
        id: "t03-docs",
        title: "Docs task",
        objective: "Document the workflow.",
        implementation_notes: ["Update the relevant roadmap docs."],
        done_criteria: ["Docs explain the workflow."],
        verification_commands: ["bun test"],
        worker: "worker",
        status: "assigned",
        depends_on: ["t02-report"],
        owned_files: ["README.md"],
        owned_modules: [],
        shared_interfaces: [],
      },
    ];
    input.waves = [
      testWave("w01", ["t01-state"]),
      testWave("w02", ["t02-report"]),
      testWave("w03", ["t03-docs"]),
    ];
    await transition(cwd, { operation: "create_milestone_plan", milestone: input });
    await recordPassedWaveFlowCheck();
    await transition(cwd, { operation: "approve_milestone", approver: "user" });
    await transition(cwd, { operation: "start_implementation" });
    await transition(cwd, { operation: "update_wave_status", waveId: "w01", waveStatus: "complete" });
    await transition(cwd, {
      operation: "update_implementation_progress",
      progress: { activeWaveId: "w01", step: "ready_for_next_wave", activeTaskIds: [] },
    });

    const action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Advance to next wave",
      status: "ready",
      safe_to_apply: true,
      scope: { wave_id: "w02" },
      tool: {
        input: {
          operation: "update_implementation_progress",
          progress: { activeWaveId: "w02", step: "not_started", activeTaskIds: [] },
        },
      },
    });
    await applyNextAction(cwd, action.id);
    expect((await loadState(cwd)).milestone?.progress).toMatchObject({
      active_wave_id: "w02",
      step: "not_started",
    });
  });

  test("bypass opens only gate errors and does not hide invalid state", async () => {
    await approvedRoadmap();
    await transition(cwd, { operation: "request_bypass", reason: "Emergency investigation", approver: "user" });
    expect((await validateImplementationGate(cwd)).valid).toBe(true);

    await transition(cwd, { operation: "start_milestone_planning" });
    const input = milestoneInput();
    input.waves = [testWave("w01", ["missing-task"])];
    await transition(cwd, { operation: "create_milestone_plan", milestone: input });

    const validation = await validateImplementationGate(cwd);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("wave.task.unknown");
  });

  test("renders report and hook gate blocks direct file writes", async () => {
    await initRoadmap(cwd, { roadmapId: "report-roadmap", title: "Report Roadmap" });

    const report = await renderReport(cwd);
    expect(report).toContain("Report Roadmap");

    const blocked = await shouldBlockToolCall(cwd, "write");
    expect(blocked.block).toBe(true);

    const allowed = await shouldBlockToolCall(cwd, "bash");
    expect(allowed.block).toBe(false);
  });

  test("closeout next action points at omr_prepare_closeout for item IDs", async () => {
    await closeoutPhase();

    // No evidence recorded yet — direct the agent through omr_prepare_closeout.
    let action = await nextActionPlan(cwd);
    expect(action.label).toBe("Record closeout evidence");
    expect(action.description).toContain("omr_prepare_closeout");
    expect(action.description).toContain("itemId");

    // Recorded-but-not-closed — the hint still routes through omr_prepare_closeout.
    await transition(cwd, {
      operation: "record_closeout",
      closeout: closedEvidence({ status: "recorded" }),
    });
    action = await nextActionPlan(cwd);
    expect(action.label).toBe("Record closeout evidence");
    expect(action.description).toContain("omr_prepare_closeout");
  });
});
