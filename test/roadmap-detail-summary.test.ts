import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { renderReport } from "../src/core/report";
import { buildRoadmapDetailSummary, NO_ACTIVE_ROADMAP_MESSAGE } from "../src/core/roadmap-detail-summary";
import {
  appendNote,
  initRoadmap,
  transition,
  updateRoadmap,
  type CreateMilestonePlanInput,
} from "../src/core/store";
import { recordMainUsage } from "../src/core/usage";

let cwd = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-detail-summary-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

function milestoneInput(): CreateMilestonePlanInput {
  return {
    milestoneId: "m01-core",
    title: "Core milestone",
    verificationCommands: ["bun test"],
    acceptanceCriteria: ["Summary is UI-ready"],
    tasks: [
      {
        id: "t01-state",
        title: "State task",
        objective: "Prepare state for UI summaries.",
        implementation_notes: ["Keep summary derivation outside renderReport."],
        done_criteria: ["Typed summary includes active task display fields."],
        verification_commands: ["bun test test/roadmap-detail-summary.test.ts"],
        worker: "worker-light",
        status: "assigned",
        depends_on: [],
        owned_files: ["src/core/roadmap-detail-summary.ts"],
        owned_modules: [],
        shared_interfaces: ["RoadmapDetailSummary"],
      },
    ],
    waves: [
      {
        id: "w01",
        goal: "Build the summary.",
        exit_criteria: ["Summary test passes."],
        review_checkpoint: "Review UI field names.",
        status: "pending",
        tasks: ["t01-state"],
      },
    ],
  };
}

async function approvedMilestone(): Promise<void> {
  await initRoadmap(cwd, { roadmapId: "summary-roadmap", title: "Summary Roadmap" });
  await transition(cwd, {
    operation: "record_discovery",
    discovery: { findings: ["Inspected report and state helpers."] },
  });
  await updateRoadmap(cwd, {
    goal: "Expose typed roadmap details.",
    successCriteria: ["UI receives typed display fields."],
    constraints: ["Do not change renderReport output."],
    nonGoals: ["Do not wire the summary into commands yet."],
    context: ["report.ts owns the existing text report."],
    evidence: ["roadmap-detail-summary.ts can load state directly."],
    risks: ["Summary fields may drift from report output."],
    milestones: [
      {
        id: "m01-core",
        title: "Core milestone",
        status: "planned",
        goal: "Build the summary builder.",
        scope: ["Add a typed core summary."],
        non_goals: ["Do not edit report-ui.ts."],
        evidence: ["loadState returns roadmap, milestone, and usage."],
        dependencies: [],
        risks: ["Gate status should stay source-of-truth derived."],
        acceptance_intent: ["Summary exposes active task and usage display fields."],
        verification_intent: ["Run focused summary tests."],
      },
    ],
  });
  await transition(cwd, {
    operation: "record_roadmap_milestone_check",
    roadmapMilestoneCheck: {
      status: "passed",
      checkedBy: "roadmap-milestone-checker",
      summary: "Roadmap milestone check passed.",
      findings: [],
    },
  });
  await transition(cwd, { operation: "approve_roadmap", approver: "user" });
  await transition(cwd, { operation: "start_milestone_planning" });
  await transition(cwd, { operation: "create_milestone_plan", milestone: milestoneInput() });
  await transition(cwd, {
    operation: "record_wave_flow_check",
    waveFlowCheck: {
      status: "passed",
      checkedBy: "wave-flow-checker",
      summary: "Wave flow check passed.",
      findings: [],
    },
  });
  await transition(cwd, { operation: "approve_milestone", approver: "user" });
}

describe("roadmap detail summary", () => {
  test("returns the current no-roadmap message for empty state", async () => {
    const summary = await buildRoadmapDetailSummary(cwd);

    expect(summary).toEqual({
      kind: "empty",
      message: NO_ACTIVE_ROADMAP_MESSAGE,
    });
    expect(await renderReport(cwd)).toBe(NO_ACTIVE_ROADMAP_MESSAGE);
  });

  test("builds active UI display fields from roadmap state", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await transition(cwd, { operation: "update_task_status", taskId: "t01-state", taskStatus: "blocked" });
    await transition(cwd, { operation: "update_wave_status", waveId: "w01", waveStatus: "blocked" });
    await transition(cwd, {
      operation: "update_implementation_progress",
      progress: {
        activeWaveId: "w01",
        step: "resolving_blockers",
        activeTaskIds: ["t01-state"],
        blockedReason: "Need final UI field review.",
      },
    });
    await appendNote(cwd, {
      kind: "worker",
      title: "Blocking note",
      body: "The UI contract needs one more review.",
      blocking: true,
      status: "open",
    });
    await transition(cwd, {
      operation: "request_bypass",
      reason: "User approved temporary UI contract review bypass.",
      approver: "user",
    });
    await recordMainUsage(cwd, {
      role: "assistant",
      responseId: "summary-usage-1",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 3,
        reasoningTokens: 4,
        cost: { total: 0.0123 },
      },
    });

    const summary = await buildRoadmapDetailSummary(cwd);
    expect(summary.kind).toBe("active");
    if (summary.kind !== "active") throw new Error("Expected active summary");

    expect(summary.roadmap).toMatchObject({
      id: "summary-roadmap",
      title: "Summary Roadmap",
      phase: "implementing",
      label: "summary-roadmap (Summary Roadmap)",
    });
    expect(summary.active.milestone?.label).toBe("m01-core - Core milestone (milestone_approved)");
    expect(summary.active.changeRequest).toBeNull();
    expect(summary.bypass).toMatchObject({
      active: true,
      label: "User approved temporary UI contract review bypass.",
      requestedBy: "user",
    });
    expect(summary.validation.status).toBe("invalid");
    expect(summary.validation.errors.map((issue) => issue.code)).toContain("blockers.blocking.open");
    expect(summary.gate.status).toBe("closed");
    expect(summary.gate.warnings.map((issue) => issue.code)).toContain("bypass.active");
    expect(summary.qualityGate.status).toBe("passed");
    expect(summary.nextAction).toMatch(/^Resolve or defer blocking blockers: blk_[^:]+: Blocking note$/);
    expect(summary.waves).toMatchObject({
      total: 1,
      counts: { blocked: 1 },
      active: {
        id: "w01",
        status: "blocked",
        label: "w01 (blocked)",
      },
    });
    expect(summary.activeTasks).toEqual([
      {
        id: "t01-state",
        worker: "worker-light",
        status: "blocked",
        title: "State task",
        label: "worker-light blocked: State task",
      },
    ]);
    expect(summary.blockers.map((blocker) => blocker.label.replace(/blk_[^ ]+/, "blk_id"))).toEqual([
      "Open blocking blocker blk_id",
      "Progress blocker",
      "Blocked wave w01",
      "Blocked task t01-state",
    ]);
    expect(summary.usage?.roadmap.label).toBe("$0.0123, 1 req, 20 tok, in 10, out 5, cache 2/3, reasoning 4");
    expect(summary.usage?.topAgents[0]?.label).toContain("implementation_orchestrator");
    expect(summary.usage?.milestone?.id).toBe("m01-core");
  });
});
