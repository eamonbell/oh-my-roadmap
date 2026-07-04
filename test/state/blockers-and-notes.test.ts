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

describe("roadmap state blockers and notes", () => {
  test("blocks open canonical blockers until resolved or deferred", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });

    const blocker = await openBlocker(cwd, {
      title: "Blocking review finding",
      description: "The wave changed unowned files.",
      taskId: "t01-state",
      waveId: "w01",
      createdBy: "reviewer",
    });

    const closedGate = await validateImplementationGate(cwd);
    expect(closedGate.valid).toBe(false);
    expect(closedGate.errors.map((error) => error.code)).toContain("blockers.blocking.open");

    await resolveBlocker(cwd, {
      blockerId: blocker.id,
      resolvedBy: "user",
      resolution: "Worker reverted the unowned file change.",
    });

    const resolvedGate = await validateImplementationGate(cwd);
    expect(resolvedGate.valid).toBe(true);

    const deferred = await openBlocker(cwd, {
      title: "External rollout approval",
      description: "The rollout owner is out today.",
      createdBy: "orchestrator",
    });
    await deferBlocker(cwd, {
      blockerId: deferred.id,
      deferredBy: "user",
      deferReason: "Approval can happen after this milestone closes.",
    });

    const deferredGate = await validateImplementationGate(cwd);
    expect(deferredGate.valid).toBe(true);

    const events = await readRoadmapEvents(cwd, { blockerId: blocker.id, type: ["blocker.opened", "blocker.resolved"] });
    expect(events.events.map((event) => event.type)).toEqual(["blocker.opened", "blocker.resolved"]);
    expect(events.events[0]?.scope).toMatchObject({
      blocker_id: blocker.id,
      task_id: "t01-state",
      wave_id: "w01",
    });
  });

  test("append blocking note creates a canonical blocker and tags note metadata", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    const notePath = await appendNote(cwd, {
      kind: "review",
      title: "Blocking review finding",
      body: "The wave changed unowned files.",
      blocking: true,
      status: "open",
    });
    const blockers = await loadRoadmapBlockers(cwd, "complex-refactor");
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      roadmap_id: "complex-refactor",
      milestone_id: "m01-core",
      severity: "blocking",
      status: "open",
      title: "Blocking review finding",
      note_path: notePath,
    });
    const noteText = await fs.readFile(notePath, "utf8");
    expect(noteText).toContain(`blocker_id: ${blockers[0]?.id}`);

    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("blockers.blocking.open");
    expect(validation.errors.map((error) => error.code)).not.toContain("notes.blocking.open");
  });

  test("legacy blocking notes without canonical blockers still validate as bypassable blockers", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await fs.appendFile(
      milestoneNotesPath(cwd, "complex-refactor", "m01-core"),
      [
        "",
        "---",
        "kind: worker",
        "roadmap_id: complex-refactor",
        "milestone_id: m01-core",
        "blocking: true",
        "status: open",
        "at: 2026-01-01T00:00:00.000Z",
        "---",
        "",
        "## Stale worker blocker",
        "",
        "Worker PATH did not include go; main reran verification with the assigned absolute Go binary.",
        "",
      ].join("\n"),
      "utf8",
    );
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

  test("malformed note frontmatter blocks state validation but is bypassable at the gate", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await fs.appendFile(
      milestoneNotesPath(cwd, "complex-refactor", "m01-core"),
      [
        "",
        "---",
        "kind: worker",
        "roadmap_id: complex-refactor",
        "milestone_id: m01-core",
        "blocking: true",
        "status: open",
        "at: 2026-01-01T00:00:00.000Z",
        "",
        "## Malformed note without closing frontmatter",
        "",
        "This note is missing its closing frontmatter delimiter and cannot be parsed.",
        "",
      ].join("\n"),
      "utf8",
    );

    const stateValidation = await validateRoadmapState(cwd);
    expect(stateValidation.valid).toBe(false);
    expect(stateValidation.errors.map((error) => error.code)).toContain("notes.malformed");

    await transition(cwd, {
      operation: "request_bypass",
      reason: "A single malformed note must not wedge all file writes.",
      approver: "user",
    });

    const gate = await validateImplementationGate(cwd);
    expect(gate.valid).toBe(true);
    expect(gate.errors).toEqual([]);
    expect(gate.warnings.map((warning) => warning.code)).toContain("bypass.active");
  });

  test("legacy blocking note is not suppressed by unrelated canonical blocker in the same scope", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    const unrelated = await openBlocker(cwd, {
      title: "Resolved same-scope canonical blocker",
      description: "This canonical blocker is not the legacy note.",
    });
    await resolveBlocker(cwd, {
      blockerId: unrelated.id,
      resolution: "Resolved before the legacy note was added.",
    });
    await fs.appendFile(
      milestoneNotesPath(cwd, "complex-refactor", "m01-core"),
      [
        "",
        "---",
        "kind: review",
        "roadmap_id: complex-refactor",
        "milestone_id: m01-core",
        "blocking: true",
        "status: open",
        "at: 2026-01-01T00:00:00.000Z",
        "---",
        "",
        "## Legacy unresolved blocker",
        "",
        "This note has no blocker_id and is not represented by the resolved canonical blocker.",
        "",
      ].join("\n"),
      "utf8",
    );

    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("notes.blocking.open");
  });

  test("explicit roadmap blocker scope does not borrow active milestone or change scope", async () => {
    await approvedMilestone();
    const blocker = await openBlocker(cwd, {
      roadmapId: "other-roadmap",
      title: "Other roadmap blocker",
      description: "This blocker is intentionally roadmap scoped.",
    });

    expect(blocker).toMatchObject({
      roadmap_id: "other-roadmap",
      title: "Other roadmap blocker",
    });
    expect(blocker.milestone_id).toBeUndefined();
    expect(blocker.change_request_id).toBeUndefined();

    const scoped = await listBlockers(cwd, { roadmapId: "other-roadmap" });
    expect(scoped.blockers).toEqual([blocker]);
    expect((await readRoadmapEvents(cwd, { roadmapId: "other-roadmap", blockerId: blocker.id })).events[0]?.scope).toEqual({
      roadmap_id: "other-roadmap",
      blocker_id: blocker.id,
    });
  });

  test("lists blockers by scope, status, and severity", async () => {
    await approvedMilestone();
    const blocking = await openBlocker(cwd, {
      title: "Task blocker",
      description: "Task t01 is waiting for review.",
      taskId: "t01-state",
      waveId: "w01",
    });
    const nonBlocking = await openBlocker(cwd, {
      title: "FYI blocker",
      description: "Track follow-up without closing gates.",
      severity: "non_blocking",
      taskId: "t02-report",
    });
    await resolveBlocker(cwd, {
      blockerId: blocking.id,
      resolution: "Review completed.",
    });

    const resolved = await listBlockers(cwd, {
      status: "resolved",
      severity: "blocking",
      taskId: "t01-state",
    });
    expect(resolved.blockers.map((blocker) => blocker.id)).toEqual([blocking.id]);

    const scoped = await listBlockers(cwd, {
      status: "open",
      severity: "non_blocking",
      taskId: "t02-report",
    });
    expect(scoped).toMatchObject({
      roadmapId: "complex-refactor",
      total: 1,
      returned: 1,
      blockers: [{ id: nonBlocking.id, severity: "non_blocking", status: "open" }],
    });

    expect(await fs.readFile(roadmapBlockersPath(cwd, "complex-refactor"), "utf8")).toContain("blockers:");
  });
});
