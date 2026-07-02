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

describe("roadmap wave orchestration state", () => {
  test("prepares only the active wave dispatch package and preserves worker roles", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });

    const result = await prepareWaveDispatch(cwd);

    expect(result).toMatchObject({
      roadmap_id: "complex-refactor",
      milestone_id: "m01-core",
      wave_id: "w01",
      progress_step: "dispatching",
      assignments: [
        {
          task_id: "t01-state",
          title: "State engine",
          worker: "worker-light",
          owned_files: ["src/core/store.ts"],
          dependencies: [],
        },
      ],
    });
    expect(result.assignments.map((assignment) => assignment.task_id)).not.toContain("t02-report");
    expect(result.assignments[0]?.prompt).toContain("You are worker-light");
    expect(result.assignments[0]?.prompt).toContain("roadmap_engineer_record_wave_result");
    const state = await loadState(cwd);
    expect(state.milestone?.waves.find((wave) => wave.id === "w01")?.status).toBe("running");
    expect(state.milestone?.progress).toMatchObject({
      active_wave_id: "w01",
      step: "dispatching",
      active_task_ids: ["t01-state"],
    });
  });

  test("records worker dispatch leases and refuses active redispatch", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);

    const dispatch = await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store",
      jobId: "job-store",
    });

    expect(dispatch).toMatchObject({
      task_id: "t01-state",
      wave_id: "w01",
      progress_step: "workers_running",
      run: {
        task_id: "t01-state",
        wave_id: "w01",
        worker: "worker-light",
        agent_id: "agent-store",
        job_id: "job-store",
        owned_files: ["src/core/store.ts"],
        status: "running",
      },
    });
    const state = await loadState(cwd);
    expect(state.milestone?.tasks.find((task) => task.id === "t01-state")?.status).toBe("started");
    expect(state.milestone?.progress.worker_runs).toHaveLength(1);

    const redispatch = await prepareWaveDispatch(cwd);
    expect(redispatch.assignments).toEqual([]);
    expect(redispatch.active_runs).toMatchObject([
      { task_id: "t01-state", agent_id: "agent-store", job_id: "job-store", status: "running" },
    ]);
    expect(redispatch.instructions).toContain("Do not redispatch");
    expect(redispatch.instructions).toContain("First check the current session's background jobs and IRC peers");
    expect(redispatch.instructions).toContain("record it abandoned immediately");
    expect(redispatch.instructions).toContain("do not poll, probe, or wait");
    expect(redispatch.instructions).toContain("prefer waking the existing worker");
    expect(redispatch.instructions).toContain("Do not record a transport failure as a wave result");
  });

  test("refuses overlapping active worker ownership", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    const runtimePath = milestoneRuntimePath(cwd, "complex-refactor", "m01-core");
    const runtime = await readYamlFile<Record<string, any>>(runtimePath);
    runtime.progress.worker_runs = [
      {
        task_id: "other-task",
        wave_id: "w01",
        worker: "worker",
        agent_id: "agent-other",
        job_id: "job-other",
        owned_files: ["src/core/store.ts"],
        owned_modules: [],
        status: "running",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    await writeYamlFile(runtimePath, runtime);

    await expect(recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store",
      jobId: "job-store",
    })).rejects.toThrow("overlaps active worker run other-task owned files");
  });

  test("transport-failed runs block redispatch until abandoned", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store",
      jobId: "job-store",
    });

    const failed = await recordWorkerTransportFailed(cwd, {
      taskId: "t01-state",
      jobId: "job-store",
      lastError: "socket closed",
    });
    expect(failed.run).toMatchObject({
      status: "transport_failed",
      last_error: "socket closed",
    });
    const blocked = await prepareWaveDispatch(cwd);
    expect(blocked.assignments).toEqual([]);
    expect(blocked.active_runs).toMatchObject([{ task_id: "t01-state", status: "transport_failed" }]);

    const abandoned = await recordWorkerAbandoned(cwd, {
      taskId: "t01-state",
      jobId: "job-store",
      lastError: "probe timed out after 2 minutes",
    });
    expect(abandoned.run).toMatchObject({
      status: "abandoned",
      last_error: "probe timed out after 2 minutes",
    });
    const redispatch = await prepareWaveDispatch(cwd);
    expect(redispatch.assignments.map((assignment) => assignment.task_id)).toEqual(["t01-state"]);
    expect(redispatch.active_runs).toEqual([]);
  });

  test("records wave results as terminal worker runs", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store",
      jobId: "job-store",
    });

    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "State task completed.",
    });

    const state = await loadState(cwd);
    expect(state.milestone?.progress.worker_runs).toMatchObject([
      { task_id: "t01-state", agent_id: "agent-store", job_id: "job-store", status: "completed" },
    ]);
  });

  test("refuses dispatch when active-wave dependencies are incomplete", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await transition(cwd, {
      operation: "update_implementation_progress",
      progress: { activeWaveId: "w02", step: "not_started", activeTaskIds: [] },
    });

    await expect(prepareWaveDispatch(cwd)).rejects.toThrow("depends on incomplete task t01-state");
  });

  test("records blocked worker results as task and wave blockers", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);

    const result = await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "blocked",
      summary: "Worker cannot proceed.",
      blocker: {
        title: "Missing store decision",
        description: "The state transition needs a user decision.",
      },
    });

    expect(result).toMatchObject({
      task_id: "t01-state",
      status: "blocked",
      wave_id: "w01",
      wave_status: "blocked",
      progress_step: "resolving_blockers",
      blocker: {
        title: "Missing store decision",
        task_id: "t01-state",
        wave_id: "w01",
        created_by: "worker-light",
      },
    });
    const state = await loadState(cwd);
    expect(state.milestone?.tasks.find((task) => task.id === "t01-state")?.status).toBe("blocked");
    expect(state.milestone?.waves.find((wave) => wave.id === "w01")?.status).toBe("blocked");
    expect(state.milestone?.progress).toMatchObject({
      step: "resolving_blockers",
      blocked_reason: "Missing store decision",
    });
    const blockers = await listBlockers(cwd, { taskId: "t01-state", waveId: "w01", status: "open" });
    expect(blockers.blockers).toHaveLength(1);
  });

  test("prepares review and records a passing review transition", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "State task completed.",
    });

    const review = await prepareWaveReview(cwd);
    expect(review).toMatchObject({
      wave_id: "w01",
      reviewer: "reviewer",
      tasks: [{ task_id: "t01-state", worker: "worker-light" }],
    });
    expect(review.prompt).toContain("Review checkpoint");
    expect(review.prompt).toContain("roadmap_engineer_record_wave_review");

    const result = await recordWaveReview(cwd, {
      status: "passed",
      summary: "Wave implementation passed review.",
    });

    expect(result).toMatchObject({
      wave_id: "w01",
      wave_status: "complete",
      progress_step: "ready_for_next_wave",
      blockers: [],
    });
    const state = await loadState(cwd);
    expect(state.milestone?.waves.find((wave) => wave.id === "w01")?.status).toBe("complete");
    expect(state.milestone?.progress).toMatchObject({
      active_wave_id: "w01",
      step: "ready_for_next_wave",
      active_task_ids: [],
    });
  });

  test("records a failing review as blockers and resolving progress", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "State task completed.",
    });
    await prepareWaveReview(cwd);

    const result = await recordWaveReview(cwd, {
      status: "failed",
      summary: "Review found ownership drift.",
      findings: ["The worker modified an unowned report file."],
    });

    expect(result).toMatchObject({
      wave_id: "w01",
      wave_status: "blocked",
      progress_step: "resolving_blockers",
      blockers: [
        {
          title: "Wave w01 review failed",
          description: "The worker modified an unowned report file.",
          wave_id: "w01",
          created_by: "reviewer",
        },
      ],
    });
    const state = await loadState(cwd);
    expect(state.milestone?.waves.find((wave) => wave.id === "w01")?.status).toBe("blocked");
    expect(state.milestone?.progress).toMatchObject({
      step: "resolving_blockers",
      blocked_reason: "Review found ownership drift.",
    });
  });

  test("filters prefixed review findings and deduplicates blocking blockers", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "State task completed.",
    });
    await prepareWaveReview(cwd);

    const first = await recordWaveReview(cwd, {
      status: "failed",
      summary: "Review found one real blocker.",
      findings: [
        "PASS: Existing behavior still works.",
        "INFO: Reviewer inspected the runtime file.",
        "NON_BLOCKING: Add a follow-up note later.",
        "NON-BLOCKING: Documentation can improve later.",
        "BLOCKING: The worker modified an unowned report file.",
      ],
    });

    expect(first.blockers).toMatchObject([
      {
        title: "Wave w01 review failed",
        description: "The worker modified an unowned report file.",
        wave_id: "w01",
      },
    ]);
    const blockersAfterFirst = await listBlockers(cwd, { waveId: "w01", status: "open" });
    expect(blockersAfterFirst.blockers).toHaveLength(1);

    const second = await recordWaveReview(cwd, {
      status: "failed",
      summary: "Review found one real blocker again.",
      findings: ["BLOCKING: The worker modified an unowned report file."],
    });

    expect(second.blockers).toHaveLength(1);
    expect(second.blockers[0]?.id).toBe(first.blockers[0]?.id);
    const blockersAfterSecond = await listBlockers(cwd, { waveId: "w01", status: "open" });
    expect(blockersAfterSecond.blockers).toHaveLength(1);
  });

  test("keeps unclassified failed-review findings blocking", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "State task completed.",
    });
    await prepareWaveReview(cwd);

    const result = await recordWaveReview(cwd, {
      status: "failed",
      summary: "Review found unclassified issue.",
      findings: ["The worker changed an unowned file."],
    });

    expect(result.blockers).toMatchObject([
      {
        description: "The worker changed an unowned file.",
        severity: "blocking",
      },
    ]);
  });
});
