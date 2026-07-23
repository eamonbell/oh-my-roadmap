import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { roadmapsDir } from "@oh-my-roadmap/core/paths";
import { readYamlFile, writeYamlFile } from "@oh-my-roadmap/core/files";
import { grantOneShotContinue } from "@oh-my-roadmap/core/budget";
import type { BudgetDimension, BudgetScopeState, ConsumptionResult } from "@oh-my-roadmap/core/budget";
import { ensureConfig } from "@oh-my-roadmap/core/project-init";
import type { BudgetThresholdPolicy } from "@oh-my-roadmap/core/project-init";
import { emptyUsageTotals, writeUsageSummary } from "@oh-my-roadmap/core/usage";
import type { RoadmapUsageSummary, UsageTotals } from "@oh-my-roadmap/core/usage";
import {
  initRoadmap,
  writeMilestoneBudgetState,
  writeRoadmapBudgetState,
} from "@oh-my-roadmap/core/store/index";
import { approvedMilestone } from "./state/helpers";
import {
  evaluateBudgetEnforcement,
  evaluateThresholds,
  formatBudgetBlockReason,
} from "@oh-my-roadmap/core/enforcement";

const ROADMAP_ID = "complex-refactor";
const MILESTONE_ID = "m01-core";

let cwd = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-enforcement-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

// Mirrors the private consumptionResult helper in budget.ts so pure threshold
// tests stay independent of computeConsumption/UsageTotals plumbing.
function makeConsumption(
  dimension: BudgetDimension,
  spent: number,
  ceiling: number | undefined,
): ConsumptionResult {
  if (ceiling === undefined) {
    return { dimension, spent, ceiling: undefined, remaining: undefined, percentage: undefined, over_budget: false };
  }
  return {
    dimension,
    spent,
    ceiling,
    remaining: ceiling - spent,
    percentage: ceiling === 0 ? (spent === 0 ? 0 : Infinity) : (spent / ceiling) * 100,
    over_budget: spent > ceiling,
  };
}

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

async function setThresholds(cwd: string, thresholds: BudgetThresholdPolicy): Promise<void> {
  await ensureConfig(cwd);
  const configPath = path.join(roadmapsDir(cwd), "config.yml");
  const raw = await readYamlFile<Record<string, unknown>>(configPath);
  raw.budgets = { thresholds };
  await writeYamlFile(configPath, raw);
}

describe("evaluateThresholds", () => {
  test("returns 'none' for a dimension without a ceiling (unlimited)", () => {
    const result = evaluateThresholds(
      [makeConsumption("tokens", 999, undefined)],
      { warn: 75, soft: 90, hard: 100 },
    );
    expect(result.levels.tokens).toBe("none");
    expect(result.level).toBe("none");
  });

  test("returns 'warn' when percentage meets the warn threshold", () => {
    const result = evaluateThresholds(
      [makeConsumption("tokens", 80, 100)],
      { warn: 75, soft: 90, hard: 100 },
    );
    expect(result.levels.tokens).toBe("warn");
    expect(result.level).toBe("warn");
  });

  test("returns 'soft' when percentage meets the soft threshold", () => {
    const result = evaluateThresholds(
      [makeConsumption("tokens", 90, 100)],
      { warn: 75, soft: 90, hard: 100 },
    );
    expect(result.levels.tokens).toBe("soft");
    expect(result.level).toBe("soft");
  });

  test("returns 'hard' when percentage meets the hard threshold", () => {
    const result = evaluateThresholds(
      [makeConsumption("tokens", 100, 100)],
      { warn: 75, soft: 90, hard: 100 },
    );
    expect(result.levels.tokens).toBe("hard");
    expect(result.level).toBe("hard");
  });

  test("over_budget implies hard regardless of percentage", () => {
    const result = evaluateThresholds(
      [makeConsumption("tokens", 101, 100)],
      { warn: 75, soft: 90, hard: 100 },
    );
    expect(result.levels.tokens).toBe("hard");
  });

  test("applies default policy (warn 75, soft disabled, hard 100) when policy is empty", () => {
    // 74% → none (below default warn 75)
    expect(evaluateThresholds([makeConsumption("tokens", 74, 100)], {}).levels.tokens).toBe("none");
    // 80% → warn (default warn 75, soft disabled)
    expect(evaluateThresholds([makeConsumption("tokens", 80, 100)], {}).levels.tokens).toBe("warn");
    // 99% → still warn (soft disabled, so jumps to hard only at 100)
    expect(evaluateThresholds([makeConsumption("tokens", 99, 100)], {}).levels.tokens).toBe("warn");
    // 100% → hard (default hard 100)
    expect(evaluateThresholds([makeConsumption("tokens", 100, 100)], {}).levels.tokens).toBe("hard");
  });

  test("soft is disabled when undefined, skipping straight from warn to hard", () => {
    // With soft explicitly set to 85: 85% → soft
    expect(
      evaluateThresholds([makeConsumption("tokens", 85, 100)], { warn: 75, soft: 85, hard: 100 }).levels.tokens,
    ).toBe("soft");
    // With soft undefined: 85% → warn (soft disabled)
    expect(
      evaluateThresholds([makeConsumption("tokens", 85, 100)], { warn: 75, hard: 100 }).levels.tokens,
    ).toBe("warn");
  });

  test("override-applied: a raised ceiling lowers the breach level", () => {
    // Before raise: ceiling 100, spent 80 → 80% → warn
    const before = evaluateThresholds(
      [makeConsumption("tokens", 80, 100)],
      { warn: 75, soft: 90, hard: 100 },
    );
    expect(before.levels.tokens).toBe("warn");
    // After raise_ceiling: ceiling 200, spent 80 → 40% → none
    const after = evaluateThresholds(
      [makeConsumption("tokens", 80, 200)],
      { warn: 75, soft: 90, hard: 100 },
    );
    expect(after.levels.tokens).toBe("none");
  });

  test("overall level is the most severe across dimensions", () => {
    const result = evaluateThresholds(
      [
        makeConsumption("tokens", 50, 100), // 50% → none
        makeConsumption("cost", 80, 100), // 80% → warn
        makeConsumption("time", 95, 100), // 95% → soft
      ],
      { warn: 75, soft: 90, hard: 100 },
    );
    expect(result.levels.tokens).toBe("none");
    expect(result.levels.cost).toBe("warn");
    expect(result.levels.time).toBe("soft");
    expect(result.level).toBe("soft");
  });

  test("ceiling of zero with no spend is 'none'; with spend is 'hard'", () => {
    expect(evaluateThresholds([makeConsumption("tokens", 0, 0)], {}).levels.tokens).toBe("none");
    expect(evaluateThresholds([makeConsumption("tokens", 1, 0)], {}).levels.tokens).toBe("hard");
  });
});

describe("formatBudgetBlockReason", () => {
  test("produces an actionable hard-limit message", () => {
    const reason = formatBudgetBlockReason("hard", "milestone", "tokens", 550, 500, 110);
    expect(reason).toContain("hard limit");
    expect(reason).toContain("milestone");
    expect(reason).toContain("tokens");
    expect(reason).toContain("550");
    expect(reason).toContain("500");
    expect(reason).toContain("110%");
    expect(reason).toContain("raise");
    expect(reason).toContain("one-shot continue");
  });

  test("produces a soft-limit message", () => {
    const reason = formatBudgetBlockReason("soft", "roadmap", "cost", 8, 10, 80);
    expect(reason).toContain("soft limit");
    expect(reason).toContain("roadmap");
    expect(reason).toContain("cost");
  });

  test("reports 'over budget' for infinite percentage", () => {
    const reason = formatBudgetBlockReason("hard", "roadmap", "tokens", 5, 0, Infinity);
    expect(reason).toContain("over budget");
  });
});

describe("evaluateBudgetEnforcement", () => {
  test("returns a no-op state when there is no active roadmap", async () => {
    const state = await evaluateBudgetEnforcement(cwd);
    expect(state.level).toBe("none");
    expect(state.scopes).toEqual([]);
    expect(state.warnings).toEqual([]);
    expect(state.softBreached).toBe(false);
    expect(state.hardBreached).toBe(false);
  });

  test("returns a no-op state when no ceilings are configured", async () => {
    await initRoadmap(cwd, { roadmapId: "enforce-roadmap", title: "Enforce Roadmap" });
    const state = await evaluateBudgetEnforcement(cwd);
    expect(state.level).toBe("none");
    expect(state.scopes).toEqual([]);
    expect(state.warnings).toEqual([]);
    expect(state.softBreached).toBe(false);
    expect(state.hardBreached).toBe(false);
  });

  test("evaluates only the roadmap scope when no milestone is active", async () => {
    await initRoadmap(cwd, { roadmapId: "enforce-rm", title: "Enforce RM" });
    await writeRoadmapBudgetState(cwd, "enforce-rm", budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, {
      roadmap_id: "enforce-rm",
      total: usageTotals(800),
      by_agent: {},
      dedupe_keys: [],
      milestones: {},
    });

    const state = await evaluateBudgetEnforcement(cwd);
    expect(state.scopes).toHaveLength(1);
    expect(state.scopes[0]!.scope).toBe("roadmap");
    // 800/1000 = 80% → warn (default warn 75)
    expect(state.scopes[0]!.level).toBe("warn");
    expect(state.scopes[0]!.hardBreached).toBe(false);
    expect(state.level).toBe("warn");
  });

  test("reports per-scope consumption and the most-severe breach across scopes", async () => {
    await approvedMilestone(cwd);
    // Roadmap: 800/1000 = 80% → warn (default warn 75)
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    // Milestone: 550/500 = 110% → hard (over_budget)
    await writeMilestoneBudgetState(cwd, ROADMAP_ID, MILESTONE_ID, budgetWithCeilings({ tokens: 500 }));
    await writeUsageSummary(cwd, makeUsage(800, 550));

    const state = await evaluateBudgetEnforcement(cwd);
    expect(state.scopes).toHaveLength(2);

    const roadmapScope = state.scopes.find((s) => s.scope === "roadmap")!;
    expect(roadmapScope.level).toBe("warn");
    expect(roadmapScope.softBreached).toBe(false);
    expect(roadmapScope.hardBreached).toBe(false);
    const roadmapTokens = roadmapScope.consumption.find((c) => c.dimension === "tokens")!;
    expect(roadmapTokens.spent).toBe(800);
    expect(roadmapTokens.ceiling).toBe(1000);
    expect(roadmapTokens.percentage).toBe(80);

    const milestoneScope = state.scopes.find((s) => s.scope === "milestone")!;
    expect(milestoneScope.level).toBe("hard");
    expect(milestoneScope.hardBreached).toBe(true);
    expect(milestoneScope.softBreached).toBe(true);
    const milestoneTokens = milestoneScope.consumption.find((c) => c.dimension === "tokens")!;
    expect(milestoneTokens.spent).toBe(550);
    expect(milestoneTokens.ceiling).toBe(500);
    expect(milestoneTokens.over_budget).toBe(true);

    // Overall is the most severe across scopes.
    expect(state.level).toBe("hard");
    expect(state.hardBreached).toBe(true);
    expect(state.softBreached).toBe(true);
  });

  test("reports one-shot availability per scope", async () => {
    await approvedMilestone(cwd);
    const now = "2026-07-22T00:00:00.000Z";
    // Roadmap budget has an available one-shot continue.
    const roadmapBudget = grantOneShotContinue(
      budgetWithCeilings({ tokens: 1000 }),
      "alice",
      "continue",
      now,
    );
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, roadmapBudget);
    // Milestone budget has no one-shot.
    await writeMilestoneBudgetState(cwd, ROADMAP_ID, MILESTONE_ID, budgetWithCeilings({ tokens: 500 }));
    await writeUsageSummary(cwd, makeUsage(100, 100));

    const state = await evaluateBudgetEnforcement(cwd);
    const roadmapScope = state.scopes.find((s) => s.scope === "roadmap")!;
    expect(roadmapScope.hasAvailableOneShot).toBe(true);
    const milestoneScope = state.scopes.find((s) => s.scope === "milestone")!;
    expect(milestoneScope.hasAvailableOneShot).toBe(false);
  });

  test("applies custom thresholds from project config", async () => {
    await approvedMilestone(cwd);
    await setThresholds(cwd, { warn: 50, soft: 70, hard: 90 });
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(750, 100));

    const state = await evaluateBudgetEnforcement(cwd);
    const roadmapScope = state.scopes.find((s) => s.scope === "roadmap")!;
    // 750/1000 = 75% → soft (>= 70 soft, < 90 hard)
    expect(roadmapScope.level).toBe("soft");
    expect(roadmapScope.softBreached).toBe(true);
    expect(state.level).toBe("soft");
  });

  test("collects warnings for all breached dimensions", async () => {
    await approvedMilestone(cwd);
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000, cost: 10 }));
    // 800 tokens / 1000 = 80% → warn; 8 USD / 10 = 80% → warn
    await writeUsageSummary(cwd, {
      ...makeUsage(800, 0),
      total: { ...usageTotals(800), estimated_usd: 8 },
    });

    const state = await evaluateBudgetEnforcement(cwd);
    const roadmapScope = state.scopes.find((s) => s.scope === "roadmap")!;
    expect(roadmapScope.warnings).toHaveLength(2);
    expect(roadmapScope.warnings.map((w) => w.dimension).sort()).toEqual(["cost", "tokens"]);
    expect(state.warnings).toHaveLength(2);
  });

  test("skips a scope whose budget state has no ceilings", async () => {
    await approvedMilestone(cwd);
    // Only roadmap has ceilings; milestone budget exists but has no ceilings.
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeMilestoneBudgetState(cwd, ROADMAP_ID, MILESTONE_ID, {
      ceilings: {},
      overrides: [],
      time_tracking: { accumulated_ms: 0 },
    });
    await writeUsageSummary(cwd, makeUsage(800, 550));

    const state = await evaluateBudgetEnforcement(cwd);
    expect(state.scopes).toHaveLength(1);
    expect(state.scopes[0]!.scope).toBe("roadmap");
  });
});
