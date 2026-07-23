import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applyBudgetRaiseCeiling,
  evaluateBudgetEnforcement,
  formatBudgetWarning,
  grantBudgetOneShot,
} from "@oh-my-roadmap/core/enforcement";
import { emptyBudgetScopeState, hasAvailableOneShot } from "@oh-my-roadmap/core/budget";
import {
  loadMilestoneBudgetState,
  loadRoadmapBudgetState,
  loadState,
  writeRoadmapBudgetState,
} from "@oh-my-roadmap/core/store/index";
import { emptyRoadmapUsageSummary, writeUsageSummary } from "@oh-my-roadmap/core/usage";
import { nextAction, nextActionPlan, renderReport } from "@oh-my-roadmap/core/report/index";
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

describe("budget override application", () => {
  test("applyBudgetRaiseCeiling raises the roadmap ceiling and persists audit fields", async () => {
    await approvedRoadmap(cwd);
    const state = await loadState(cwd);
    const roadmapId = state.roadmap!.roadmap_id;

    const result = await applyBudgetRaiseCeiling(cwd, "roadmap", "tokens", 1000, "user", "initial raise");
    const updated = result.state;
    expect(result).toMatchObject({
      scope: "roadmap",
      dimension: "tokens",
      previousCeiling: undefined,
      newCeiling: 1000,
    });

    expect(updated.ceilings.tokens).toBe(1000);
    expect(updated.overrides).toHaveLength(1);
    expect(updated.overrides[0]?.id.startsWith("ovr_")).toBe(true);
    expect(updated.overrides[0]?.granted_at).toBeTruthy();
    expect(updated.overrides[0]?.old_ceiling).toBeUndefined();
    expect(updated.overrides[0]).toMatchObject({
      type: "raise_ceiling",
      dimension: "tokens",
      new_ceiling: 1000,
      reason: "initial raise",
      granted_by: "user",
    });
    // persisted to the roadmap budget file
    expect(await loadRoadmapBudgetState(cwd, roadmapId)).toEqual(updated);

    // a second raise captures the previous ceiling as old_ceiling
    const result2 = await applyBudgetRaiseCeiling(cwd, "roadmap", "tokens", 2500, "bob", "second raise");
    const updated2 = result2.state;
    expect(result2).toMatchObject({
      scope: "roadmap",
      dimension: "tokens",
      previousCeiling: 1000,
      newCeiling: 2500,
    });
    expect(updated2.ceilings.tokens).toBe(2500);
    expect(updated2.overrides).toHaveLength(2);
    expect(updated2.overrides[1]).toMatchObject({
      type: "raise_ceiling",
      dimension: "tokens",
      old_ceiling: 1000,
      new_ceiling: 2500,
      granted_by: "bob",
      reason: "second raise",
    });
    expect(await loadRoadmapBudgetState(cwd, roadmapId)).toEqual(updated2);
  });

  test("applyBudgetRaiseCeiling writes the milestone budget state for milestone scope", async () => {
    await approvedMilestone(cwd);
    const state = await loadState(cwd);
    const roadmapId = state.roadmap!.roadmap_id;
    const milestoneId = state.active?.milestone_id ?? state.roadmap?.active_milestone_id;
    expect(milestoneId).toBeTruthy();

    const result = await applyBudgetRaiseCeiling(cwd, "milestone", "cost", 5, "carol", "milestone cost raise");
    const updated = result.state;
    expect(result).toMatchObject({
      scope: "milestone",
      dimension: "cost",
      previousCeiling: undefined,
      newCeiling: 5,
    });

    expect(updated.ceilings.cost).toBe(5);
    expect(updated.overrides[0]).toMatchObject({
      type: "raise_ceiling",
      dimension: "cost",
      new_ceiling: 5,
      granted_by: "carol",
      reason: "milestone cost raise",
    });
    expect(updated.overrides[0]?.old_ceiling).toBeUndefined();

    // persisted to the milestone budget file, leaving the roadmap budget untouched
    expect(await loadMilestoneBudgetState(cwd, roadmapId, milestoneId!)).toEqual(updated);
    expect(await loadRoadmapBudgetState(cwd, roadmapId)).toBeUndefined();
  });

  test("grantBudgetOneShot grants a single unconsumed one-shot continue", async () => {
    await approvedRoadmap(cwd);

    const result = await grantBudgetOneShot(cwd, "roadmap", "user", "continue past warn");
    const updated = result.state;
    expect(result.scope).toBe("roadmap");

    expect(updated.overrides).toHaveLength(1);
    expect(updated.overrides[0]?.id.startsWith("ovr_")).toBe(true);
    expect(updated.overrides[0]?.granted_at).toBeTruthy();
    expect(updated.overrides[0]).toMatchObject({
      type: "one_shot_continue",
      consumed: false,
      granted_by: "user",
      reason: "continue past warn",
    });
    expect(hasAvailableOneShot(updated)).toBe(true);

    // a second grant adds another unconsumed one-shot; both remain available
    const result2 = await grantBudgetOneShot(cwd, "roadmap", "eve", "second continue");
    const updated2 = result2.state;
    expect(updated2.overrides).toHaveLength(2);
    expect(updated2.overrides[1]).toMatchObject({ type: "one_shot_continue", consumed: false });
    expect(hasAvailableOneShot(updated2)).toBe(true);
  });

  test("override functions throw when no roadmap is active", async () => {
    await expect(applyBudgetRaiseCeiling(cwd, "roadmap", "tokens", 100, "alice", "x")).rejects.toThrow(
      /no active roadmap/i,
    );
    await expect(grantBudgetOneShot(cwd, "roadmap", "alice", "x")).rejects.toThrow(/no active roadmap/i);
  });
});

describe("budget warn surfacing", () => {
  test("formatBudgetWarning summarizes scope, dimension, spent/ceiling, and percentage", () => {
    expect(
      formatBudgetWarning({ scope: "roadmap", dimension: "tokens", spent: 80, ceiling: 100, percentage: 80 }),
    ).toBe("roadmap tokens 80/100 (80%)");
    expect(
      formatBudgetWarning({ scope: "milestone", dimension: "cost", spent: 9, ceiling: 10, percentage: 90 }),
    ).toBe("milestone cost 9/10 (90%)");
    expect(
      formatBudgetWarning({ scope: "roadmap", dimension: "time", spent: 1, ceiling: 3, percentage: (1 / 3) * 100 }),
    ).toBe("roadmap time 1/3 (33%)");
  });

  test("renderReport and nextAction surface budget warnings when a warn threshold is crossed", async () => {
    await approvedRoadmap(cwd);
    const state = await loadState(cwd);
    const roadmapId = state.roadmap!.roadmap_id;

    // a 100-token ceiling with 80 tokens consumed crosses the default warn threshold (75%)
    await writeRoadmapBudgetState(cwd, roadmapId, { ...emptyBudgetScopeState(), ceilings: { tokens: 100 } });
    const usage = emptyRoadmapUsageSummary(roadmapId);
    usage.total.input_tokens = 80;
    await writeUsageSummary(cwd, usage);

    const enforcement = await evaluateBudgetEnforcement(cwd);
    expect(enforcement.warnings).toHaveLength(1);
    expect(enforcement.warnings[0]).toMatchObject({
      scope: "roadmap",
      dimension: "tokens",
      spent: 80,
      ceiling: 100,
    });

    const report = await renderReport(cwd);
    expect(report).toContain("Budget warnings:");
    expect(report).toContain("- roadmap tokens 80/100 (80%)");

    const action = await nextAction(cwd);
    expect(action).toContain("Budget warning: roadmap tokens 80/100 (80%)");

    // nextActionPlan augments only the description; status/tool/safe_to_apply are unchanged
    const plan = await nextActionPlan(cwd);
    expect(plan.description).toContain("Budget warning:");
    expect(plan.status).toBe("ready");
    expect(plan.safe_to_apply).toBe(true);
    expect(plan.tool?.name).toBe("omr_transition");
  });

  test("renderReport and nextAction are unchanged when no budgets are configured", async () => {
    await approvedRoadmap(cwd);

    const report = await renderReport(cwd);
    expect(report).not.toContain("Budget warnings:");

    const action = await nextAction(cwd);
    expect(action).not.toContain("Budget warning:");
  });
});
