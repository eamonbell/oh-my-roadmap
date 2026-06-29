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
  resetRoadmapStateForTest,
  transition,
  type CreateMilestonePlanInput,
} from "../src/core/store";
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
        status: "assigned" as const,
        depends_on: [],
        owned_files: ["src/core/store.ts"],
        owned_modules: [],
        shared_interfaces: ["RoadmapState"],
      },
      {
        id: "t02-report",
        title: "Report engine",
        worker: "worker-b",
        status: "assigned" as const,
        depends_on: ["t01-state"],
        owned_files: ["src/core/report.ts"],
        owned_modules: [],
        shared_interfaces: ["LoadedState"],
      },
    ],
    waves: [
      { id: "w01", status: "pending" as const, tasks: ["t01-state"] },
      { id: "w02", status: "pending" as const, tasks: ["t02-report"] },
    ],
  };
}

async function approvedMilestone(): Promise<void> {
  await initRoadmap(cwd, {
    roadmapId: "complex-refactor",
    title: "Complex Refactor",
    discovery: { recorded: true },
  });
  await transition(cwd, {
    operation: "approve_roadmap",
    approver: "user",
    summary: "Roadmap approved",
  });
  await transition(cwd, { operation: "create_milestone_plan", milestone: milestoneInput() });
  await transition(cwd, {
    operation: "approve_milestone",
    approver: "user",
    summary: "Milestone approved",
  });
}

describe("roadmap state lifecycle", () => {
  test("initializes active roadmap and blocks implementation before approvals", async () => {
    await initRoadmap(cwd, { roadmapId: "test-roadmap", title: "Test Roadmap" });

    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(true);

    const gate = await validateImplementationGate(cwd);
    expect(gate.valid).toBe(false);
    expect(gate.errors.map((error) => error.code)).toContain("gate.phase.closed");
  });

  test("requires discovery before roadmap approval is valid", async () => {
    await initRoadmap(cwd, { roadmapId: "missing-discovery", title: "Missing Discovery" });
    await transition(cwd, {
      operation: "approve_roadmap",
      approver: "user",
      summary: "Premature",
    });

    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("discovery.missing");
  });

  test("opens implementation gate only after milestone approval and implementation phase", async () => {
    await approvedMilestone();
    expect((await validateImplementationGate(cwd)).valid).toBe(false);

    await transition(cwd, { operation: "start_implementation" });
    const gate = await validateImplementationGate(cwd);
    expect(gate.valid).toBe(true);
  });

  test("rejects overlapping ownership in the same wave", async () => {
    await initRoadmap(cwd, {
      roadmapId: "overlap-roadmap",
      title: "Overlap Roadmap",
      discovery: { recorded: true },
    });
    await transition(cwd, {
      operation: "approve_roadmap",
      approver: "user",
      summary: "Approved",
    });
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

  test("creates and gates an approved post-implementation change request", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await transition(cwd, { operation: "start_reviewing" });
    await createChangeRequest(cwd, {
      changeRequestId: "c01-adjust",
      title: "Adjust behavior",
      request: "Change the implementation after review.",
      verificationCommands: ["bun test"],
      acceptanceCriteria: ["Requested delta is implemented"],
      tasks: milestoneInput().tasks,
      waves: milestoneInput().waves,
    });

    expect((await validateImplementationGate(cwd)).valid).toBe(false);
    await transition(cwd, {
      operation: "approve_change",
      approver: "user",
      summary: "Change plan approved",
    });
    expect((await validateImplementationGate(cwd)).valid).toBe(true);
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
