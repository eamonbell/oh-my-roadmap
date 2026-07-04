import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { shouldBlockToolCall } from "@oh-my-roadmap/core/gate";
import { searchContext } from "@oh-my-roadmap/core/context";
import { appendNote, loadState, transition } from "@oh-my-roadmap/core/store/index";
import {
  prepareWaveDispatch,
  prepareWaveReview,
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

async function dispatchedWave(): Promise<void> {
  await approvedMilestoneForCwd(cwd);
  await transition(cwd, { operation: "start_implementation" });
  await prepareWaveDispatch(cwd);
  await recordWorkerDispatch(cwd, {
    taskId: "t01-state",
    agentId: "agent-store",
    jobId: "job-store",
  });
}

describe("Part 7 — operational gaps", () => {
  // 7a — durable result handoff: a completed worker whose peer is gone leaves its report in
  // its persisted note; record_wave_result sources the summary from that note.
  test("7a: record_wave_result sources its summary from the resolved worker note when no summary is supplied", async () => {
    await dispatchedWave();
    await appendNote(cwd, {
      kind: "worker",
      waveId: "w01",
      taskId: "t01-state",
      workerId: "worker-light",
      status: "resolved",
      title: "State task complete",
      body: "Implemented the store lock and ran bun test; all green.",
    });

    // The peer has terminated: the orchestrator passes no summary.
    const result = await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
    });

    expect(result.status).toBe("done");
    expect(result.summary).toBeDefined();
    expect(result.summary).toContain("Implemented the store lock");

    const state = await loadState(cwd);
    expect(state.milestone?.tasks.find((task) => task.id === "t01-state")?.status).toBe("done");
  });

  // 7b — edit-gate deadlock on rework: a rework worker assigned to fix the wave's open blocker
  // must be able to edit without first resolving that blocker.
  test("7b: the write-gate permits an assigned rework worker to edit its blocker's files without a prior resolve_blocker", async () => {
    await dispatchedWave();
    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "State task completed.",
    });
    await prepareWaveReview(cwd);
    // Review fails and opens an open blocking (wave-scoped) blocker for w01.
    const review = await recordWaveReview(cwd, {
      status: "failed",
      summary: "Rework needed on the store lock.",
      findings: ["The store lock is missing a nil check."],
    });
    expect(review.blockers.length).toBeGreaterThan(0);

    // Before a rework worker is dispatched, the open blocker deadlocks the edit gate.
    const beforeRework = await shouldBlockToolCall(cwd, "edit");
    expect(beforeRework.block).toBe(true);
    expect(beforeRework.reason).toContain("Open blocking blocker");

    // Dispatch the rework worker (a running run in the blocker's wave authorizes editing).
    await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store-rework",
      jobId: "job-store-rework",
    });

    const afterRework = await shouldBlockToolCall(cwd, "edit");
    expect(afterRework.block).toBe(false);

    // The blocker is still open — the gate authorized the edit without resolving it.
    const state = await loadState(cwd);
    expect(state.milestone?.waves.find((wave) => wave.id === "w01")?.status).toBe("blocked");
  });

  // 7c — stand-down / abandonment note hygiene: a stood-down worker's issue/deferred note must
  // not survive as a dangling issue once the task resolves via another worker.
  test("7c: a stood-down worker's issue/deferred note is reconciled once the task resolves", async () => {
    await dispatchedWave();
    await appendNote(cwd, {
      kind: "issue",
      waveId: "w01",
      taskId: "t01-state",
      workerId: "stood-down-agent",
      status: "deferred",
      blocking: false,
      title: "Deferred follow-up from a superseded run",
      body: "Left by a worker that was stood down before the task completed.",
    });

    const before = await searchContext(cwd, {
      artifacts: ["notes"],
      kinds: ["issue"],
      taskId: "t01-state",
      statuses: ["deferred"],
    });
    expect(before.results.length).toBe(1);

    // Another worker completes the task.
    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "State task completed by the replacement worker.",
    });

    // The dangling deferred issue no longer surfaces on the done task.
    const afterDeferred = await searchContext(cwd, {
      artifacts: ["notes"],
      kinds: ["issue"],
      taskId: "t01-state",
      statuses: ["deferred"],
    });
    expect(afterDeferred.results.length).toBe(0);

    // It was retracted (marked resolved), not deleted.
    const afterResolved = await searchContext(cwd, {
      artifacts: ["notes"],
      kinds: ["issue"],
      taskId: "t01-state",
      statuses: ["resolved"],
      includeBodies: true,
    });
    expect(afterResolved.results.length).toBe(1);
    expect(afterResolved.results[0]?.metadata?.reconciled).toBe(true);
  });
});
