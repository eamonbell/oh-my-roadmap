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
import { searchContext } from "@oh-my-roadmap/core/context";
import { readYamlFile, writeYamlFile } from "@oh-my-roadmap/core/files";
import {
  prepareWaveDispatch,
  prepareWaveReview,
  prepareWorkerRedispatch,
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
    expect(result.assignments[0]?.prompt).toContain("omr_record_wave_result");
    const state = await loadState(cwd);
    expect(state.milestone?.waves.find((wave) => wave.id === "w01")?.status).toBe("running");
    expect(state.milestone?.progress).toMatchObject({
      active_wave_id: "w01",
      step: "dispatching",
      active_task_ids: ["t01-state"],
    });
  });

  test("assignment prompt reserves same-wave sibling files and permits cross-wave edits", async () => {
    await approvedRoadmap();
    await transition(cwd, { operation: "start_milestone_planning" });
    const input = milestoneInput();
    // Two concurrent tasks in the same wave: each is a reserved sibling of the other.
    input.tasks = [
      { ...input.tasks[0]! },
      { ...input.tasks[1]!, depends_on: [] },
    ];
    input.waves = [testWave("w01", ["t01-state", "t02-report"])];
    await transition(cwd, { operation: "create_milestone_plan", milestone: input });
    await recordPassedWaveFlowCheck();
    await transition(cwd, { operation: "approve_milestone", approver: "user" });
    await transition(cwd, { operation: "start_implementation" });

    const result = await prepareWaveDispatch(cwd);
    const stateAssignment = result.assignments.find((entry) => entry.task_id === "t01-state");
    expect(stateAssignment).toBeDefined();
    const prompt = stateAssignment!.prompt;
    // The concurrent sibling's owned file is reserved in this wave.
    expect(prompt).toContain("Reserved by concurrent sibling tasks in THIS wave");
    expect(prompt).toContain("src/core/report.ts");
    // Cross-wave editing is explicitly permitted.
    expect(prompt).toContain("OTHER waves");
    // The task's own file is not listed as reserved.
    expect(prompt).not.toContain("Reserved by concurrent sibling tasks in THIS wave (do not edit): src/core/store.ts");
    // The old exclusive "Work only on this task's scope" wording is gone.
    expect(prompt).not.toContain("Work only on this task's scope");
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

  test("transport_failures increments and survives reload", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store",
      jobId: "job-store",
    });

    const first = await recordWorkerTransportFailed(cwd, {
      taskId: "t01-state",
      jobId: "job-store",
      lastError: "socket closed",
    });
    expect(first.run.transport_failures).toBe(1);

    const second = await recordWorkerTransportFailed(cwd, {
      taskId: "t01-state",
      jobId: "job-store",
      lastError: "socket closed again",
    });
    expect(second.run.transport_failures).toBe(2);

    const state = await loadState(cwd);
    const reloaded = state.milestone?.progress.worker_runs.find((run) => run.task_id === "t01-state");
    expect(reloaded?.transport_failures).toBe(2);
    expect(reloaded?.status).toBe("transport_failed");
  });

  test("records replaces_agent_id lineage on dispatch", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);

    const dispatch = await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store-2",
      jobId: "job-store-2",
      replacesAgentId: "agent-store-1",
    });
    expect(dispatch.run.replaces_agent_id).toBe("agent-store-1");

    const state = await loadState(cwd);
    const run = state.milestone?.progress.worker_runs.find((r) => r.agent_id === "agent-store-2");
    expect(run?.replaces_agent_id).toBe("agent-store-1");
  });

  test("prepareWorkerRedispatch rejects while a run is still running", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store",
      jobId: "job-store",
    });

    await expect(prepareWorkerRedispatch(cwd, { taskId: "t01-state" })).rejects.toThrow(
      "still has a running worker",
    );
  });

  test("prepareWorkerRedispatch abandons the transport_failed run and returns a continuation prompt", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store",
      jobId: "job-store",
    });
    await recordWorkerTransportFailed(cwd, {
      taskId: "t01-state",
      jobId: "job-store",
      lastError: "socket closed",
    });

    const redispatch = await prepareWorkerRedispatch(cwd, { taskId: "t01-state" });

    expect(redispatch.prior_run).toMatchObject({
      agent_id: "agent-store",
      transport_failures: 1,
      last_error: "socket closed",
    });
    expect(redispatch.assignment.task_id).toBe("t01-state");
    expect(redispatch.assignment.prompt).toContain("CONTINUATION CONTEXT");
    expect(redispatch.assignment.prompt).toContain("history://agent-store");
    expect(redispatch.assignment.prompt).toContain("1 transport failure");
    expect(redispatch.instructions).toContain("replacesAgentId");

    const state = await loadState(cwd);
    const run = state.milestone?.progress.worker_runs.find((r) => r.agent_id === "agent-store");
    expect(run?.status).toBe("abandoned");
    expect(state.milestone?.progress.active_task_ids).not.toContain("t01-state");
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
    expect(review.prompt).toContain("omr_record_wave_review");

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
    // A later pending wave exists, so the hint advances to it without mutating progress.
    expect(result.next_actions).toHaveLength(1);
    expect(result.next_actions?.[0]).toMatchObject({
      label: "Advance to next wave",
      tool: {
        name: "omr_transition",
        input: {
          operation: "update_implementation_progress",
          progress: { activeWaveId: "w02", step: "not_started", activeTaskIds: [] },
        },
      },
    });
    const state = await loadState(cwd);
    expect(state.milestone?.waves.find((wave) => wave.id === "w01")?.status).toBe("complete");
    // Progress is NOT auto-advanced: it stays on the completed wave in ready_for_next_wave.
    expect(state.milestone?.progress).toMatchObject({
      active_wave_id: "w01",
      step: "ready_for_next_wave",
      active_task_ids: [],
    });
  });

  test("a passing FINAL wave hints closeout ready without auto-advancing progress", async () => {
    await approvedRoadmap();
    await transition(cwd, { operation: "start_milestone_planning" });
    // A single-wave milestone: w01 is the final (and only) wave.
    const input = milestoneInput();
    input.tasks = [{ ...input.tasks[0]! }];
    input.waves = [testWave("w01", ["t01-state"])];
    await transition(cwd, { operation: "create_milestone_plan", milestone: input });
    await recordPassedWaveFlowCheck();
    await transition(cwd, { operation: "approve_milestone", approver: "user" });
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "State task completed.",
    });
    await prepareWaveReview(cwd);

    const result = await recordWaveReview(cwd, {
      status: "passed",
      summary: "Final wave passed review.",
    });

    expect(result).toMatchObject({
      wave_id: "w01",
      wave_status: "complete",
      progress_step: "ready_for_next_wave",
    });
    // No waves remain, so the hint marks closeout ready — but does not mutate progress.
    expect(result.next_actions).toHaveLength(1);
    expect(result.next_actions?.[0]).toMatchObject({
      label: "Mark closeout ready",
      tool: {
        name: "omr_transition",
        input: {
          operation: "update_implementation_progress",
          progress: { step: "closeout_ready", activeTaskIds: [] },
        },
      },
    });
    const state = await loadState(cwd);
    // Progress is NOT auto-advanced to closeout_ready.
    expect(state.milestone?.progress).toMatchObject({
      active_wave_id: "w01",
      step: "ready_for_next_wave",
      active_task_ids: [],
    });
    expect(state.milestone?.progress.step).not.toBe("closeout_ready");
  });

  test("prepareWaveReview package carries the active wave's worker notes", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await appendNote(cwd, {
      kind: "worker",
      waveId: "w01",
      taskId: "t01-state",
      workerId: "alice",
      status: "resolved",
      title: "State task worker note",
      body: "Implemented the store lock and ran bun test.",
    });
    // A note from another wave must not leak into this wave's review package.
    await appendNote(cwd, {
      kind: "worker",
      waveId: "w02",
      taskId: "t02-report",
      workerId: "bob",
      status: "resolved",
      title: "Report task worker note",
      body: "Unrelated wave-2 note.",
    });
    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "State task completed.",
    });

    const review = await prepareWaveReview(cwd);
    expect(review.worker_notes).toBeDefined();
    expect(review.worker_notes.length).toBe(1);
    expect(review.worker_notes[0]?.title).toBe("State task worker note");
    // Bodies ride along so the reviewer needs no extra context call.
    expect(review.worker_notes[0]?.body).toContain("Implemented the store lock");
    // The wave-2 note is filtered out.
    expect(review.worker_notes.some((note) => note.title === "Report task worker note")).toBe(false);
  });

  test("summarizeState active_wave scope returns only the active wave and its tasks", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await appendNote(cwd, {
      kind: "worker",
      waveId: "w01",
      taskId: "t01-state",
      workerId: "alice",
      status: "resolved",
      title: "Active wave worker note",
      body: "Progress note for the active wave.",
    });
    await openBlocker(cwd, {
      roadmapId: "complex-refactor",
      milestoneId: "m01-core",
      waveId: "w01",
      severity: "non_blocking",
      title: "Active wave advisory",
      description: "Advisory for the active wave.",
      createdBy: "reviewer",
    });
    await openBlocker(cwd, {
      roadmapId: "complex-refactor",
      milestoneId: "m01-core",
      waveId: "w02",
      severity: "non_blocking",
      title: "Other wave advisory",
      description: "Advisory for another wave.",
      createdBy: "reviewer",
    });

    const state = await loadState(cwd);
    const blockers = await loadRoadmapBlockers(cwd, "complex-refactor");
    const noteSections = (
      await searchContext(cwd, { artifacts: ["notes"], kinds: ["worker", "review"], waveId: "w01" })
    ).results;
    const summary = summarizeState(state, "active_wave", { blockers, noteSections }) as {
      active?: unknown;
      active_wave?: { id: string; status: string; tasks: Array<{ id: string }> };
      progress?: { active_wave_id?: string };
      blockers: Array<{ title: string; wave_id?: string }>;
      context_sections: { notes: Array<{ title: string }> };
      milestone?: unknown;
      roadmap?: unknown;
    };

    // Only the active wave, with just its tasks — not the full milestone/roadmap.
    expect(summary.milestone).toBeUndefined();
    expect(summary.roadmap).toBeUndefined();
    expect(summary.active_wave?.id).toBe("w01");
    expect(summary.active_wave?.status).toBe("running");
    expect(summary.active_wave?.tasks.map((task) => task.id)).toEqual(["t01-state"]);
    expect(summary.progress?.active_wave_id).toBe("w01");
    // Blockers are filtered to the active wave.
    expect(summary.blockers.map((blocker) => blocker.title)).toEqual(["Active wave advisory"]);
    // Note refs are waveId-filtered worker/review notes.
    expect(summary.context_sections.notes.map((note) => note.title)).toEqual(["Active wave worker note"]);
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

  test("dispatch assignments carry a plan-derived manifest and verification preflight", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });

    const result = await prepareWaveDispatch(cwd);
    const assignment = result.assignments.find((entry) => entry.task_id === "t01-state");
    expect(assignment).toBeDefined();
    const manifest = assignment!.manifest!;
    const preflight = assignment!.verification_preflight!;

    // Manifest is derived from the task/plan fields, not filesystem discovery.
    expect(manifest).toMatchObject({
      owned_files: ["src/core/store.ts"],
      owned_modules: [],
      dependencies: [],
      reserved_sibling_scope: [],
    });
    expect(manifest.relevant_existing_code).toBeDefined();
    expect(manifest.relevant_documentation).toBeDefined();

    // Verification preflight echoes the task commands plus guidance.
    expect(preflight.commands).toEqual(["bun test"]);
    expect(preflight.cli_assumption_warnings).toEqual([]);
    expect(preflight.guidance).toHaveLength(1);
    expect(preflight.guidance[0]).toContain("append a blocking note");

    // The worker prompt embeds both sections and warns the manifest is not proof paths exist.
    expect(assignment!.prompt).toContain("Plan-derived manifest:");
    expect(assignment!.prompt).toContain("Verification preflight:");
    expect(assignment!.prompt).toContain("NOT proof that any listed path exists");
    // Workers must not build or test; the reviewer runs verification after the wave.
    expect(assignment!.prompt).toContain("do NOT run them yourself");
    expect(assignment!.prompt).toContain(
      "Do NOT run builds, compilers, test suites, or these verification commands",
    );
  });

  test("review package carries a de-duplicated manifest and verification preflight", async () => {
    await approvedRoadmap();
    await transition(cwd, { operation: "start_milestone_planning" });
    // Two concurrent tasks in one wave so the review manifest must de-duplicate across them.
    const input = milestoneInput();
    input.tasks = [
      { ...input.tasks[0]! },
      { ...input.tasks[1]!, depends_on: [] },
    ];
    input.waves = [testWave("w01", ["t01-state", "t02-report"])];
    await transition(cwd, { operation: "create_milestone_plan", milestone: input });
    await recordPassedWaveFlowCheck();
    await transition(cwd, { operation: "approve_milestone", approver: "user" });
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWaveResult(cwd, { taskId: "t01-state", status: "completed", summary: "State done." });
    await recordWaveResult(cwd, { taskId: "t02-report", status: "completed", summary: "Report done." });

    const review = await prepareWaveReview(cwd);
    const reviewManifest = review.manifest!;
    const reviewPreflight = review.verification_preflight!;
    // Reviewer inspects the whole wave, so no sibling reservation applies.
    expect(reviewManifest.reserved_sibling_scope).toEqual([]);
    expect(reviewManifest.owned_files).toEqual(
      expect.arrayContaining(["src/core/store.ts", "src/core/report.ts"]),
    );
    // De-duplicated concatenation: no repeated entries.
    expect(new Set(reviewManifest.owned_files).size).toBe(reviewManifest.owned_files.length);
    expect(reviewPreflight.commands).toEqual(["bun test"]);
    expect(reviewPreflight.guidance).toHaveLength(1);
    expect(review.prompt).toContain("Plan-derived manifest:");
    expect(review.prompt).toContain("Verification preflight:");
    // Reviewer explicitly owns build/test execution for the wave.
    expect(review.prompt).toContain("You own running the wave's build, tests, and verification commands");
  });
});

describe("part 7 operational gaps", () => {
  // 7a — durable result handoff: a completed worker may have already terminated when the
  // orchestrator asks for its report. record_wave_result must source the summary from the
  // worker's resolved note in state rather than requiring a live IRC reply.
  test("record_wave_result sources its summary from the resolved worker note when no summary is supplied", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, { taskId: "t01-state", agentId: "agent-store", jobId: "job-store" });
    // The worker persists its structured result to a note before yielding, then terminates.
    await appendNote(cwd, {
      kind: "worker",
      waveId: "w01",
      taskId: "t01-state",
      workerId: "worker-light",
      status: "resolved",
      title: "State task result",
      body: "Implemented the store lock and ran bun test green; all done criteria met.",
    });

    // Peer is gone — orchestrator records completion with no summary of its own.
    const result = await recordWaveResult(cwd, { taskId: "t01-state", status: "completed" });
    expect(result.status).toBe("done");

    const state = await loadState(cwd);
    expect(state.milestone?.tasks.find((task) => task.id === "t01-state")?.status).toBe("done");

    // The completion event carries the summary sourced from the worker note.
    const events = await readRoadmapEvents(cwd, { type: ["task.status_changed"] });
    const doneEvent = events.events.find(
      (event) => (event.details as { task_status?: string } | undefined)?.task_status === "done",
    );
    expect((doneEvent?.details as { summary?: string } | undefined)?.summary).toContain(
      "Implemented the store lock",
    );
  });

  // 7b — edit-gate deadlock: a rework worker dispatched to fix an open blocker must be able
  // to edit the files it was sent to fix without first resolving that blocker.
  test("the write-gate permits the assigned rework worker to edit its blocker's task without a prior resolve_blocker", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);

    // An open blocking blocker against t01-state closes the write-gate.
    await openBlocker(cwd, {
      roadmapId: "complex-refactor",
      milestoneId: "m01-core",
      waveId: "w01",
      taskId: "t01-state",
      severity: "blocking",
      title: "Review finding: fix ownership drift",
      description: "Worker-fixable rework needed on the store lock.",
      createdBy: "reviewer",
    });

    // Before a rework worker is dispatched, the gate is closed by the open blocker.
    const beforeDispatch = await validateImplementationGate(cwd);
    expect(beforeDispatch.valid).toBe(false);
    expect(beforeDispatch.errors.some((error) => error.code === "blockers.blocking.open")).toBe(true);
    expect((await shouldBlockToolCall(cwd, "edit")).block).toBe(true);

    // Dispatching the rework worker for the blocker's task authorizes its edits.
    await recordWorkerDispatch(cwd, { taskId: "t01-state", agentId: "rework-agent", jobId: "rework-job" });

    const afterDispatch = await validateImplementationGate(cwd);
    expect(afterDispatch.valid).toBe(true);
    expect(afterDispatch.errors.some((error) => error.code === "blockers.blocking.open")).toBe(false);
    expect((await shouldBlockToolCall(cwd, "edit")).block).toBe(false);

    // The blocker itself is still open — no premature resolve_blocker was required.
    const blockers = await listBlockers(cwd, { taskId: "t01-state", status: "open" });
    expect(blockers.blockers).toHaveLength(1);
  });

  // 7c — stand-down note hygiene: a stood-down worker's issue/deferred note must be
  // reconciled once the task later resolves via another worker.
  test("a stood-down worker's issue/deferred note is reconciled once the task resolves", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);

    // A stood-down worker leaves a durable deferred issue note against the task.
    await appendNote(cwd, {
      kind: "issue",
      waveId: "w01",
      taskId: "t01-state",
      workerId: "stood-down-worker",
      status: "deferred",
      title: "Partial refactor left incomplete",
      body: "Stood down mid-edit to avoid collision with the active worker.",
    });

    const before = await searchContext(cwd, {
      artifacts: ["notes"],
      kinds: ["issue"],
      taskId: "t01-state",
      statuses: ["deferred"],
    });
    expect(before.results).toHaveLength(1);

    // The task then completes via another worker.
    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "Task completed by the recovering worker.",
    });

    // The deferred issue no longer survives against the done task.
    const deferred = await searchContext(cwd, {
      artifacts: ["notes"],
      kinds: ["issue"],
      taskId: "t01-state",
      statuses: ["deferred"],
    });
    expect(deferred.results).toHaveLength(0);

    const resolved = await searchContext(cwd, {
      artifacts: ["notes"],
      kinds: ["issue"],
      taskId: "t01-state",
      statuses: ["resolved"],
    });
    expect(resolved.results).toHaveLength(1);
    expect(resolved.results[0]?.metadata.reconciled).toBe(true);
  });
});
