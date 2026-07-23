import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  initRoadmap,
  loadRoadmapBlockers,
  loadState,
  openBlocker,
  resolveBlocker,
  transition,
} from "@oh-my-roadmap/core/store/index";
import { applyNextAction, nextActionPlan } from "@oh-my-roadmap/core/report/index";
// progressNextActionPlan is imported directly (rather than exercised only through
// nextActionPlan) for the rework case: normalizeProgress (store/format.ts, owned by a
// sibling task) does not yet round-trip progress.rework_queue, so a value written to the
// milestone runtime is stripped on load. Calling the pure progress planner with an
// in-memory-injected rework_queue tests this slice deterministically and independently of
// that sibling's persistence work.
import { progressNextActionPlan } from "@oh-my-roadmap/core/report/next-action";
import type { ImplementationProgress, ReworkQueueItem } from "@oh-my-roadmap/core/types";
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

describe("next-action staleness (resolving_blockers, rework, discovery)", () => {
  test("resolving_blockers with all blockers disposed recommends a concrete unblock, not a stale blocked hint", async () => {
    await approvedMilestoneForCwd(cwd);
    await transition(cwd, { operation: "start_implementation" });

    // A blocking blocker was raised against w01 and then resolved.
    const blocker = await openBlocker(cwd, {
      title: "Worker unavailable",
      description: "The assigned worker needs a replacement.",
      waveId: "w01",
      severity: "blocking",
    });
    await resolveBlocker(cwd, { blockerId: blocker.id, resolution: "Replacement worker assigned." });

    // The wave is parked in `blocked` and progress still says `resolving_blockers`, even though
    // nothing remains to resolve (resolveBlocker never touches progress.step).
    await transition(cwd, { operation: "update_wave_status", waveId: "w01", waveStatus: "blocked" });
    await transition(cwd, {
      operation: "update_implementation_progress",
      progress: {
        activeWaveId: "w01",
        step: "resolving_blockers",
        activeTaskIds: [],
        blockedReason: "Worker unavailable",
      },
    });

    const action = await nextActionPlan(cwd);
    // Not the stale "Resolve blocker: <blocked_reason>" hint and not `blocked`.
    expect(action.status).not.toBe("blocked");
    expect(action.description).not.toContain("Resolve blocker:");
    expect(action.blockers).toEqual([]);
    // A concrete, executable unblock instead.
    expect(action).toMatchObject({
      label: "Unblock wave",
      status: "ready",
      safe_to_apply: true,
      scope: { wave_id: "w01" },
      tool: {
        name: "omr_transition",
        input: { operation: "update_wave_status", waveId: "w01", waveStatus: "reviewing" },
      },
    });
    expect(action.description).toContain("omr_prepare_wave_review");

    // The recommended action is genuinely applicable and moves the wave out of `blocked`.
    await applyNextAction(cwd, action.id);
    const after = await loadState(cwd);
    expect(after.milestone?.waves.find((wave) => wave.id === "w01")?.status).toBe("reviewing");
  });

  test("a pending rework_queue item drives a wake-worker next action, not blocked", async () => {
    await approvedMilestoneForCwd(cwd);
    await transition(cwd, { operation: "start_implementation" });

    const state = await loadState(cwd);
    if (!state.milestone || !state.roadmap) throw new Error("Expected active milestone");

    const rework: ReworkQueueItem = {
      id: "rq-01",
      task_id: "t01-state",
      wave_id: "w01",
      finding_text: "Guard the empty-state branch before indexing",
      source_finding_severity: "blocking_worker_fixable",
      status: "pending",
      created_at: "2026-07-22T00:00:00.000Z",
      created_by: "wave-reviewer",
    };
    const progress: ImplementationProgress = {
      ...state.milestone.progress,
      active_wave_id: "w01",
      step: "resolving_blockers",
      rework_queue: [rework],
    };
    const blockers = await loadRoadmapBlockers(cwd, state.roadmap.roadmap_id);

    const action = progressNextActionPlan(state, progress, state.milestone.waves, blockers);
    expect(action.status).not.toBe("blocked");
    expect(action.label).toBe("Rework wave w01");
    expect(action.description).toContain("t01-state");
    expect(action.description).toContain("Guard the empty-state branch before indexing");
    expect(action.description).toContain("omr_prepare_wave_review");
    expect(action.scope).toMatchObject({ wave_id: "w01" });
  });

  test("rework next action reports the count when several items are pending", async () => {
    await approvedMilestoneForCwd(cwd);
    await transition(cwd, { operation: "start_implementation" });
    const state = await loadState(cwd);
    if (!state.milestone || !state.roadmap) throw new Error("Expected active milestone");

    const base = {
      wave_id: "w01",
      source_finding_severity: "blocking_worker_fixable" as const,
      status: "pending" as const,
      created_at: "2026-07-22T00:00:00.000Z",
      created_by: "wave-reviewer",
    };
    const progress: ImplementationProgress = {
      ...state.milestone.progress,
      active_wave_id: "w01",
      step: "resolving_blockers",
      rework_queue: [
        { id: "rq-01", task_id: "t01-state", finding_text: "First fix", ...base },
        { id: "rq-02", task_id: "t01-state", finding_text: "Second fix", ...base },
      ],
    };
    const action = progressNextActionPlan(state, progress, state.milestone.waves, []);
    expect(action.label).toBe("Rework wave w01");
    expect(action.description).toContain("2 pending rework items");
  });

  test("discovery phase recommends record_discovery, never the roadmap-milestone check", async () => {
    await initRoadmap(cwd, { roadmapId: "discovery-roadmap", title: "Discovery Roadmap" });
    const state = await loadState(cwd);
    expect(state.roadmap?.phase).toBe("discovery");

    const action = await nextActionPlan(cwd);
    expect(action.label).toBe("Record repo discovery");
    expect(action.id).toContain("record-discovery");
    expect(action.description).toContain("record_discovery");
    // Legal in discovery: record_discovery is a valid transition here.
    expect(action.status).toBe("needs_input");
    // The roadmap-milestone check requires phase roadmap_draft; it must never be recommended in
    // discovery (the historical R1 surfacing bug).
    expect(action.id).not.toContain("milestone-check");
    expect(action.description).not.toContain("milestone checker");
    expect(action.status).not.toBe("stale");
  });

  test("init rejects discovery.recorded=true loudly instead of silently accepting it", async () => {
    // Recording discovery is the record_discovery transition's job (it advances phase and captures
    // hash/revision). Accepting recorded=true at init would leave phase=discovery yet claim
    // discovery complete, so init must refuse rather than accept-and-ignore.
    await expect(
      initRoadmap(cwd, {
        roadmapId: "discovery-recorded-roadmap",
        title: "Discovery Recorded Roadmap",
        discovery: { recorded: true },
      }),
    ).rejects.toThrow("record_discovery");
  });
});
