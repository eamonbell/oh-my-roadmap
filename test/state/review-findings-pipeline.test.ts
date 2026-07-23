import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendNote, listBlockers, loadState, transition } from "@oh-my-roadmap/core/store/index";
import { milestoneRuntimePath } from "@oh-my-roadmap/core/paths";
import { readYamlFile, writeYamlFile } from "@oh-my-roadmap/core/files";
import {
  prepareWaveDispatch,
  prepareWaveReview,
  recordVerificationBaseline,
  recordWaveResult,
  recordWaveReview,
  recordWorkerDispatch,
} from "@oh-my-roadmap/core/wave-orchestration/index";
import {
  approvedMilestone as approvedMilestoneForCwd,
  createTempRoadmapCwd,
  removeTempRoadmapCwd,
} from "./helpers";

let cwd = "";

beforeEach(async () => {
  cwd = await createTempRoadmapCwd();
});

afterEach(async () => {
  await removeTempRoadmapCwd(cwd);
  cwd = "";
});

// Read the persisted runtime directly, bypassing normalizeProgress on load. rework_queue is
// written to the runtime YAML by recordWaveReview; asserting on the raw file verifies persistence
// of the queued items' fields regardless of how the load-time normalizer treats the field.
async function readRuntimeProgress(): Promise<Record<string, any>> {
  const runtime = await readYamlFile<Record<string, any>>(
    milestoneRuntimePath(cwd, "complex-refactor", "m01-core"),
  );
  return runtime.progress as Record<string, any>;
}

async function reachReviewReadyWave(): Promise<void> {
  await approvedMilestoneForCwd(cwd);
  await transition(cwd, { operation: "start_implementation" });
  await prepareWaveDispatch(cwd);
  await recordWaveResult(cwd, {
    taskId: "t01-state",
    status: "completed",
    summary: "State task completed.",
  });
  await prepareWaveReview(cwd);
}

describe("R1 review-finding severity routing", () => {
  test("all blocking_worker_fixable findings queue rework items and open no canonical blockers", async () => {
    await reachReviewReadyWave();

    const result = await recordWaveReview(cwd, {
      status: "failed",
      summary: "Reviewer found worker-fixable issues.",
      structured_findings: [
        { severity: "blocking_worker_fixable", text: "Tighten the store lock error path.", task_id: "t01-state" },
        { severity: "blocking_worker_fixable", text: "Add a missing guard on reload.", task_id: "t01-state" },
      ],
    });

    // No canonical blockers minted for worker-fixable findings.
    expect(result.blockers).toEqual([]);
    expect(result.wave_status).toBe("blocked");
    expect(result.progress_step).toBe("resolving_blockers");

    const openBlockers = await listBlockers(cwd, { waveId: "w01", status: "open" });
    expect(openBlockers.blockers).toHaveLength(0);

    // Two pending rework items persisted with the correct fields.
    const progress = await readRuntimeProgress();
    expect(progress.rework_queue).toHaveLength(2);
    for (const item of progress.rework_queue) {
      expect(item).toMatchObject({
        task_id: "t01-state",
        wave_id: "w01",
        source_finding_severity: "blocking_worker_fixable",
        status: "pending",
        created_by: "reviewer",
      });
      expect(typeof item.id).toBe("string");
      expect(item.id.startsWith("rework_")).toBe(true);
      expect(typeof item.created_at).toBe("string");
    }
    expect(progress.rework_queue.map((item: any) => item.finding_text)).toEqual([
      "Tighten the store lock error path.",
      "Add a missing guard on reload.",
    ]);

    // Wave is blocked and progress is resolving_blockers with the summary as blocked_reason.
    const state = await loadState(cwd);
    expect(state.milestone?.waves.find((wave) => wave.id === "w01")?.status).toBe("blocked");
    expect(state.milestone?.progress).toMatchObject({
      step: "resolving_blockers",
      blocked_reason: "Reviewer found worker-fixable issues.",
    });
  });

  test("worker-fixable finding without a task_id falls back to the wave's single active task", async () => {
    await reachReviewReadyWave();

    await recordWaveReview(cwd, {
      status: "failed",
      summary: "Worker-fixable, no task id supplied.",
      structured_findings: [{ severity: "blocking_worker_fixable", text: "Fix the thing." }],
    });

    const progress = await readRuntimeProgress();
    expect(progress.rework_queue).toHaveLength(1);
    // Single-task wave: the item is stamped with that task's id.
    expect(progress.rework_queue[0]).toMatchObject({ task_id: "t01-state", wave_id: "w01" });
  });

  test("a blocking_needs_user finding opens exactly one canonical blocker and queues no rework", async () => {
    await reachReviewReadyWave();

    const result = await recordWaveReview(cwd, {
      status: "failed",
      summary: "Reviewer needs a user decision.",
      structured_findings: [
        { severity: "blocking_needs_user", text: "Ownership boundary needs a product decision.", task_id: "t01-state" },
      ],
    });

    expect(result.blockers).toMatchObject([
      {
        title: "Wave w01 review failed",
        description: "Ownership boundary needs a product decision.",
        wave_id: "w01",
        task_id: "t01-state",
        severity: "blocking",
        created_by: "reviewer",
      },
    ]);
    expect(result.wave_status).toBe("blocked");

    const openBlockers = await listBlockers(cwd, { waveId: "w01", status: "open" });
    expect(openBlockers.blockers).toHaveLength(1);

    // No rework items queued for a needs-user finding.
    const progress = await readRuntimeProgress();
    expect(progress.rework_queue ?? []).toEqual([]);
  });

  test("mixed findings route needs-user to blockers and worker-fixable to rework, dropping pass/advisory", async () => {
    await reachReviewReadyWave();

    const result = await recordWaveReview(cwd, {
      status: "failed",
      summary: "Mixed findings.",
      structured_findings: [
        { severity: "pass", text: "Existing behavior still works." },
        { severity: "advisory", text: "Consider a follow-up doc." },
        { severity: "blocking_worker_fixable", text: "Rename the unclear helper.", task_id: "t01-state" },
        { severity: "blocking_needs_user", text: "Scope change requires approval.", task_id: "t01-state" },
      ],
    });

    // Exactly one needs-user blocker; pass/advisory contributed nothing.
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toMatchObject({ description: "Scope change requires approval." });

    const progress = await readRuntimeProgress();
    expect(progress.rework_queue).toHaveLength(1);
    expect(progress.rework_queue[0]).toMatchObject({
      finding_text: "Rename the unclear helper.",
      source_finding_severity: "blocking_worker_fixable",
    });
  });

  test("a failed review whose findings are all pass/advisory still blocks the wave and queues nothing", async () => {
    await reachReviewReadyWave();

    const result = await recordWaveReview(cwd, {
      status: "failed",
      summary: "Nothing actionable, but not a pass.",
      structured_findings: [
        { severity: "pass", text: "Looks fine." },
        { severity: "advisory", text: "Minor nit." },
      ],
    });

    expect(result.blockers).toEqual([]);
    expect(result.wave_status).toBe("blocked");
    expect(result.progress_step).toBe("resolving_blockers");

    const openBlockers = await listBlockers(cwd, { waveId: "w01", status: "open" });
    expect(openBlockers.blockers).toHaveLength(0);

    const progress = await readRuntimeProgress();
    expect(progress.rework_queue ?? []).toEqual([]);
    // The wave did not advance.
    const state = await loadState(cwd);
    expect(state.milestone?.waves.find((wave) => wave.id === "w01")?.status).toBe("blocked");
  });
});

describe("back-compat: string findings still mint blockers", () => {
  test("a failed review with only findings[] mints blocking blockers as before", async () => {
    await reachReviewReadyWave();

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
          severity: "blocking",
          created_by: "reviewer",
        },
      ],
    });

    // No rework queue is touched on the legacy path.
    const progress = await readRuntimeProgress();
    expect(progress.rework_queue ?? []).toEqual([]);

    const openBlockers = await listBlockers(cwd, { waveId: "w01", status: "open" });
    expect(openBlockers.blockers).toHaveLength(1);
  });
});

describe("prepareWaveReview reviewer package (R4/R3)", () => {
  test("surfaces a captured verification_baseline", async () => {
    await approvedMilestoneForCwd(cwd);
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordVerificationBaseline(cwd, {
      capturedBy: "orchestrator",
      commandResults: [
        { command: "bun test", exit_status: 1, failing_tests: ["pre-existing.spec"], failure_count: 1 },
      ],
    });
    await recordWaveResult(cwd, { taskId: "t01-state", status: "completed", summary: "done" });

    const review = await prepareWaveReview(cwd);
    expect(review.verification_baseline).toBeDefined();
    expect(review.verification_baseline).toMatchObject({
      captured_by: "orchestrator",
      command_results: [
        { command: "bun test", failure_count: 1, failing_tests: ["pre-existing.spec"] },
      ],
    });
  });

  test("surfaces pending rework_queue items for the active wave", async () => {
    await approvedMilestoneForCwd(cwd);
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWaveResult(cwd, { taskId: "t01-state", status: "completed", summary: "done" });

    // Seed a pending rework item (and one already-resolved item, plus one for another wave) into
    // the persisted progress, then confirm prepareWaveReview surfaces only the active-wave pending
    // item.
    const runtimePath = milestoneRuntimePath(cwd, "complex-refactor", "m01-core");
    const runtime = await readYamlFile<Record<string, any>>(runtimePath);
    runtime.progress.rework_queue = [
      {
        id: "rework_pending",
        task_id: "t01-state",
        wave_id: "w01",
        finding_text: "Fix the store lock.",
        source_finding_severity: "blocking_worker_fixable",
        status: "pending",
        created_at: new Date().toISOString(),
        created_by: "reviewer",
      },
      {
        id: "rework_resolved",
        task_id: "t01-state",
        wave_id: "w01",
        finding_text: "Already handled.",
        source_finding_severity: "blocking_worker_fixable",
        status: "resolved",
        created_at: new Date().toISOString(),
        created_by: "reviewer",
      },
      {
        id: "rework_other_wave",
        task_id: "t02-report",
        wave_id: "w02",
        finding_text: "Different wave.",
        source_finding_severity: "blocking_worker_fixable",
        status: "pending",
        created_at: new Date().toISOString(),
        created_by: "reviewer",
      },
    ];
    await writeYamlFile(runtimePath, runtime);

    const review = await prepareWaveReview(cwd);
    expect(review.rework_queue).toBeDefined();
    expect(review.rework_queue).toHaveLength(1);
    expect(review.rework_queue?.[0]).toMatchObject({
      id: "rework_pending",
      wave_id: "w01",
      status: "pending",
      finding_text: "Fix the store lock.",
    });
  });

  test("parses worker command receipts from a 'Commands run:' marker in a worker note", async () => {
    await approvedMilestoneForCwd(cwd);
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, { taskId: "t01-state", agentId: "alice", jobId: "job-1" });
    await appendNote(cwd, {
      kind: "worker",
      waveId: "w01",
      taskId: "t01-state",
      workerId: "alice",
      status: "resolved",
      title: "State task result",
      body: [
        "Implemented the store lock.",
        "",
        "Commands run:",
        "- bun test",
        "- bun run check",
        "",
        "VERIFIED: node ./scripts/smoke.mjs",
      ].join("\n"),
    });
    await recordWaveResult(cwd, { taskId: "t01-state", status: "completed", summary: "done" });

    const review = await prepareWaveReview(cwd);
    expect(review.worker_command_receipts).toBeDefined();
    expect(review.worker_command_receipts).toHaveLength(1);
    expect(review.worker_command_receipts?.[0]).toMatchObject({
      task_id: "t01-state",
      agent_id: "alice",
      commands: ["bun test", "bun run check", "node ./scripts/smoke.mjs"],
    });
  });

  test("omits worker_command_receipts when no note carries a command marker", async () => {
    await approvedMilestoneForCwd(cwd);
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await appendNote(cwd, {
      kind: "worker",
      waveId: "w01",
      taskId: "t01-state",
      workerId: "alice",
      status: "resolved",
      title: "State task result",
      body: "Implemented the store lock. No command list here.",
    });
    await recordWaveResult(cwd, { taskId: "t01-state", status: "completed", summary: "done" });

    const review = await prepareWaveReview(cwd);
    expect(review.worker_command_receipts).toBeUndefined();
  });
});
