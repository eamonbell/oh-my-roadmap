import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  formatBudgetSummaryLines,
  formatBudgetSummaryMarkdown,
  loadBudgetSummary,
} from "@oh-my-roadmap/core/budget-report";
import type { BudgetScopeState } from "@oh-my-roadmap/core/budget";
import { renderReport } from "@oh-my-roadmap/core/report/index";
import {
  writeMilestoneBudgetState,
  writeRoadmapBudgetState,
} from "@oh-my-roadmap/core/store/index";
import { emptyUsageTotals, writeUsageSummary } from "@oh-my-roadmap/core/usage";
import type { RoadmapUsageSummary, UsageTotals } from "@oh-my-roadmap/core/usage";
import {
  approvedMilestone,
  createTempRoadmapCwd,
  removeTempRoadmapCwd,
} from "./state/helpers";

const ROADMAP_ID = "complex-refactor";
const MILESTONE_ID = "m01-core";
const NOW = "2026-07-22T12:00:00.000Z";

let cwd = "";

beforeEach(async () => {
  cwd = await createTempRoadmapCwd();
  await approvedMilestone(cwd);
});

afterEach(async () => {
  await removeTempRoadmapCwd(cwd);
});

function totals(tokens: number, cost: number, usdUnavailable = false): UsageTotals {
  return {
    ...emptyUsageTotals(),
    estimated_usd: cost,
    usd_unavailable: usdUnavailable,
    input_tokens: tokens,
  };
}

function usageSummary(roadmap: UsageTotals, milestone: UsageTotals): RoadmapUsageSummary {
  return {
    roadmap_id: ROADMAP_ID,
    total: roadmap,
    by_agent: {},
    dedupe_keys: [],
    milestones: {
      [MILESTONE_ID]: {
        total: milestone,
        by_agent: {},
        change_requests: {},
      },
    },
  };
}

function budget(
  ceilings: BudgetScopeState["ceilings"],
  accumulatedMs = 0,
): BudgetScopeState {
  return {
    ceilings,
    overrides: [],
    time_tracking: { accumulated_ms: accumulatedMs },
  };
}

describe("budget summary and formatting", () => {
  test("returns empty formatter results and preserves exact status output without ceilings or overrides", async () => {
    const summary = await loadBudgetSummary(cwd, { now: NOW });
    expect(summary.scopes).toEqual([]);
    expect(formatBudgetSummaryLines(summary)).toEqual([]);
    expect(formatBudgetSummaryMarkdown(summary)).toBe("");

    const before = await renderReport(cwd);
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budget({}, 1234));
    await writeMilestoneBudgetState(cwd, ROADMAP_ID, MILESTONE_ID, budget({}, 5678));
    const after = await renderReport(cwd);
    expect(after).toBe(before);
  });

  test("summarizes tokens, cost, and time for both scopes in deterministic order", async () => {
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budget({
      tokens: 1000,
      cost: 10,
      time: 7_200_000,
    }, 5_400_000));
    await writeMilestoneBudgetState(cwd, ROADMAP_ID, MILESTONE_ID, budget({
      tokens: 100,
      cost: 5,
      time: 60_000,
    }, 90_000));
    await writeUsageSummary(cwd, usageSummary(totals(800, 2.5), totals(125, 4)));

    const summary = await loadBudgetSummary(cwd, { now: NOW });
    expect(summary.scopes.map((scope) => scope.scope)).toEqual(["roadmap", "milestone"]);
    expect(summary.scopes[0]?.dimensions).toMatchObject([
      { dimension: "tokens", spent: 800, ceiling: 1000, remaining: 200, percentage: 80, level: "warn", over_budget: false },
      { dimension: "cost", spent: 2.5, ceiling: 10, remaining: 7.5, percentage: 25, level: "none", over_budget: false },
      { dimension: "time", spent: 5_400_000, ceiling: 7_200_000, remaining: 1_800_000, percentage: 75, level: "warn", over_budget: false },
    ]);
    expect(summary.scopes[1]?.dimensions).toMatchObject([
      { dimension: "tokens", spent: 125, ceiling: 100, remaining: -25, percentage: 125, level: "hard", over_budget: true },
      { dimension: "cost", spent: 4, ceiling: 5, remaining: 1, percentage: 80, level: "warn", over_budget: false },
      { dimension: "time", spent: 90_000, ceiling: 60_000, remaining: -30_000, percentage: 150, level: "hard", over_budget: true },
    ]);
    expect(formatBudgetSummaryLines(summary)).toEqual([
      "Budget roadmap tokens: spent 800 tokens; ceiling 1,000 tokens; remaining 200 tokens; 80% used; level warn",
      "Budget roadmap cost: spent $2.5000; ceiling $10.0000; remaining $7.5000; 25% used; level none",
      "Budget roadmap time: spent 1h 30m; ceiling 2h; remaining 30m; 75% used; level warn",
      "Budget milestone m01-core tokens: spent 125 tokens; ceiling 100 tokens; remaining -25 tokens; 125% used; level hard, over budget",
      "Budget milestone m01-core cost: spent $4.0000; ceiling $5.0000; remaining $1.0000; 80% used; level warn",
      "Budget milestone m01-core time: spent 1m 30s; ceiling 1m; remaining -30s; 150% used; level hard, over budget",
    ]);
    const report = await renderReport(cwd);
    expect(report).toContain("Budget roadmap tokens: spent 800 tokens");
    expect(report).toContain("Budget milestone m01-core tokens: spent 125 tokens");
    expect(report).toContain("Budget warnings:\n- roadmap tokens 800/1000 (80%)");
    expect(report.indexOf("Usage roadmap:")).toBeLessThan(report.indexOf("Budget roadmap tokens:"));
    expect(report.indexOf("Budget roadmap tokens:")).toBeLessThan(report.indexOf("Budget warnings:"));
  });

  test("reports known cost plus unknown without false remaining, percentage, or threshold precision", async () => {
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budget({ cost: 10 }));
    await writeUsageSummary(cwd, usageSummary(totals(300, 2.5, true), totals(0, 0)));

    const summary = await loadBudgetSummary(cwd, { now: NOW });
    expect(summary.scopes[0]?.dimensions[0]).toEqual({
      dimension: "cost",
      spent: 2.5,
      ceiling: 10,
      remaining: undefined,
      percentage: undefined,
      level: "unknown",
      over_budget: undefined,
      unknown_cost: true,
    });
    expect(formatBudgetSummaryLines(summary)).toEqual([
      "Budget roadmap cost: spent $2.5000 + unknown; ceiling $10.0000; remaining unknown; percentage unknown; level unknown (some request costs unavailable)",
    ]);
  });

  test("compacts override totals, available one-shots, latest audit context, and scope filtering", async () => {
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, {
      ceilings: { tokens: 200 },
      overrides: [
        {
          id: "ovr-raise",
          type: "raise_ceiling",
          dimension: "tokens",
          old_ceiling: 100,
          new_ceiling: 200,
          reason: "finish review",
          granted_by: "alice",
          granted_at: "2026-07-22T10:00:00.000Z",
        },
        {
          id: "ovr-shot",
          type: "one_shot_continue",
          reason: "run verification",
          granted_by: "bob",
          granted_at: "2026-07-22T11:00:00.000Z",
          consumed: false,
        },
      ],
      time_tracking: { accumulated_ms: 0 },
    });
    await writeMilestoneBudgetState(cwd, ROADMAP_ID, MILESTONE_ID, {
      ceilings: {},
      overrides: [{
        id: "ovr-consumed",
        type: "one_shot_continue",
        reason: "complete wave",
        granted_by: "carol",
        granted_at: "2026-07-22T11:30:00.000Z",
        consumed: true,
      }],
      time_tracking: { accumulated_ms: 0 },
    });

    const summary = await loadBudgetSummary(cwd, { now: NOW });
    expect(summary.scopes[0]?.overrides).toMatchObject({
      total: 2,
      available_one_shots: 1,
      latest: {
        type: "one_shot_continue",
        reason: "run verification",
        granted_by: "bob",
        consumed: false,
      },
    });
    expect(formatBudgetSummaryLines(summary, { scopes: ["milestone"] })).toEqual([
      "Budget milestone m01-core overrides: 1 total; 0 one-shots available; latest one-shot continue (consumed) by carol at 2026-07-22T11:30:00.000Z: complete wave",
    ]);
    expect(formatBudgetSummaryMarkdown(summary, { scopes: ["roadmap"] })).toContain(
      "- Budget roadmap overrides: 2 total; 1 one-shot available; latest one-shot continue (available) by bob at 2026-07-22T11:00:00.000Z: run verification",
    );
  });
});
