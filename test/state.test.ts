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
import { decisionsPath, roadmapDocPath } from "../src/core/paths";
import type { CloseoutEvidence } from "../src/core/types";
import { validateImplementationGate, validateRoadmapState } from "../src/core/validation";

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
        worker: "worker-a",
        status: "assigned",
        depends_on: [],
        owned_files: ["src/core/store.ts"],
        owned_modules: [],
        shared_interfaces: ["RoadmapState"],
      },
      {
        id: "t02-report",
        title: "Report engine",
        worker: "worker-b",
        status: "assigned",
        depends_on: ["t01-state"],
        owned_files: ["src/core/report.ts"],
        owned_modules: [],
        shared_interfaces: ["LoadedState"],
      },
    ],
    waves: [
      { id: "w01", status: "pending", tasks: ["t01-state"] },
      { id: "w02", status: "pending", tasks: ["t02-report"] },
    ],
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

async function approvedMilestone(): Promise<void> {
  await approvedRoadmap();
  await transition(cwd, { operation: "start_milestone_planning" });
  await transition(cwd, { operation: "create_milestone_plan", milestone: milestoneInput() });
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
      { id: "w01", status: "pending", tasks: ["t01-state", "t02-report"] },
      { id: "w02", status: "pending", tasks: ["t01-state"] },
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
    input.waves = [{ id: "w01", status: "pending", tasks: ["t01-state", "t02-report"] }];
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
      waves: [{ id: "w01", status: "pending", tasks: ["t01-change"] }],
    });

    expect((await validateImplementationGate(cwd)).valid).toBe(false);
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
        waves: [{ id: "w01", status: "pending", tasks: [`t-${phase}`] }],
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
    input.waves = [{ id: "w01", status: "pending", tasks: ["missing-task"] }];
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
