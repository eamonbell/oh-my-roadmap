import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { shouldBlockToolCall } from "../src/core/gate";
import { renderReport } from "../src/core/report";
import {
  appendNote,
  createChangeRequest,
  initRoadmap,
  loadState,
  renderRoadmapMarkdown,
  resetRoadmapStateForTest,
  transition,
  updateRoadmap,
  type CreateMilestonePlanInput,
  type UpdateRoadmapInput,
} from "../src/core/store";
import { decisionsPath, milestoneNotesPath, milestonePlanPath, roadmapDocPath, storeLockPath } from "../src/core/paths";
import type { CloseoutEvidence } from "../src/core/types";
import { validateImplementationGate, validateRoadmapState } from "../src/core/validation";
import { summarizeState } from "../src/core/state-summary";

let cwd = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-engineer-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

function milestoneInput(): CreateMilestonePlanInput {
  return {
    milestoneId: "m01-core",
    title: "Core milestone",
    verificationCommands: ["bun test"],
    acceptanceCriteria: ["State validates", "Gate opens only during implementation"],
    tasks: [
      {
        id: "t01-state",
        title: "State engine",
        objective: "Persist roadmap state changes safely.",
        implementation_notes: ["Update state storage and lifecycle transitions."],
        done_criteria: ["State lifecycle operations remain valid."],
        verification_commands: ["bun test"],
        worker: "worker-light",
        status: "assigned",
        depends_on: [],
        owned_files: ["src/core/store.ts"],
        owned_modules: [],
        shared_interfaces: ["RoadmapState"],
      },
      {
        id: "t02-report",
        title: "Report engine",
        objective: "Render roadmap state and next actions.",
        implementation_notes: ["Update report output from loaded state."],
        done_criteria: ["Reports show current milestone status."],
        verification_commands: ["bun test"],
        worker: "worker-heavy",
        status: "assigned",
        depends_on: ["t01-state"],
        owned_files: ["src/core/report.ts"],
        owned_modules: [],
        shared_interfaces: ["LoadedState"],
      },
    ],
    waves: [
      {
        id: "w01",
        goal: "Implement state storage.",
        exit_criteria: ["State task is complete."],
        review_checkpoint: "Review state ownership and verification.",
        status: "pending",
        tasks: ["t01-state"],
      },
      {
        id: "w02",
        goal: "Implement reporting.",
        exit_criteria: ["Report task is complete."],
        review_checkpoint: "Review report output and next action.",
        status: "pending",
        tasks: ["t02-report"],
      },
    ],
  };
}

function testWave(id: string, tasks: string[]): CreateMilestonePlanInput["waves"][number] {
  return {
    id,
    goal: `Complete ${id}.`,
    exit_criteria: [`${id} tasks are complete.`],
    review_checkpoint: `Review ${id} outputs.`,
    status: "pending",
    tasks,
  };
}

function additionalMilestone(id: string, title: string): UpdateRoadmapInput["milestones"][number] {
  const base = roadmapInput().milestones[0]!;
  return {
    ...base,
    id,
    title,
    status: "planned",
    goal: `Complete ${title}.`,
    dependencies: ["m01-core"],
  };
}

function closedEvidence(overrides: Partial<CloseoutEvidence> = {}): CloseoutEvidence {
  return {
    roadmap_id: "complex-refactor",
    milestone_id: "m01-core",
    status: "closed",
    acceptance_results: [
      { item: "State validates", status: "passed" },
      { item: "Gate opens only during implementation", status: "passed" },
    ],
    verification_results: [{ item: "bun test", status: "passed" }],
    worker_notes_reviewed: true,
    review_summary: "Worker notes and acceptance criteria were reviewed.",
    unresolved_risks: [],
    closed_by: "user",
    ...overrides,
  };
}

function roadmapInput(overrides: Partial<UpdateRoadmapInput> = {}): UpdateRoadmapInput {
  return {
    goal: "Refactor roadmap-engineer state safely.",
    successCriteria: ["Roadmap approval requires concrete milestones."],
    constraints: ["Keep the implementation simple and direct."],
    nonGoals: ["Do not create milestone task plans during roadmap creation."],
    context: ["Reviewed src/core/store.ts and src/core/validation.ts."],
    evidence: ["Discovery recorded current state lifecycle behavior."],
    risks: ["Validation may block old incomplete roadmap states."],
    milestones: [
      {
        id: "m01-core",
        title: "Core milestone",
        status: "planned",
        goal: "Harden core roadmap state and validation.",
        scope: ["Add structured roadmap finalization."],
        non_goals: ["Do not implement milestone tasks in roadmap planning."],
        evidence: ["src/core/store.ts owns roadmap transitions."],
        dependencies: [],
        risks: ["Approval may fail until the generated roadmap is current."],
        acceptance_intent: ["Roadmap cannot be approved without concrete milestone outlines."],
        verification_intent: ["Run bun test."],
      },
    ],
    ...overrides,
  };
}

async function approvedRoadmap(): Promise<void> {
  await initRoadmap(cwd, { roadmapId: "complex-refactor", title: "Complex Refactor" });
  await transition(cwd, {
    operation: "record_discovery",
    discovery: { findings: ["Inspected local roadmap-engineer sources."] },
  });
  await updateRoadmap(cwd, roadmapInput());
  await transition(cwd, {
    operation: "approve_roadmap",
    approver: "user",
    summary: "Roadmap approved",
  });
}

async function recordPassedWaveFlowCheck(summary = "Wave flow check passed."): Promise<void> {
  await transition(cwd, {
    operation: "record_wave_flow_check",
    waveFlowCheck: {
      status: "passed",
      checkedBy: "wave-flow-checker",
      summary,
      findings: [],
    },
  });
}

async function approvedMilestone(): Promise<void> {
  await approvedRoadmap();
  await transition(cwd, { operation: "start_milestone_planning" });
  await transition(cwd, { operation: "create_milestone_plan", milestone: milestoneInput() });
  await recordPassedWaveFlowCheck();
  await transition(cwd, {
    operation: "approve_milestone",
    approver: "user",
    summary: "Milestone approved",
  });
}

async function closeoutPhase(): Promise<void> {
  await approvedMilestone();
  await transition(cwd, { operation: "start_implementation" });
  await transition(cwd, { operation: "start_reviewing" });
  await transition(cwd, { operation: "start_closeout" });
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

    await transition(cwd, { operation: "approve_roadmap", approver: "user" });
    expect((await validateRoadmapState(cwd)).valid).toBe(true);
  });

  test("reopens an approved roadmap and requires regenerated approval", async () => {
    await approvedRoadmap();
    const approved = await loadState(cwd);
    if (!approved.roadmap) throw new Error("Expected roadmap state");
    const originalRoadmapText = await fs.readFile(roadmapDocPath(cwd, approved.roadmap.roadmap_id), "utf8");

    await transition(cwd, {
      operation: "reopen_roadmap",
      reason: "Add a missing migration milestone before planning starts.",
    });

    const reopened = await loadState(cwd);
    if (!reopened.roadmap) throw new Error("Expected reopened roadmap state");
    expect(reopened.roadmap.phase).toBe("roadmap_draft");
    expect(reopened.roadmap.roadmap_finalized).toBe(false);
    expect(reopened.roadmap.approvals).toHaveLength(1);
    expect(await fs.readFile(roadmapDocPath(cwd, reopened.roadmap.roadmap_id), "utf8")).toBe(originalRoadmapText);

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

  test("opens implementation gate only after milestone approval and implementation phase", async () => {
    await approvedMilestone();
    expect((await validateImplementationGate(cwd)).valid).toBe(false);

    await transition(cwd, { operation: "start_implementation" });
    const gate = await validateImplementationGate(cwd);
    expect(gate.valid).toBe(true);
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

  test("renders generated milestone markdown and updates implementation progress", async () => {
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
    expect(planMarkdown).toContain("## Wave Flow Check");
    expect(planMarkdown).toContain("- Status: pending");
    expect(planMarkdown).toContain("## Progress");

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
    expect(planMarkdown).toContain("- Step: workers_running");
    expect(planMarkdown).toContain("- Active tasks: t01-state");
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

  test("blocks open blocking notes until resolved or deferred", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await appendNote(cwd, {
      kind: "review",
      title: "Blocking review finding",
      body: "The wave changed unowned files.",
      blocking: true,
      status: "open",
    });

    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("notes.blocking.open");
  });

  test("bypass opens implementation gate when only blocking notes are open", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await appendNote(cwd, {
      kind: "worker",
      title: "Stale worker blocker",
      body: "Worker PATH did not include go; main reran verification with the assigned absolute Go binary.",
      blocking: true,
      status: "open",
    });
    await transition(cwd, {
      operation: "request_bypass",
      reason: "Historical worker blocker was resolved by main verification.",
      approver: "user",
    });

    const stateValidation = await validateRoadmapState(cwd);
    expect(stateValidation.valid).toBe(false);
    expect(stateValidation.errors.map((error) => error.code)).toContain("notes.blocking.open");

    const gate = await validateImplementationGate(cwd);
    expect(gate.valid).toBe(true);
    expect(gate.errors).toEqual([]);
    expect(gate.warnings.map((warning) => warning.code)).toContain("bypass.active");
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

  test("reset helper removes roadmap state", async () => {
    await initRoadmap(cwd, { roadmapId: "reset-roadmap", title: "Reset Roadmap" });
    await resetRoadmapStateForTest(cwd);
    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(true);
  });
});
