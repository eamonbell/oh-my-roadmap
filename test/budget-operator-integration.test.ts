import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { formatBudgetSummaryLines, loadBudgetSummary } from "@oh-my-roadmap/core/budget-report";
import {
  applyBudgetRaiseCeiling,
  evaluateBudgetEnforcement,
  grantBudgetOneShot,
  setActiveBudgetCeiling,
} from "@oh-my-roadmap/core/enforcement";
import { loadRoadmapBudgetState, loadState } from "@oh-my-roadmap/core/store/index";
import { emptyUsageTotals, writeUsageSummary } from "@oh-my-roadmap/core/usage";
import {
  approvedMilestone,
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

describe("budget operator lifecycle", () => {
  test("sets, consumes, surfaces, overrides, and preserves no-budget compatibility", async () => {
    await approvedMilestone(cwd);

    // An active roadmap without budget files remains a no-op for enforcement and reporting.
    expect(await evaluateBudgetEnforcement(cwd)).toEqual({
      level: "none",
      scopes: [],
      warnings: [],
      softBreached: false,
      hardBreached: false,
    });
    expect(formatBudgetSummaryLines(await loadBudgetSummary(cwd))).toEqual([]);

    const state = await loadState(cwd);
    const roadmapId = state.active!.roadmap_id;
    const milestoneId = state.active!.milestone_id!;

    await setActiveBudgetCeiling(cwd, "roadmap", "tokens", "100");
    await setActiveBudgetCeiling(cwd, "milestone", "tokens", "100");
    await writeUsageSummary(cwd, {
      roadmap_id: roadmapId,
      total: { ...emptyUsageTotals(), input_tokens: 100, requests: 1 },
      by_agent: {},
      dedupe_keys: [],
      milestones: {
        [milestoneId]: {
          total: { ...emptyUsageTotals(), input_tokens: 100, requests: 1 },
          by_agent: {},
          change_requests: {},
        },
      },
    });

    const enforcement = await evaluateBudgetEnforcement(cwd);
    expect(enforcement).toMatchObject({ level: "hard", hardBreached: true });
    expect(enforcement.scopes).toHaveLength(2);
    expect(enforcement.scopes[0]).toMatchObject({
      scope: "roadmap",
      levels: { tokens: "hard" },
      hardBreached: true,
    });
    expect(enforcement.scopes[1]).toMatchObject({
      scope: "milestone",
      levels: { tokens: "hard" },
      hardBreached: true,
    });
    expect(formatBudgetSummaryLines(await loadBudgetSummary(cwd))).toEqual([
      "Budget roadmap tokens: spent 100 tokens; ceiling 100 tokens; remaining 0 tokens; 100% used; level hard",
      "Budget milestone m01-core tokens: spent 100 tokens; ceiling 100 tokens; remaining 0 tokens; 100% used; level hard",
    ]);

    await expect(setActiveBudgetCeiling(cwd, "roadmap", "tokens", "101")).rejects.toThrow(
      "audited raise override",
    );
    expect((await loadRoadmapBudgetState(cwd, roadmapId))?.ceilings.tokens).toBe(100);

    await applyBudgetRaiseCeiling(cwd, "roadmap", "tokens", 150, "operator", "capacity approved");
    await grantBudgetOneShot(cwd, "roadmap", "operator", "complete the current dispatch");

    expect(await loadRoadmapBudgetState(cwd, roadmapId)).toMatchObject({
      ceilings: { tokens: 150 },
      overrides: [
        {
          type: "raise_ceiling",
          dimension: "tokens",
          old_ceiling: 100,
          new_ceiling: 150,
          granted_by: "operator",
          reason: "capacity approved",
        },
        {
          type: "one_shot_continue",
          granted_by: "operator",
          reason: "complete the current dispatch",
          consumed: false,
        },
      ],
    });
    expect((await evaluateBudgetEnforcement(cwd)).scopes[0]?.hasAvailableOneShot).toBe(true);
  });
});
