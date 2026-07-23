import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadState, resolveBlocker, transition } from "@oh-my-roadmap/core/store/index";
import {
  prepareWaveDispatch,
  prepareWaveReview,
  recordReviewerDispatch,
  recordWaveResult,
  recordWaveReview,
  recordWorkerDispatch,
} from "@oh-my-roadmap/core/wave-orchestration/index";
import { approvedMilestone, createTempRoadmapCwd, removeTempRoadmapCwd } from "./helpers";

let cwd = "";

beforeEach(async () => {
  cwd = await createTempRoadmapCwd();
});

afterEach(async () => {
  await removeTempRoadmapCwd(cwd);
  cwd = "";
});

// Drives w01 to the point where every task is done and the wave is reviewable.
async function reviewableWave(): Promise<void> {
  await approvedMilestone(cwd);
  await transition(cwd, { operation: "start_implementation" });
  await prepareWaveDispatch(cwd);
  await recordWorkerDispatch(cwd, {
    taskId: "t01-state",
    agentId: "agent-store",
    jobId: "job-store",
  });
  await recordWaveResult(cwd, {
    taskId: "t01-state",
    status: "completed",
    summary: "State task completed.",
  });
}

describe("reviewer runs", () => {
  test("recordReviewerDispatch persists an active reviewer run that survives an update_implementation_progress transition", async () => {
    await approvedMilestone(cwd);
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);

    const dispatch = await recordReviewerDispatch(cwd, {
      agentId: "agent-rev-1",
      jobId: "job-rev-1",
    });
    expect(dispatch).toMatchObject({
      wave_id: "w01",
      run: { wave_id: "w01", agent_id: "agent-rev-1", job_id: "job-rev-1", status: "active" },
    });

    let state = await loadState(cwd);
    expect(state.milestone?.progress.reviewer_runs).toHaveLength(1);

    // Regression guard for the persistence contract: an unrelated progress transition must
    // NOT wipe reviewer_runs (the same treatment worker_runs already gets).
    await transition(cwd, {
      operation: "update_implementation_progress",
      progress: { step: "workers_running", activeTaskIds: [] },
    });

    state = await loadState(cwd);
    expect(state.milestone?.progress.reviewer_runs).toHaveLength(1);
    expect(state.milestone?.progress.reviewer_runs[0]).toMatchObject({
      wave_id: "w01",
      agent_id: "agent-rev-1",
      job_id: "job-rev-1",
      status: "active",
    });
    // worker_runs semantics are untouched.
    expect(state.milestone?.progress.worker_runs).toEqual([]);
  });

  test("first prepareWaveReview on a wave reports re_review false with no prior fields", async () => {
    await reviewableWave();

    const review = await prepareWaveReview(cwd);
    expect(review.re_review).toBe(false);
    expect(review.prior_reviewer_agent_id).toBeUndefined();
    expect(review.prior_findings).toBeUndefined();
  });

  test("prepareWaveReview reports re_review with the prior reviewer and findings after a failed review", async () => {
    await reviewableWave();

    // Orchestrator spawns the reviewer and records its durable identity.
    await recordReviewerDispatch(cwd, { agentId: "agent-rev-1", jobId: "job-rev-1" });

    const first = await prepareWaveReview(cwd);
    expect(first.re_review).toBe(false);

    const failed = await recordWaveReview(cwd, {
      status: "failed",
      summary: "Wave failed review.",
      findings: ["Missing null check in store.ts", "Test coverage gap for lifecycle"],
    });
    expect(failed.wave_status).toBe("blocked");
    expect(failed.blockers.length).toBeGreaterThan(0);

    // Workers fix the findings and the blockers are resolved, then the wave re-enters review.
    for (const blocker of failed.blockers) {
      await resolveBlocker(cwd, { blockerId: blocker.id, resolution: "Fixed during re-work." });
    }
    await transition(cwd, {
      operation: "update_wave_status",
      waveId: "w01",
      waveStatus: "reviewing",
    });

    const second = await prepareWaveReview(cwd);
    expect(second.re_review).toBe(true);
    expect(second.prior_reviewer_agent_id).toBe("agent-rev-1");
    expect(second.prior_findings).toEqual([
      "Missing null check in store.ts",
      "Test coverage gap for lifecycle",
    ]);
  });
});
