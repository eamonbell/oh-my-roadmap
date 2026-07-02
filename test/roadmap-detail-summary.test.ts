import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { renderReport } from "@oh-my-roadmap/core/report/index";
import { applyRoadmapDetailControl, buildRoadmapDetailSummary, NO_ACTIVE_ROADMAP_MESSAGE } from "@oh-my-roadmap/core/roadmap-detail-summary/index";
import {
  appendNote,
  initRoadmap,
  transition,
  updateRoadmap,
  type CreateMilestonePlanInput,
} from "@oh-my-roadmap/core/store/index";
import { recordMainUsage } from "@oh-my-roadmap/core/usage";

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
    decisions: ["Derive the summary outside renderReport."],
    dependencyAnalysis: ["Single task; no inter-task dependencies."],
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
      {
        id: "m02-followup",
        title: "Follow-up milestone",
        status: "planned",
        goal: "Exercise outline-only milestone display.",
        scope: ["Show roadmap milestone without a plan file."],
        non_goals: ["Do not create a second milestone plan."],
        evidence: ["The detail summary marks this milestone outline-only."],
        dependencies: ["m01-core"],
        risks: ["Outline-only milestones could be mistaken for missing data."],
        acceptance_intent: ["Summary includes every roadmap milestone."],
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
    expect(summary.roadmapHealth).toMatchObject({
      status: "blocked",
      activePhase: "implementing",
      validationStatus: "invalid",
      implementationGateStatus: "closed",
      qualityGateStatus: "passed",
      openBlockerCount: 1,
    });
    expect(summary.nextAction.description).toMatch(/^Resolve or defer blocking blockers: blk_[^:]+: Blocking note$/);
    expect(summary.nextAction.status).toBe("blocked");
    expect(summary.nextCommand.command).toBe("/omr:blk-list");
    expect(summary.waves).toMatchObject({
      total: 1,
      counts: { blocked: 1 },
      active: {
        id: "w01",
        status: "blocked",
        label: "w01 (blocked)",
      },
    });
    expect(summary.activeExecution).toMatchObject({
      progressStep: "resolving_blockers",
      activeWave: { id: "w01" },
      taskCounts: { assigned: 0, started: 0, done: 0, blocked: 1 },
    });
    expect(summary.activeTasks).toEqual([
      {
        id: "t01-state",
        worker: "worker-light",
        status: "blocked",
        title: "State task",
        label: "t01-state [blocked, worker-light] State task",
      },
    ]);
    expect(summary.milestones).toHaveLength(2);
    expect(summary.milestones[0]).toMatchObject({
      id: "m01-core",
      detail: "plan",
      waves: [
        {
          id: "w01",
          tasks: [
            {
              id: "t01-state",
              status: "blocked",
              worker: "worker-light",
              title: "State task",
            },
          ],
        },
      ],
    });
    expect(summary.milestones[1]).toMatchObject({
      id: "m02-followup",
      detail: "outline",
      waves: [],
    });
    expect(summary.blockers.map((blocker) => blocker.label.replace(/blk_[^ ]+/, "blk_id"))).toEqual([
      "Open blocking blocker blk_id",
      "Progress blocker",
      "Blocked wave w01",
      "Blocked task t01-state",
    ]);
    expect(summary.canonicalBlockers.counts).toMatchObject({ open: 1, resolved: 0, deferred: 0 });
    expect(summary.canonicalBlockers.open[0]).toMatchObject({
      severity: "blocking",
      status: "open",
      title: "Blocking note",
      scope: {
        roadmapId: "summary-roadmap",
        milestoneId: "m01-core",
      },
    });
    expect(summary.qualityGate.history).toEqual([
      expect.objectContaining({
        type: "quality_gate.recorded",
        summary: "Roadmap milestone check recorded as passed.",
      }),
    ]);
    expect(summary.recentEvents.map((event) => event.type)).toContain("blocker.opened");
    expect(summary.availableControls.find((control) => control.key === "a")).toMatchObject({
      label: "Apply safe next action",
      enabled: false,
      tool: {
        name: "omr_apply_next_action",
      },
    });
    expect(summary.availableControls.find((control) => control.key === "d")).toMatchObject({
      label: "Prepare wave dispatch",
      enabled: false,
    });
    expect(summary.availableControls.find((control) => control.key === "b")?.prompt).toContain("omr_resolve_blocker");
    expect(summary.availableControls.find((control) => control.key === "b")?.prompt).toContain("omr_defer_blocker");
    expect(summary.usage?.roadmap.label).toBe("$0.0123, 1 req, 20 tok, in 10, out 5, cache 2/3, reasoning 4");
    expect(summary.usage?.topAgents[0]?.label).toContain("implementation_orchestrator");
    expect(summary.usage?.milestone?.id).toBe("m01-core");
  });

  test("applies only enabled safe next-action controls", async () => {
    await initRoadmap(cwd, { roadmapId: "control-roadmap", title: "Control Roadmap" });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: { findings: ["Inspected control flow."] },
    });
    await updateRoadmap(cwd, {
      goal: "Apply safe controls.",
      successCriteria: ["The dashboard applies the same safe next action helper."],
      constraints: ["Unsafe actions remain prompts."],
      nonGoals: ["Do not spawn workers from the dashboard."],
      context: ["applyNextAction owns safe transition checks."],
      evidence: ["The control descriptor includes omr_apply_next_action."],
      risks: ["A stale action id must not be applied."],
      milestones: [
        {
          id: "m01-core",
          title: "Core milestone",
          status: "planned",
          goal: "Exercise safe controls.",
          scope: ["Start milestone planning."],
          non_goals: ["Do not plan implementation."],
          evidence: ["The roadmap is approved before applying the control."],
          dependencies: [],
          risks: ["Control execution could bypass nextActionPlan."],
          acceptance_intent: ["Phase advances through applyRoadmapDetailControl."],
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

    const before = await buildRoadmapDetailSummary(cwd);
    expect(before.kind).toBe("active");
    if (before.kind !== "active") throw new Error("Expected active summary");
    expect(before.roadmap.phase).toBe("roadmap_approved");
    expect(before.gate.status).toBe("closed");
    expect(before.gate.issues).toEqual([]);
    expect(before.roadmapHealth).toMatchObject({
      status: "healthy",
      implementationGateStatus: "closed",
    });
    expect(before.availableControls.find((control) => control.key === "a")).toMatchObject({
      enabled: true,
      tool: {
        name: "omr_apply_next_action",
        input: { actionId: before.nextAction.id },
      },
    });
    expect(before.nextCommand).toMatchObject({
      command: "/omr:ms-plan",
      label: "/omr:ms-plan - Start milestone planning",
    });
    expect(before.availableControls.find((control) => control.key === "d")).toMatchObject({
      enabled: false,
      reason: "No dispatchable active wave",
    });

    const result = await applyRoadmapDetailControl(cwd, "a");
    expect(result.action).toBe("applied_next_action");
    if (result.action !== "applied_next_action") throw new Error("Expected applied control");
    expect(result.result.plan.id).toBe(before.nextAction.id);

    const after = await buildRoadmapDetailSummary(cwd);
    expect(after.kind).toBe("active");
    if (after.kind !== "active") throw new Error("Expected active summary");
    expect(after.roadmap.phase).toBe("milestone_planning");
    expect(after.gate.status).toBe("closed");
    expect(after.gate.issues).toEqual([]);
    expect(after.roadmapHealth).toMatchObject({
      status: "healthy",
      implementationGateStatus: "closed",
    });
    await expect(applyRoadmapDetailControl(cwd, "a")).rejects.toThrow("disabled");

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
    const approval = await buildRoadmapDetailSummary(cwd);
    expect(approval.kind).toBe("active");
    if (approval.kind !== "active") throw new Error("Expected active summary");
    expect(approval.nextAction.status).toBe("approval_required");
    expect(approval.nextCommand.command).toBe("/omr:ms-plan");
    expect(approval.gate.status).toBe("closed");
    expect(approval.gate.issues).toEqual([]);
    expect(approval.roadmapHealth).toMatchObject({
      status: "healthy",
      implementationGateStatus: "closed",
    });
    expect(approval.availableControls.find((control) => control.key === "p")).toMatchObject({
      enabled: true,
      action: "insert_prompt",
    });
    const prompt = await applyRoadmapDetailControl(cwd, "p");
    expect(prompt.action).toBe("insert_prompt");
    if (prompt.action !== "insert_prompt") throw new Error("Expected prompt control");
    expect(prompt.prompt).toContain("Ask the user for explicit approval");
  });

  test("enables wave dispatch only before a wave has been dispatched", async () => {
    await approvedMilestone();

    const approved = await buildRoadmapDetailSummary(cwd);
    expect(approved.kind).toBe("active");
    if (approved.kind !== "active") throw new Error("Expected active summary");
    expect(approved.roadmap.phase).toBe("milestone_approved");
    expect(approved.nextAction.id).toBe("milestone:m01-core:start-implementation");
    expect(approved.gate.status).toBe("closed");
    expect(approved.gate.issues).toEqual([]);
    expect(approved.roadmapHealth).toMatchObject({
      status: "healthy",
      implementationGateStatus: "closed",
    });

    await transition(cwd, { operation: "start_implementation" });

    const ready = await buildRoadmapDetailSummary(cwd);
    expect(ready.kind).toBe("active");
    if (ready.kind !== "active") throw new Error("Expected active summary");
    expect(ready.activeExecution?.progressStep).toBe("not_started");
    expect(ready.availableControls.find((control) => control.key === "d")).toMatchObject({
      enabled: true,
      tool: {
        name: "omr_prepare_wave_dispatch",
        input: { roadmapId: "summary-roadmap", milestoneId: "m01-core" },
      },
    });

    await transition(cwd, {
      operation: "update_implementation_progress",
      progress: {
        activeWaveId: "w01",
        step: "workers_running",
        activeTaskIds: ["t01-state"],
      },
    });

    const running = await buildRoadmapDetailSummary(cwd);
    expect(running.kind).toBe("active");
    if (running.kind !== "active") throw new Error("Expected active summary");
    expect(running.activeExecution?.progressStep).toBe("workers_running");
    expect(running.availableControls.find((control) => control.key === "d")).toMatchObject({
      enabled: false,
      reason: "No dispatchable active wave",
    });
  });
});
