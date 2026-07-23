import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { listBlockers, loadState, transition } from "@oh-my-roadmap/core/store/index";
import { ensureConfig } from "@oh-my-roadmap/core/project-init";
import { milestoneRuntimePath, roadmapsDir } from "@oh-my-roadmap/core/paths";
import { readYamlFile, writeYamlFile } from "@oh-my-roadmap/core/files";
import {
  prepareWaveDispatch,
  recordReviewerDispatch,
  recordWaveResult,
  recordWaveReview,
  recordWorkerDispatch,
} from "@oh-my-roadmap/core/wave-orchestration/index";
import type { RecordWaveReviewResult } from "@oh-my-roadmap/core/wave-orchestration/index";
import {
  approvedMilestone,
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

// Persist a custom orchestration.max_review_cycles into the project config so the cap threshold
// is exercised end-to-end from config (not a hardcoded constant).
async function setMaxReviewCycles(value: number): Promise<void> {
  await ensureConfig(cwd);
  const configPath = path.join(roadmapsDir(cwd), "config.yml");
  const raw = await readYamlFile<Record<string, any>>(configPath);
  raw.orchestration = {
    transport_resume_attempts: 3,
    git_checkpoints: false,
    max_review_cycles: value,
  };
  await writeYamlFile(configPath, raw);
}

// Read the persisted runtime progress directly (bypassing load-time normalization) so rework_queue
// persistence is asserted from the raw file, mirroring review-findings-pipeline.test.ts.
async function readRuntimeProgress(): Promise<Record<string, any>> {
  const runtime = await readYamlFile<Record<string, any>>(
    milestoneRuntimePath(cwd, "complex-refactor", "m01-core"),
  );
  return runtime.progress as Record<string, any>;
}

// Reach a wave whose single task is complete and awaiting review.
async function reachReviewReadyWave(): Promise<void> {
  await approvedMilestone(cwd);
  await transition(cwd, { operation: "start_implementation" });
  await prepareWaveDispatch(cwd);
  await recordWorkerDispatch(cwd, { taskId: "t01-state", agentId: "worker-1", jobId: "job-w1" });
  await recordWaveResult(cwd, {
    taskId: "t01-state",
    status: "completed",
    summary: "State task completed.",
  });
}

// Drive one failed review cycle: record the reviewer dispatch for this cycle (as the reviewer
// rework rule requires — reviewer_runs is the per-wave cycle counter), then record a failed
// worker-fixable review with the given finding text.
let reviewerCounter = 0;
async function failCycle(findingText: string): Promise<RecordWaveReviewResult> {
  reviewerCounter += 1;
  await recordReviewerDispatch(cwd, {
    agentId: `reviewer-${reviewerCounter}`,
    jobId: `job-r${reviewerCounter}`,
    ...(reviewerCounter > 1 ? { replacesAgentId: `reviewer-${reviewerCounter - 1}` } : {}),
  });
  return recordWaveReview(cwd, {
    status: "failed",
    summary: `Reviewer found a worker-fixable issue (cycle ${reviewerCounter}).`,
    structured_findings: [
      { severity: "blocking_worker_fixable", text: findingText, task_id: "t01-state" },
    ],
  });
}

beforeEach(() => {
  reviewerCounter = 0;
});

describe("R20 review-cycle cap", () => {
  test("default cap (2): first failure reworks, the second mints a needs-user blocker carrying the findings history", async () => {
    await reachReviewReadyWave();

    // Cycle 1 — below the cap: worker-fixable routing enqueues rework, no blocker.
    const first = await failCycle("Tighten the store lock error path.");
    expect(first.blockers).toEqual([]);
    expect(first.next_actions).toBeUndefined();
    let progress = await readRuntimeProgress();
    expect(progress.rework_queue).toHaveLength(1);

    // Cycle 2 — reaches the cap: no new rework round, one needs-user blocker instead.
    const second = await failCycle("Add a missing guard on reload.");

    // The rework queue did NOT grow — the second failed review refused further rework.
    progress = await readRuntimeProgress();
    expect(progress.rework_queue).toHaveLength(1);

    // Exactly one needs-user blocker minted, attributed honestly (not to 'user').
    expect(second.blockers).toHaveLength(1);
    const blocker = second.blockers[0]!;
    expect(blocker.severity).toBe("blocking");
    expect(blocker.created_by).toBe("orchestrator");
    expect(blocker.title).toBe("Wave w01 review failed");

    // The blocker body carries the accumulated findings history from BOTH cycles.
    expect(blocker.description).toContain("Tighten the store lock error path.");
    expect(blocker.description).toContain("Add a missing guard on reload.");
    expect(blocker.description).toContain("review-cycle cap of 2");

    // The halt is surfaced in next_actions.
    expect(second.next_actions).toBeDefined();
    expect(second.next_actions?.[0]?.tool.name).toBe("omr_list_blockers");

    // Wave is blocked and the canonical blocker is open.
    expect(second.wave_status).toBe("blocked");
    const open = await listBlockers(cwd, { waveId: "w01", status: "open" });
    expect(open.blockers).toHaveLength(1);
    const state = await loadState(cwd);
    expect(state.milestone?.waves.find((wave) => wave.id === "w01")?.status).toBe("blocked");
  });

  test("cap of 1 (from config): the very first failed review mints the needs-user blocker with no rework", async () => {
    await setMaxReviewCycles(1);
    await reachReviewReadyWave();

    const result = await failCycle("Only finding this run.");

    // No rework was enqueued at all.
    const progress = await readRuntimeProgress();
    expect(progress.rework_queue ?? []).toEqual([]);

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]!.description).toContain("Only finding this run.");
    expect(result.blockers[0]!.description).toContain("review-cycle cap of 1");
    expect(result.next_actions).toBeDefined();
  });

  test("cap of 3 (from config): the threshold moves — two rework rounds precede the cap on the third failure", async () => {
    await setMaxReviewCycles(3);
    await reachReviewReadyWave();

    const c1 = await failCycle("Finding one.");
    const c2 = await failCycle("Finding two.");
    // Cycles 1 and 2 route to rework; no needs-user blocker yet.
    expect(c1.blockers).toEqual([]);
    expect(c2.blockers).toEqual([]);
    let progress = await readRuntimeProgress();
    expect(progress.rework_queue).toHaveLength(2);

    // Cycle 3 hits the cap.
    const c3 = await failCycle("Finding three.");
    expect(c3.blockers).toHaveLength(1);
    // No third rework round.
    progress = await readRuntimeProgress();
    expect(progress.rework_queue).toHaveLength(2);

    // History accumulates all three cycles' findings.
    const description = c3.blockers[0]!.description;
    expect(description).toContain("Finding one.");
    expect(description).toContain("Finding two.");
    expect(description).toContain("Finding three.");
    expect(description).toContain("review-cycle cap of 3");
  });
});
