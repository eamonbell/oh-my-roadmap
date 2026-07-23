import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { validateMilestonePlan } from "@oh-my-roadmap/core/plan-validation";
import { shouldBlockToolCall } from "@oh-my-roadmap/core/gate";
import { milestoneNotesPath } from "@oh-my-roadmap/core/paths";
import { appendNote, initRoadmap, loadState, transition } from "@oh-my-roadmap/core/store/index";
import {
  prepareWaveDispatch,
  recordWaveResult,
  recordWaveReview,
  recordWorkerDispatch,
} from "@oh-my-roadmap/core/wave-orchestration/index";
import type { CreateMilestonePlanInput } from "@oh-my-roadmap/core/store/index";
import type { ValidationIssue } from "@oh-my-roadmap/core/types";
import {
  approvedMilestone,
  approvedRoadmap,
  createTempRoadmapCwd,
  milestoneInput,
  recordPassedWaveFlowCheck,
  removeTempRoadmapCwd,
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

// A milestone whose single wave holds two concurrently-running tasks, so same-wave rework
// authorization can be distinguished from an unrelated blocker in the same wave.
function twoTaskWaveMilestone(): CreateMilestonePlanInput {
  return {
    milestoneId: "m01-core",
    title: "Core milestone",
    verificationCommands: ["bun test"],
    acceptanceCriteria: ["Both tasks complete"],
    decisions: ["Run both store and report tasks in one wave."],
    dependencyAnalysis: ["The two tasks own disjoint files and can run concurrently."],
    tasks: [
      {
        id: "t01-state",
        title: "State engine",
        objective: "Persist roadmap state changes safely.",
        implementation_notes: ["Update state storage."],
        done_criteria: ["State lifecycle operations remain valid."],
        verification_commands: ["bun test"],
        worker: "worker-light",
        status: "assigned",
        depends_on: [],
        owned_files: ["src/core/store.ts"],
        owned_modules: [],
        shared_interfaces: ["RoadmapState"],
        relevant_existing_code: [],
        shared_interface_contracts: [],
      },
      {
        id: "t02-report",
        title: "Report engine",
        objective: "Render roadmap state.",
        implementation_notes: ["Update report output."],
        done_criteria: ["Reports show current milestone status."],
        verification_commands: ["bun test"],
        worker: "worker-light",
        status: "assigned",
        depends_on: [],
        owned_files: ["src/core/report.ts"],
        owned_modules: [],
        shared_interfaces: ["LoadedState"],
        relevant_existing_code: [],
        shared_interface_contracts: [],
      },
    ],
    waves: [
      {
        id: "w01",
        goal: "Implement state and reporting together.",
        exit_criteria: ["Both tasks complete."],
        review_checkpoint: "Review both outputs.",
        status: "pending",
        tasks: ["t01-state", "t02-report"],
      },
    ],
  };
}

describe("Code-review fixes", () => {
  // Fix 1 — decision-completeness is an approval gate; re-validating an already-approved
  // milestone (e.g. a roadmap planned before this rule) must not resurface the error.
  test("decision-completeness does not fire on an already-approved milestone plan", async () => {
    await approvedMilestone(cwd);
    const state = await loadState(cwd);
    const plan = state.milestone;
    expect(plan).toBeDefined();
    expect(plan!.approvals.length).toBeGreaterThan(0);

    // Simulate a pre-existing plan approved before decisions were required.
    const preExisting = { ...plan!, decisions: [], dependency_analysis: [] };
    const approvedErrors: ValidationIssue[] = [];
    validateMilestonePlan(preExisting, approvedErrors);
    const approvedCodes = approvedErrors.map((error) => error.code);
    expect(approvedCodes).not.toContain("plan.decisions.missing");
    expect(approvedCodes).not.toContain("plan.dependency_analysis.missing");

    // A not-yet-approved plan with the same gaps is still blocked before approval.
    const drafting = { ...preExisting, approvals: [] };
    const draftingErrors: ValidationIssue[] = [];
    validateMilestonePlan(drafting, draftingErrors);
    const draftingCodes = draftingErrors.map((error) => error.code);
    expect(draftingCodes).toContain("plan.decisions.missing");
    expect(draftingCodes).toContain("plan.dependency_analysis.missing");
  });

  // Fix 2 — wave-level rework authorization must not silence an unrelated task's blocker just
  // because a sibling worker is still running in the same wave.
  test("a running sibling worker does not open the write-gate for another task's blocker in the same wave", async () => {
    await approvedRoadmap(cwd);
    await transition(cwd, { operation: "start_milestone_planning" });
    await transition(cwd, { operation: "create_milestone_plan", milestone: twoTaskWaveMilestone() });
    await recordPassedWaveFlowCheck(cwd);
    await transition(cwd, { operation: "approve_milestone", approver: "user", summary: "ok" });
    await transition(cwd, { operation: "start_implementation" });

    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, { taskId: "t01-state", agentId: "a1", jobId: "j1" });
    await recordWorkerDispatch(cwd, { taskId: "t02-report", agentId: "a2", jobId: "j2" });

    // t02 reports a genuine blocker (task-scoped, wave_id=w01); t01 keeps running.
    await recordWaveResult(cwd, {
      taskId: "t02-report",
      status: "blocked",
      summary: "Blocked pending a decision.",
      blocker: { description: "Needs a user decision before proceeding." },
    });

    const state = await loadState(cwd);
    expect(state.milestone?.progress.worker_runs.find((run) => run.task_id === "t01-state")?.status).toBe("running");

    // t01 running must NOT authorize edits under t02's unrelated open blocker.
    const gate = await shouldBlockToolCall(cwd, "edit");
    expect(gate.block).toBe(true);
    expect(gate.reason).toContain("Open blocking blocker");
  });

  // Fix 4 — /omr:rm-new must never overwrite an existing roadmap directory (e.g. a just-archived
  // completed roadmap whose id is reused).
  test("initRoadmap rejects a roadmap id whose directory already exists", async () => {
    await initRoadmap(cwd, { roadmapId: "reused-id", title: "First" });
    await expect(initRoadmap(cwd, { roadmapId: "reused-id", title: "Second" })).rejects.toThrow(/already exists/);
  });

  // Fix 6 — reconcileTaskNotes must not corrupt a note whose body itself contains a "---\nkind:"
  // line: the reconciled note keeps its full body and no phantom note is fabricated.
  test("reconciling a stale issue note preserves a body that contains an embedded frontmatter fence", async () => {
    await approvedMilestone(cwd);
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, { taskId: "t01-state", agentId: "a1", jobId: "j1" });

    await appendNote(cwd, {
      kind: "issue",
      waveId: "w01",
      taskId: "t01-state",
      workerId: "stood-down-agent",
      status: "deferred",
      blocking: false,
      title: "Stale issue quoting note format",
      body: "Example note format:\n---\nkind: worker\nstatus: open\n---\nTrailing sentence after the fence.",
    });

    const state = await loadState(cwd);
    const roadmapId = state.active!.roadmap_id;
    const notesPath = milestoneNotesPath(cwd, roadmapId, "m01-core");
    const raw = await fs.readFile(notesPath, "utf8");

    // No corruption: the full body (including everything after the embedded fence) is preserved,
    // and the embedded "kind: worker" line was NOT promoted to a phantom note — the file still
    // holds exactly one real note boundary (a blank line before a "---\nkind:" fence). The old
    // split would have truncated the body and written a spurious note here.
    expect(raw).toContain("Trailing sentence after the fence.");
    expect((raw.match(/\n\n---\nkind:/g) ?? []).length).toBe(1);
  });

  // R6 — a passed wave review must auto-advance active_wave_id so the very next
  // prepareWaveDispatch call succeeds without an intervening update_implementation_progress
  // transition. Before this fix, recordWaveReview left active_wave_id pinned to the
  // now-complete wave, so the next prepareWaveDispatch always threw "already complete".
  test("recordWaveReview(passed) auto-advances progress so prepareWaveDispatch immediately dispatches the next wave", async () => {
    await approvedMilestone(cwd);
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, { taskId: "t01-state", agentId: "a1", jobId: "j1" });
    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "State task completed.",
    });

    const reviewResult = await recordWaveReview(cwd, {
      status: "passed",
      summary: "Wave implementation passed review.",
    });
    expect(reviewResult.wave_status).toBe("complete");
    expect(reviewResult.progress_step).toBe("not_started");

    const stateAfterReview = await loadState(cwd);
    expect(stateAfterReview.milestone?.progress).toMatchObject({
      active_wave_id: "w02",
      step: "not_started",
      active_task_ids: [],
    });

    // No intervening update_implementation_progress transition here: prepareWaveDispatch
    // must succeed immediately and dispatch the next wave's task, not throw.
    const dispatch = await prepareWaveDispatch(cwd);
    expect(dispatch.wave_id).toBe("w02");
    expect(dispatch.assignments.map((assignment) => assignment.task_id)).toEqual(["t02-report"]);
  });

  // R6 — passing the final wave must land progress directly on closeout_ready with no
  // further wave to advance into.
  test("recordWaveReview(passed) on the final wave advances progress straight to closeout_ready", async () => {
    await approvedRoadmap(cwd);
    await transition(cwd, { operation: "start_milestone_planning" });
    const input = milestoneInput();
    input.tasks = [{ ...input.tasks[0]! }];
    input.waves = [testWave("w01", ["t01-state"])];
    await transition(cwd, { operation: "create_milestone_plan", milestone: input });
    await recordPassedWaveFlowCheck(cwd);
    await transition(cwd, { operation: "approve_milestone", approver: "user", summary: "ok" });
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "State task completed.",
    });

    const reviewResult = await recordWaveReview(cwd, {
      status: "passed",
      summary: "Final wave passed review.",
    });
    expect(reviewResult.wave_status).toBe("complete");
    expect(reviewResult.progress_step).toBe("closeout_ready");

    const state = await loadState(cwd);
    expect(state.milestone?.progress.step).toBe("closeout_ready");
  });

  // R6 — the auto-advance guard: if the next wave is NOT pending (e.g. already blocked),
  // recordWaveReview(passed) must NOT advance into it. State stays authoritative on the
  // completed wave with step ready_for_next_wave, matching the pre-fix "none" branch.
  test("recordWaveReview(passed) does not auto-advance when the next wave is not pending", async () => {
    await approvedMilestone(cwd);
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, { taskId: "t01-state", agentId: "a1", jobId: "j1" });
    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "State task completed.",
    });
    // Force the next wave out of the 'pending' state so the advance guard falls to 'none'.
    await transition(cwd, {
      operation: "update_wave_status",
      waveId: "w02",
      waveStatus: "blocked",
    });

    const reviewResult = await recordWaveReview(cwd, {
      status: "passed",
      summary: "Wave implementation passed review.",
    });
    expect(reviewResult.wave_status).toBe("complete");
    expect(reviewResult.progress_step).toBe("ready_for_next_wave");
    expect(reviewResult.next_actions).toBeUndefined();

    const state = await loadState(cwd);
    expect(state.milestone?.progress).toMatchObject({
      active_wave_id: "w01",
      step: "ready_for_next_wave",
    });
  });
});
