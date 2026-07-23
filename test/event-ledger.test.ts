import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readRoadmapEvents } from "@oh-my-roadmap/core/events";
import { roadmapEventsPath } from "@oh-my-roadmap/core/paths";
import {
  amend,
  appendNote,
  createChangeRequest,
  initRoadmap,
  loadState,
  transition,
  transitionWithReceipt,
  updateRoadmap,
  type CreateMilestonePlanInput,
  type UpdateRoadmapInput,
} from "@oh-my-roadmap/core/store/index";
import type { CloseoutEvidence } from "@oh-my-roadmap/core/types";

let cwd = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-events-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

function roadmapInput(): UpdateRoadmapInput {
  return {
    goal: "Record workflow events.",
    successCriteria: ["Mutations append durable events."],
    constraints: ["Keep event storage append-only."],
    nonGoals: ["Do not add runtime or blocker state."],
    context: ["src/core/store.ts owns workflow mutations."],
    evidence: ["events.ndjson stores one JSON event per line."],
    risks: ["Missing events make recovery harder."],
    milestones: [
      {
        id: "m01-core",
        title: "Core milestone",
        status: "planned",
        goal: "Exercise event ledger mutations.",
        scope: ["Record transition and note events."],
        non_goals: ["Do not test UI summaries here."],
        evidence: ["readRoadmapEvents filters the ledger."],
        dependencies: [],
        risks: ["Event writes must fail visibly."],
        acceptance_intent: ["Lifecycle events are readable in order."],
        verification_intent: ["Run focused event tests."],
      },
    ],
  };
}

function milestoneInput(): CreateMilestonePlanInput {
  return {
    milestoneId: "m01-core",
    title: "Core milestone",
    verificationCommands: ["bun test test/event-ledger.test.ts"],
    acceptanceCriteria: ["Events are recorded"],
    tasks: [
      {
        id: "t01",
        title: "Event task",
        objective: "Record task status changes.",
        implementation_notes: ["Use the existing transition operation."],
        done_criteria: ["The event ledger contains the task update."],
        verification_commands: ["bun test test/event-ledger.test.ts"],
        worker: "worker",
        status: "assigned",
        depends_on: [],
        owned_files: ["src/core/events.ts"],
        owned_modules: [],
        shared_interfaces: ["RoadmapEvent"],
        relevant_existing_code: [],
        shared_interface_contracts: [],
      },
    ],
    waves: [
      {
        id: "w01",
        goal: "Record wave changes.",
        exit_criteria: ["The wave event is readable."],
        review_checkpoint: "Review event payloads.",
        status: "pending",
        tasks: ["t01"],
      },
    ],
  };
}

function closedEvidence(overrides: Partial<CloseoutEvidence> = {}): CloseoutEvidence {
  return {
    roadmap_id: "event-roadmap",
    milestone_id: "m01-core",
    status: "closed",
    acceptance_results: [{ item: "Events are recorded", status: "passed" }],
    verification_results: [{ item: "bun test test/event-ledger.test.ts", status: "passed" }],
    worker_notes_reviewed: true,
    review_summary: "Event ledger evidence was reviewed.",
    unresolved_risks: [],
    closed_by: "user",
    ...overrides,
  };
}

async function approveRoadmap(): Promise<void> {
  await initRoadmap(cwd, { roadmapId: "event-roadmap", title: "Event Roadmap" });
  await transition(cwd, {
    operation: "record_discovery",
    discovery: { findings: ["Inspected event ledger surfaces."] },
  });
  await updateRoadmap(cwd, roadmapInput());
  await transition(cwd, {
    operation: "record_roadmap_milestone_check",
    roadmapMilestoneCheck: {
      status: "passed",
      checkedBy: "roadmap-milestone-checker",
      summary: "Roadmap milestone flow is coherent.",
      findings: [],
    },
  });
  await transition(cwd, { operation: "approve_roadmap", approver: "user" });
}

async function approveMilestone(): Promise<void> {
  await approveRoadmap();
  await transition(cwd, { operation: "start_milestone_planning" });
  await transition(cwd, { operation: "create_milestone_plan", milestone: milestoneInput() });
  await transition(cwd, {
    operation: "record_wave_flow_check",
    waveFlowCheck: {
      status: "passed",
      checkedBy: "wave-flow-checker",
      summary: "Wave flow is coherent.",
      findings: [],
    },
  });
  await transition(cwd, { operation: "approve_milestone", approver: "user" });
}

describe("event ledger", () => {
  test("records lifecycle, note, amendment, and closeout events in append order", async () => {
    await approveMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await transition(cwd, { operation: "update_task_status", taskId: "t01", taskStatus: "started" });
    await transition(cwd, { operation: "update_wave_status", waveId: "w01", waveStatus: "running" });
    await transition(cwd, {
      operation: "update_implementation_progress",
      progress: { activeWaveId: "w01", step: "workers_running", activeTaskIds: ["t01"] },
    });
    await appendNote(cwd, {
      kind: "worker",
      title: "Worker note",
      body: "Implemented the event task.",
      taskId: "t01",
      workerId: "worker",
      status: "resolved",
    });
    await amend(cwd, {
      scope: "roadmap",
      title: "Clerical event amendment",
      body: "Clarify event ledger wording.",
      material: false,
    });
    await transition(cwd, { operation: "start_reviewing" });
    await transition(cwd, { operation: "start_closeout" });
    await transition(cwd, { operation: "record_closeout", closeout: closedEvidence() });
    await transition(cwd, { operation: "complete_milestone" });

    const result = await readRoadmapEvents(cwd);
    const types = result.events.map((event) => event.type);
    expect(types).toEqual([
      "roadmap.initialized",
      "roadmap.discovery_recorded",
      "roadmap.updated",
      "quality_gate.recorded",
      "roadmap.approved",
      "milestone.planning_started",
      "milestone.plan_created",
      "quality_gate.recorded",
      "milestone.approved",
      "implementation.started",
      "task.status_changed",
      "wave.status_changed",
      "progress.updated",
      "note.appended",
      "amendment.recorded",
      "review.started",
      "closeout.started",
      "closeout.recorded",
      "milestone.completed",
    ]);
    expect(new Set(result.events.map((event) => event.id)).size).toBe(result.events.length);
    const roadmapGate = result.events.find((event) => event.scope.gate === "roadmap_milestone_check");
    expect(roadmapGate?.after?.event_id).toBe(roadmapGate?.id);
    expect((await loadState(cwd)).roadmap?.roadmap_milestone_check.event_id).toBe(roadmapGate?.id);

    const taskEvents = await readRoadmapEvents(cwd, { taskId: "t01", type: ["task.status_changed"] });
    expect(taskEvents.events).toHaveLength(1);
    expect(taskEvents.events[0]?.before).toEqual({ task_id: "t01", status: "assigned" });
    expect(taskEvents.events[0]?.after).toEqual({ task_id: "t01", status: "started" });

    const latest = await readRoadmapEvents(cwd, { limit: 3 });
    expect(latest.total).toBe(result.total);
    expect(latest.events.map((event) => event.type)).toEqual([
      "closeout.started",
      "closeout.recorded",
      "milestone.completed",
    ]);
  });

  test("transition receipts reuse the appended roadmap event id for non-ad-hoc transitions", async () => {
    await approveRoadmap();

    const { receipt } = await transitionWithReceipt(cwd, { operation: "start_milestone_planning" });
    const events = await readRoadmapEvents(cwd, { type: ["milestone.planning_started"] });
    expect(events.events).toHaveLength(1);
    const appended = events.events[0];
    expect(appended?.id).toBeDefined();
    expect(receipt.event_id).toBe(appended?.id ?? "");
    expect(receipt.operation).toBe("start_milestone_planning");
    expect(receipt.event_type).toBe("milestone.planning_started");
    expect(receipt.scope.roadmap_id).toBe("event-roadmap");
  });

  test("skips a torn/malformed event line and still returns valid events", async () => {
    await initRoadmap(cwd, { roadmapId: "event-roadmap", title: "Event Roadmap" });
    await transition(cwd, { operation: "record_discovery", discovery: { findings: ["Inspected surfaces."] } });

    const filePath = roadmapEventsPath(cwd, "event-roadmap");
    const original = await fs.readFile(filePath, "utf8");
    const lines = original.split("\n").filter((line) => line.trim() !== "");
    // Corrupt (tear) the middle line, then append it back plus a garbage line.
    const torn = `${lines[0]}\n${lines[1]!.slice(0, lines[1]!.length - 5)}\nnot json at all\n`;
    await fs.writeFile(filePath, torn, "utf8");

    const result = await readRoadmapEvents(cwd);
    // The one intact line still parses; the torn and garbage lines are skipped.
    expect(result.events.map((event) => event.type)).toEqual(["roadmap.initialized"]);
  });

  test("records change request lifecycle events with change scope", async () => {
    await approveMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await transition(cwd, { operation: "start_reviewing" });
    await createChangeRequest(cwd, {
      changeRequestId: "c01-fix",
      title: "Fix event behavior",
      request: "Adjust the implementation after review.",
      verificationCommands: ["bun test test/event-ledger.test.ts"],
      acceptanceCriteria: ["Change events are recorded"],
      tasks: [{ ...milestoneInput().tasks[0]!, id: "t-change", depends_on: [] }],
      waves: [{ ...milestoneInput().waves[0]!, tasks: ["t-change"] }],
    });
    await transition(cwd, {
      operation: "record_wave_flow_check",
      waveFlowCheck: {
        status: "passed",
        checkedBy: "wave-flow-checker",
        summary: "Change flow is coherent.",
        findings: [],
      },
    });
    await transition(cwd, { operation: "approve_change", approver: "user" });
    await transition(cwd, { operation: "start_implementation" });
    await transition(cwd, {
      operation: "record_closeout",
      closeout: closedEvidence({
        acceptance_results: [{ item: "Change events are recorded", status: "passed" }],
      }),
    });
    await transition(cwd, { operation: "close_change" });

    const changeEvents = await readRoadmapEvents(cwd, { changeRequestId: "c01-fix" });
    expect(changeEvents.events.map((event) => event.type)).toEqual([
      "change.created",
      "quality_gate.recorded",
      "change.approved",
      "implementation.started",
      "closeout.recorded",
      "change.closed",
    ]);
    expect(changeEvents.events.every((event) => event.scope.change_request_id === "c01-fix")).toBe(true);
  });

  test("does not append for rejected transitions and rejects when event append fails", async () => {
    await initRoadmap(cwd, { roadmapId: "event-roadmap", title: "Event Roadmap" });
    expect((await readRoadmapEvents(cwd)).events.map((event) => event.type)).toEqual(["roadmap.initialized"]);

    await expect(transition(cwd, { operation: "approve_roadmap", approver: "user" })).rejects.toThrow(
      "approve_roadmap requires phase roadmap_draft",
    );
    expect((await readRoadmapEvents(cwd)).events.map((event) => event.type)).toEqual(["roadmap.initialized"]);

    const eventsDir = path.dirname(roadmapEventsPath(cwd, "event-roadmap"));
    await fs.chmod(eventsDir, 0o555);
    try {
      await expect(transition(cwd, { operation: "record_discovery" })).rejects.toThrow();
    } finally {
      await fs.chmod(eventsDir, 0o755);
    }

    expect((await readRoadmapEvents(cwd)).events.map((event) => event.type)).toEqual(["roadmap.initialized"]);
    const state = await loadState(cwd);
    expect(state.roadmap?.phase).toBe("discovery");
    expect(state.roadmap?.discovery.recorded).toBe(false);
  });
});
