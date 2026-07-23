import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BudgetDimension, BudgetScopeState } from "@oh-my-roadmap/core/budget";
import {
  applyBudgetRaiseCeiling,
  grantBudgetOneShot,
  setActiveBudgetCeiling,
  type BudgetScope,
} from "@oh-my-roadmap/core/enforcement";
import {
  loadMilestoneBudgetState,
  loadRoadmapBudgetState,
  loadState,
  writeMilestoneBudgetState,
  writeRoadmapBudgetState,
} from "@oh-my-roadmap/core/store/index";
import {
  approvedMilestone,
  approvedRoadmap,
  createTempRoadmapCwd,
  removeTempRoadmapCwd,
} from "./state/helpers";

let cwd = "";

beforeEach(async () => {
  cwd = await createTempRoadmapCwd();
});

afterEach(async () => {
  await removeTempRoadmapCwd(cwd);
});

interface ActiveIds {
  roadmapId: string;
  milestoneId: string | undefined;
}

async function activeIds(): Promise<ActiveIds> {
  const loaded = await loadState(cwd);
  return {
    roadmapId: loaded.active!.roadmap_id,
    milestoneId: loaded.active!.milestone_id ?? loaded.roadmap!.active_milestone_id,
  };
}

async function writeScopeBudget(scope: BudgetScope, state: BudgetScopeState): Promise<void> {
  const ids = await activeIds();
  if (scope === "milestone") {
    await writeMilestoneBudgetState(cwd, ids.roadmapId, ids.milestoneId!, state);
  } else {
    await writeRoadmapBudgetState(cwd, ids.roadmapId, state);
  }
}

async function loadScopeBudget(scope: BudgetScope): Promise<BudgetScopeState | undefined> {
  const ids = await activeIds();
  return scope === "milestone"
    ? await loadMilestoneBudgetState(cwd, ids.roadmapId, ids.milestoneId!)
    : await loadRoadmapBudgetState(cwd, ids.roadmapId);
}

const dimensionCases: Array<{
  dimension: BudgetDimension;
  value: string;
  parsed: number;
}> = [
    { dimension: "tokens", value: "2500", parsed: 2500 },
    { dimension: "cost", value: "12.50", parsed: 12.5 },
    { dimension: "time", value: "1h30m", parsed: 5_400_000 },
  ];

const preservedState: BudgetScopeState = {
  ceilings: {},
  overrides: [
    {
      id: "ovr_preserved",
      type: "one_shot_continue",
      reason: "existing grant",
      granted_by: "operator",
      granted_at: "2026-07-22T00:00:00.000Z",
      consumed: true,
    },
  ],
  time_tracking: {
    accumulated_ms: 42_000,
    started_at: "2026-07-22T00:01:00.000Z",
  },
};

describe("active-scope baseline budget controls", () => {
  for (const scope of ["roadmap", "milestone"] as const) {
    test(`${scope} set parses all dimensions and equal/lower/clear preserve unrelated state`, async () => {
      if (scope === "milestone") await approvedMilestone(cwd);
      else await approvedRoadmap(cwd);
      await writeScopeBudget(scope, preservedState);

      for (const { dimension, value, parsed } of dimensionCases) {
        const result = await setActiveBudgetCeiling(cwd, scope, dimension, value);
        expect(result).toMatchObject({
          scope,
          dimension,
          previousCeiling: undefined,
          newCeiling: parsed,
        });
        expect(result.state.ceilings[dimension]).toBe(parsed);
      }

      const equal = await setActiveBudgetCeiling(cwd, scope, "tokens", "2500");
      expect(equal.previousCeiling).toBe(2500);
      expect(equal.newCeiling).toBe(2500);

      const lowered = await setActiveBudgetCeiling(cwd, scope, "cost", "10.25");
      expect(lowered.previousCeiling).toBe(12.5);
      expect(lowered.newCeiling).toBe(10.25);

      const cleared = await setActiveBudgetCeiling(cwd, scope, "time", "unlimited");
      expect(cleared).toMatchObject({
        scope,
        dimension: "time",
        previousCeiling: 5_400_000,
        newCeiling: undefined,
      });
      expect(cleared.state.ceilings).toEqual({ tokens: 2500, cost: 10.25 });
      expect(cleared.state.overrides).toEqual(preservedState.overrides);
      expect(cleared.state.time_tracking).toEqual(preservedState.time_tracking);
      expect(await loadScopeBudget(scope)).toEqual(cleared.state);
    });

    test(`${scope} set rejects an increase without mutating persisted state`, async () => {
      if (scope === "milestone") await approvedMilestone(cwd);
      else await approvedRoadmap(cwd);
      const initial = await setActiveBudgetCeiling(cwd, scope, "tokens", "100");

      await expect(setActiveBudgetCeiling(cwd, scope, "tokens", "101")).rejects.toThrow(
        /audited raise override/i,
      );
      expect(await loadScopeBudget(scope)).toEqual(initial.state);
    });
  }

  test("reports missing active roadmap and milestone without writing a budget", async () => {
    await expect(setActiveBudgetCeiling(cwd, "roadmap", "tokens", "100")).rejects.toThrow(
      /no active roadmap/i,
    );

    await approvedRoadmap(cwd);
    await expect(setActiveBudgetCeiling(cwd, "milestone", "tokens", "100")).rejects.toThrow(
      /no active milestone/i,
    );
    expect(await loadRoadmapBudgetState(cwd, (await activeIds()).roadmapId)).toBeUndefined();
  });

  test("serializes concurrent baseline, audited raise, and one-shot mutations", async () => {
    await approvedRoadmap(cwd);
    await writeScopeBudget("roadmap", {
      ceilings: { tokens: 1000 },
      overrides: [],
      time_tracking: preservedState.time_tracking,
    });

    const [baseline, raised, oneShot] = await Promise.all([
      setActiveBudgetCeiling(cwd, "roadmap", "cost", "5.00"),
      applyBudgetRaiseCeiling(cwd, "roadmap", "tokens", 2000, "user", "approved expansion"),
      grantBudgetOneShot(cwd, "roadmap", "user", "finish current operation"),
    ]);

    expect(baseline).toMatchObject({ scope: "roadmap", dimension: "cost", newCeiling: 5 });
    expect(raised).toMatchObject({
      scope: "roadmap",
      dimension: "tokens",
      previousCeiling: 1000,
      newCeiling: 2000,
    });
    expect(oneShot.scope).toBe("roadmap");

    const persisted = await loadScopeBudget("roadmap");
    expect(persisted?.ceilings).toEqual({ tokens: 2000, cost: 5 });
    expect(persisted?.time_tracking).toEqual(preservedState.time_tracking);
    expect(persisted?.overrides).toHaveLength(2);
    expect(persisted?.overrides.map((override) => override.type).sort()).toEqual([
      "one_shot_continue",
      "raise_ceiling",
    ]);
    expect(persisted?.overrides.every((override) => override.granted_by === "user")).toBe(true);
  });
});
