import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { roadmapsDir } from "@oh-my-roadmap/core/paths";
import { readYamlFile, writeYamlFile } from "@oh-my-roadmap/core/files";
import {
  applyRaiseCeiling,
  grantOneShotContinue,
  hasAvailableOneShot,
} from "@oh-my-roadmap/core/budget";
import type { BudgetScopeState } from "@oh-my-roadmap/core/budget";
import { ensureConfig } from "@oh-my-roadmap/core/project-init";
import type { BudgetThresholdPolicy } from "@oh-my-roadmap/core/project-init";
import { emptyUsageTotals, writeUsageSummary } from "@oh-my-roadmap/core/usage";
import type { RoadmapUsageSummary, UsageTotals } from "@oh-my-roadmap/core/usage";
import {
  loadMilestoneBudgetState,
  loadRoadmapBudgetState,
  loadState,
  transition,
  writeMilestoneBudgetState,
  writeRoadmapBudgetState,
} from "@oh-my-roadmap/core/store/index";
import {
  prepareWaveDispatch,
  prepareWaveReview,
  prepareWorkerRedispatch,
  recordWorkerDispatch,
  recordWorkerTransportFailed,
  recordWaveResult,
} from "@oh-my-roadmap/core/wave-orchestration/index";
import { approvedMilestone } from "./state/helpers";

const ROADMAP_ID = "complex-refactor";
const MILESTONE_ID = "m01-core";

let cwd = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-budget-dispatch-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

// --- helpers ---

function usageTotals(tokens: number): UsageTotals {
  return { ...emptyUsageTotals(), input_tokens: tokens };
}

function budgetWithCeilings(ceilings: {
  tokens?: number;
  cost?: number;
  time?: number;
}): BudgetScopeState {
  return { ceilings, overrides: [], time_tracking: { accumulated_ms: 0 } };
}

function makeUsage(roadmapTokens: number, milestoneTokens: number): RoadmapUsageSummary {
  return {
    roadmap_id: ROADMAP_ID,
    total: usageTotals(roadmapTokens),
    by_agent: {},
    dedupe_keys: [],
    milestones: {
      [MILESTONE_ID]: {
        total: usageTotals(milestoneTokens),
        by_agent: {},
        change_requests: {},
      },
    },
  };
}

async function setThresholds(thresholds: BudgetThresholdPolicy): Promise<void> {
  await ensureConfig(cwd);
  const configPath = path.join(roadmapsDir(cwd), "config.yml");
  const raw = await readYamlFile<Record<string, unknown>>(configPath);
  raw.budgets = { thresholds };
  await writeYamlFile(configPath, raw);
}

async function setup(): Promise<void> {
  await approvedMilestone(cwd);
  await transition(cwd, { operation: "start_implementation" });
}

async function loadProgress() {
  const state = await loadState(cwd);
  const plan = state.milestone ?? state.changeRequest ?? state.adhoc;
  if (!plan) throw new Error("No active plan");
  return plan.progress;
}

// --- tests ---

describe("budget enforcement in dispatch", () => {
  test("soft limit pauses prepareWaveDispatch at the wave boundary", async () => {
    await setup();
    await setThresholds({ warn: 75, soft: 90, hard: 100 });
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeMilestoneBudgetState(cwd, ROADMAP_ID, MILESTONE_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(0, 0));

    // First dispatch with no breach — starts the per-scope time clocks.
    await prepareWaveDispatch(cwd);

    // Now trigger a soft breach and re-dispatch — the clock is running,
    // so pauseBudgetTimeClocks stamps paused_at on both scopes.
    await writeUsageSummary(cwd, makeUsage(900, 0));
    await expect(prepareWaveDispatch(cwd)).rejects.toThrow("Budget soft limit");

    const progress = await loadProgress();
    expect(progress.step).toBe("resolving_blockers");
    expect(progress.blocked_reason).toMatch(/Budget soft limit/);

    // Time clock is paused on both scopes.
    const roadmapBudget = await loadRoadmapBudgetState(cwd, ROADMAP_ID);
    expect(roadmapBudget!.time_tracking.paused_at).toBeDefined();
    expect(roadmapBudget!.time_tracking.started_at).toBeUndefined();

    const milestoneBudget = await loadMilestoneBudgetState(cwd, ROADMAP_ID, MILESTONE_ID);
    expect(milestoneBudget!.time_tracking.paused_at).toBeDefined();
    expect(milestoneBudget!.time_tracking.started_at).toBeUndefined();
  });

  test("further dispatch is refused while paused on budget", async () => {
    await setup();
    await setThresholds({ warn: 75, soft: 90, hard: 100 });
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(900, 0));

    // First call — pauses.
    await expect(prepareWaveDispatch(cwd)).rejects.toThrow("Budget soft limit");

    // Second call — still paused, still breached, no one-shot.
    await expect(prepareWaveDispatch(cwd)).rejects.toThrow("paused on budget limit");
  });

  test("pause clears and clock resumes when ceiling is raised", async () => {
    await setup();
    await setThresholds({ warn: 75, soft: 90, hard: 100 });
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(900, 0));

    await expect(prepareWaveDispatch(cwd)).rejects.toThrow("Budget soft limit");

    // Raise the ceiling — soft breach is gone (900/2000 = 45%).
    const now = "2026-07-22T12:00:00.000Z";
    const raised = applyRaiseCeiling(
      (await loadRoadmapBudgetState(cwd, ROADMAP_ID)) ?? budgetWithCeilings({ tokens: 1000 }),
      "tokens",
      2000,
      "operator",
      "raise ceiling",
      now,
    );
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, raised);

    const result = await prepareWaveDispatch(cwd);
    expect(result.progress_step).toBe("dispatching");

    const progress = await loadProgress();
    expect(progress.step).toBe("dispatching");
    expect(progress.blocked_reason).toBeUndefined();

    // Time clock resumed.
    const roadmapBudget = await loadRoadmapBudgetState(cwd, ROADMAP_ID);
    expect(roadmapBudget!.time_tracking.started_at).toBeDefined();
    expect(roadmapBudget!.time_tracking.paused_at).toBeUndefined();
  });

  test("pause clears and clock resumes when one-shot is granted", async () => {
    await setup();
    await setThresholds({ warn: 75, soft: 90, hard: 100 });
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(900, 0));

    await expect(prepareWaveDispatch(cwd)).rejects.toThrow("Budget soft limit");

    // Grant a one-shot — soft breach is now resolvable.
    const now = "2026-07-22T12:00:00.000Z";
    const withOneShot = grantOneShotContinue(
      (await loadRoadmapBudgetState(cwd, ROADMAP_ID)) ?? budgetWithCeilings({ tokens: 1000 }),
      "operator",
      "continue",
      now,
    );
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, withOneShot);

    const result = await prepareWaveDispatch(cwd);
    expect(result.progress_step).toBe("dispatching");

    // Time clock resumed.
    const roadmapBudget = await loadRoadmapBudgetState(cwd, ROADMAP_ID);
    expect(roadmapBudget!.time_tracking.started_at).toBeDefined();
    expect(roadmapBudget!.time_tracking.paused_at).toBeUndefined();

    // One-shot NOT consumed for soft breach.
    expect(hasAvailableOneShot(roadmapBudget!)).toBe(true);
  });

  test("hard limit throws an actionable backstop", async () => {
    await setup();
    await setThresholds({ warn: 75, soft: 90, hard: 100 });
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(1000, 0));

    await expect(prepareWaveDispatch(cwd)).rejects.toThrow("Budget hard limit");

    // Hard backstop does NOT set resolving_blockers.
    const progress = await loadProgress();
    expect(progress.step).not.toBe("resolving_blockers");
  });

  test("one-shot allows exactly one new-wave dispatch then re-locks", async () => {
    await setup();
    await setThresholds({ warn: 75, soft: 90, hard: 100 });
    const now = "2026-07-22T12:00:00.000Z";
    const budget = grantOneShotContinue(
      budgetWithCeilings({ tokens: 1000 }),
      "operator",
      "continue",
      now,
    );
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budget);
    await writeUsageSummary(cwd, makeUsage(1000, 0));

    // First dispatch — one-shot consumed, dispatch proceeds.
    const result = await prepareWaveDispatch(cwd);
    expect(result.progress_step).toBe("dispatching");
    expect(result.assignments.length).toBe(1);

    const roadmapBudget = await loadRoadmapBudgetState(cwd, ROADMAP_ID);
    expect(hasAvailableOneShot(roadmapBudget!)).toBe(false);

    // Second dispatch — hard breach, one-shot consumed, re-locks.
    await expect(prepareWaveDispatch(cwd)).rejects.toThrow("Budget hard limit");
  });

  test("one-shot is not consumed when returning already-running workers", async () => {
    await setup();
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(0, 0));

    // First dispatch — no breach, workers start, time clock starts.
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, { taskId: "t01-state", agentId: "a1", jobId: "j1" });

    // Now set up a hard breach with a one-shot.
    const now = "2026-07-22T12:00:00.000Z";
    const budget = grantOneShotContinue(
      (await loadRoadmapBudgetState(cwd, ROADMAP_ID)) ?? budgetWithCeilings({ tokens: 1000 }),
      "operator",
      "continue",
      now,
    );
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budget);
    await writeUsageSummary(cwd, makeUsage(1000, 0));

    // Second dispatch — returns already-running workers (no new dispatch).
    const result = await prepareWaveDispatch(cwd);
    expect(result.assignments).toEqual([]);
    expect(result.active_runs.length).toBeGreaterThan(0);

    // One-shot should NOT be consumed.
    const roadmapBudget = await loadRoadmapBudgetState(cwd, ROADMAP_ID);
    expect(hasAvailableOneShot(roadmapBudget!)).toBe(true);
  });

  test("time clock starts at first dispatch per scope", async () => {
    await setup();
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeMilestoneBudgetState(cwd, ROADMAP_ID, MILESTONE_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(0, 0));

    // Before dispatch — clock not started.
    const beforeRoadmap = await loadRoadmapBudgetState(cwd, ROADMAP_ID);
    expect(beforeRoadmap!.time_tracking.started_at).toBeUndefined();

    await prepareWaveDispatch(cwd);

    // After dispatch — clock started on both scopes.
    const afterRoadmap = await loadRoadmapBudgetState(cwd, ROADMAP_ID);
    expect(afterRoadmap!.time_tracking.started_at).toBeDefined();
    expect(afterRoadmap!.time_tracking.paused_at).toBeUndefined();

    const afterMilestone = await loadMilestoneBudgetState(cwd, ROADMAP_ID, MILESTONE_ID);
    expect(afterMilestone!.time_tracking.started_at).toBeDefined();
    expect(afterMilestone!.time_tracking.paused_at).toBeUndefined();
  });

  test("time clock pauses on soft-pause and resumes on clear", async () => {
    await setup();
    await setThresholds({ warn: 75, soft: 90, hard: 100 });
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(0, 0));

    // First dispatch — clock starts.
    await prepareWaveDispatch(cwd);
    const afterStart = await loadRoadmapBudgetState(cwd, ROADMAP_ID);
    expect(afterStart!.time_tracking.started_at).toBeDefined();
    expect(afterStart!.time_tracking.paused_at).toBeUndefined();
    const startedAccumulated = afterStart!.time_tracking.accumulated_ms;

    // Trigger soft breach and re-dispatch — clock pauses.
    await writeUsageSummary(cwd, makeUsage(900, 0));
    await expect(prepareWaveDispatch(cwd)).rejects.toThrow("Budget soft limit");
    const afterPause = await loadRoadmapBudgetState(cwd, ROADMAP_ID);
    expect(afterPause!.time_tracking.paused_at).toBeDefined();
    expect(afterPause!.time_tracking.started_at).toBeUndefined();
    // accumulated_ms preserved (paused interval folded in).
    expect(afterPause!.time_tracking.accumulated_ms).toBeGreaterThanOrEqual(startedAccumulated);

    // Raise ceiling — clock resumes on re-dispatch.
    const now = "2026-07-22T12:00:00.000Z";
    const raised = applyRaiseCeiling(
      await loadRoadmapBudgetState(cwd, ROADMAP_ID) ?? budgetWithCeilings({ tokens: 1000 }),
      "tokens",
      2000,
      "operator",
      "raise ceiling",
      now,
    );
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, raised);
    await prepareWaveDispatch(cwd);
    const afterResume = await loadRoadmapBudgetState(cwd, ROADMAP_ID);
    expect(afterResume!.time_tracking.started_at).toBeDefined();
    expect(afterResume!.time_tracking.paused_at).toBeUndefined();
    // accumulated_ms preserved across pause/resume (no double-counting).
    expect(afterResume!.time_tracking.accumulated_ms).toBe(afterPause!.time_tracking.accumulated_ms);
  });

  test("prepareWaveReview is unaffected by budget checks", async () => {
    await setup();
    await setThresholds({ warn: 75, soft: 90, hard: 100 });
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(0, 0));

    // Dispatch, record worker, complete the task.
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, { taskId: "t01-state", agentId: "a1", jobId: "j1" });
    await recordWaveResult(cwd, { taskId: "t01-state", status: "completed", summary: "Done" });

    // Now set up a hard breach — prepareWaveReview must still proceed.
    await writeUsageSummary(cwd, makeUsage(1000, 0));

    const result = await prepareWaveReview(cwd);
    expect(result.wave_id).toBe("w01");
  });

  test("no budgets configured: dispatch behavior is unchanged", async () => {
    await setup();
    // No budget state, no usage, no config thresholds.

    const result = await prepareWaveDispatch(cwd);
    expect(result.progress_step).toBe("dispatching");
    expect(result.assignments.length).toBe(1);
    expect(result.assignments[0]!.task_id).toBe("t01-state");
  });

  test("prepareWorkerRedispatch pauses on soft breach", async () => {
    await setup();
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(0, 0));

    // Dispatch, record worker, transport fail.
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, { taskId: "t01-state", agentId: "a1", jobId: "j1" });
    await recordWorkerTransportFailed(cwd, {
      taskId: "t01-state",
      agentId: "a1",
      jobId: "j1",
      lastError: "transport failed",
    });

    // Now set up soft breach.
    await setThresholds({ warn: 75, soft: 90, hard: 100 });
    await writeUsageSummary(cwd, makeUsage(900, 0));

    // Redispatch should pause on soft breach.
    await expect(prepareWorkerRedispatch(cwd, { taskId: "t01-state" })).rejects.toThrow(
      "Budget soft limit",
    );

    const progress = await loadProgress();
    expect(progress.step).toBe("resolving_blockers");
    expect(progress.blocked_reason).toMatch(/Budget soft limit/);

    // Time clock paused.
    const roadmapBudget = await loadRoadmapBudgetState(cwd, ROADMAP_ID);
    expect(roadmapBudget!.time_tracking.paused_at).toBeDefined();
  });

  test("prepareWorkerRedispatch throws hard backstop with no one-shot", async () => {
    await setup();
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(0, 0));

    // Dispatch, record worker, transport fail.
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, { taskId: "t01-state", agentId: "a1", jobId: "j1" });
    await recordWorkerTransportFailed(cwd, {
      taskId: "t01-state",
      agentId: "a1",
      jobId: "j1",
      lastError: "transport failed",
    });

    // Now set up hard breach (default hard 100, no config needed).
    await writeUsageSummary(cwd, makeUsage(1000, 0));

    await expect(prepareWorkerRedispatch(cwd, { taskId: "t01-state" })).rejects.toThrow(
      "Budget hard limit",
    );

    // Hard backstop does NOT set resolving_blockers.
    const progress = await loadProgress();
    expect(progress.step).not.toBe("resolving_blockers");
  });
});
