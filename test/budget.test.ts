import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { emptyTimeTracking } from "@oh-my-roadmap/core/elapsed-time";
import {
  applyRaiseCeiling,
  computeConsumption,
  consumeOneShot,
  emptyBudgetScopeState,
  grantOneShotContinue,
  hasAvailableOneShot,
  normalizeBudgetScopeState,
  parseBudgetCeiling,
  parseCost,
  parseTimeDuration,
  parseTokenCount,
  type BudgetDimension,
  type BudgetScopeState,
  type ConsumptionResult,
} from "@oh-my-roadmap/core/budget";
import {
  loadMilestoneBudgetState,
  loadRoadmapBudgetState,
  writeMilestoneBudgetState,
  writeRoadmapBudgetState,
} from "@oh-my-roadmap/core/store/index";
import type { UsageTotals } from "@oh-my-roadmap/core/usage";

let cwd = "";

const roadmapId = "budget-roadmap";
const milestoneId = "budget-milestone";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-budget-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

function resultFor(results: ConsumptionResult[], dimension: BudgetDimension) {
  const result = results.find((entry) => entry.dimension === dimension);
  if (!result) throw new Error(`Missing ${dimension} result`);
  return result;
}

function sampleBudgetState(now: string): BudgetScopeState {
  const later = "2026-07-22T00:05:00.000Z";
  let state = applyRaiseCeiling(emptyBudgetScopeState(), "tokens", 100, "alice", "raise tokens", now);
  state = applyRaiseCeiling(state, "tokens", 250, "bob", "raise tokens again", later);
  state = grantOneShotContinue(state, "carol", "first one-shot", now);
  state = grantOneShotContinue(state, "dave", "second one-shot", later);
  state = consumeOneShot(state);
  return {
    ...state,
    time_tracking: { accumulated_ms: 12345, started_at: now },
  };
}

describe("budget parsers", () => {
  test("parses human-friendly time durations", () => {
    expect(parseTimeDuration("30m")).toBe(1800000);
    expect(parseTimeDuration("1h")).toBe(3600000);
    expect(parseTimeDuration("2h30m")).toBe(9000000);
    expect(parseTimeDuration("90s")).toBe(90000);
    expect(parseTimeDuration("1h30m45s")).toBe(5445000);
  });

  test("rejects invalid time durations", () => {
    for (const value of ["", "30x", "abc", "-5m", "30", "1.5h"]) {
      expect(() => parseTimeDuration(value)).toThrow(/time duration/i);
    }
  });

  test("parses decimal costs", () => {
    expect(parseCost("5.00")).toBe(5);
    expect(parseCost("5")).toBe(5);
    expect(parseCost("0.50")).toBe(0.5);
  });

  test("rejects invalid costs", () => {
    for (const value of ["abc", "-5", "5.00.00"]) {
      expect(() => parseCost(value)).toThrow(/cost/i);
    }
  });

  test("parses token counts", () => {
    expect(parseTokenCount("1000000")).toBe(1000000);
    expect(parseTokenCount("0")).toBe(0);
  });

  test("rejects invalid token counts", () => {
    for (const value of ["1.5", "-5", "abc", "1e6"]) {
      expect(() => parseTokenCount(value)).toThrow(/token count/i);
    }
  });

  test("parses partial budget ceilings", () => {
    expect(parseBudgetCeiling({ tokens: "1000000", cost: "5.00", time: "30m" })).toEqual({
      tokens: 1000000,
      cost: 5,
      time: 1800000,
    });
    expect(parseBudgetCeiling({ tokens: "1000" })).toEqual({ tokens: 1000 });
    expect(parseBudgetCeiling({})).toEqual({});
    expect(() => parseBudgetCeiling({ foo: "1" })).toThrow(/unsupported key/i);
  });
});

describe("budget consumption", () => {
  const totals: UsageTotals = {
    estimated_usd: 4.5,
    usd_unavailable: false,
    requests: 1,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 30,
    cache_write_tokens: 40,
    reasoning_tokens: 999,
  };

  test("computes spent, remaining, and percentages within budget", () => {
    const results = computeConsumption(totals, 5000, { tokens: 100, cost: 5, time: 5000 });
    expect(results).toHaveLength(3);

    const tokens = resultFor(results, "tokens");
    expect(tokens).toEqual({
      dimension: "tokens",
      spent: 100,
      ceiling: 100,
      remaining: 0,
      percentage: 100,
      over_budget: false,
    });

    const cost = resultFor(results, "cost");
    expect(cost).toEqual({
      dimension: "cost",
      spent: 4.5,
      ceiling: 5,
      remaining: 0.5,
      percentage: 90,
      over_budget: false,
    });

    const time = resultFor(results, "time");
    expect(time).toEqual({
      dimension: "time",
      spent: 5000,
      ceiling: 5000,
      remaining: 0,
      percentage: 100,
      over_budget: false,
    });
  });

  test("marks over-budget and unlimited dimensions correctly", () => {
    const results = computeConsumption(totals, 8000, { tokens: 70, time: 4000 });

    const tokens = resultFor(results, "tokens");
    expect(tokens.spent).toBe(100);
    expect(tokens.ceiling).toBe(70);
    expect(tokens.remaining).toBe(-30);
    expect(tokens.percentage).toBe(100 * 100 / 70);
    expect(tokens.over_budget).toBe(true);

    const cost = resultFor(results, "cost");
    expect(cost.spent).toBe(4.5);
    expect(cost.ceiling).toBeUndefined();
    expect(cost.remaining).toBeUndefined();
    expect(cost.percentage).toBeUndefined();
    expect(cost.over_budget).toBe(false);

    const time = resultFor(results, "time");
    expect(time.spent).toBe(8000);
    expect(time.ceiling).toBe(4000);
    expect(time.remaining).toBe(-4000);
    expect(time.percentage).toBe(200);
    expect(time.over_budget).toBe(true);
  });

  test("zeroes cost when usd_unavailable is true", () => {
    const unavailableTotals: UsageTotals = { ...totals, estimated_usd: 123.45, usd_unavailable: true };
    const results = computeConsumption(unavailableTotals, 1234, { cost: 1 });
    const cost = resultFor(results, "cost");
    expect(cost.spent).toBe(0);
    expect(cost.ceiling).toBe(1);
    expect(cost.remaining).toBe(1);
    expect(cost.percentage).toBe(0);
    expect(cost.over_budget).toBe(false);
  });
});

describe("budget overrides", () => {
  test("records raise_ceiling and one_shot_continue overrides", () => {
    const now = "2026-07-22T00:00:00.000Z";
    const later = "2026-07-22T00:05:00.000Z";
    const empty = emptyBudgetScopeState();

    const raised = applyRaiseCeiling(empty, "tokens", 100, "alice", "raise tokens", now);
    expect(empty).toEqual(emptyBudgetScopeState());
    expect(raised.ceilings.tokens).toBe(100);
    expect(raised.overrides[0]?.id.startsWith("ovr_")).toBe(true);
    expect(raised.overrides[0]).toMatchObject({
      type: "raise_ceiling",
      dimension: "tokens",
      new_ceiling: 100,
      reason: "raise tokens",
      granted_by: "alice",
      granted_at: now,
    });
    expect(raised.overrides[0]?.old_ceiling).toBeUndefined();

    const raisedAgain = applyRaiseCeiling(raised, "tokens", 250, "bob", "raise again", later);
    expect(raisedAgain.ceilings.tokens).toBe(250);
    expect(raisedAgain.overrides[1]).toMatchObject({
      type: "raise_ceiling",
      dimension: "tokens",
      old_ceiling: 100,
      new_ceiling: 250,
      reason: "raise again",
      granted_by: "bob",
      granted_at: later,
    });

    const withOneShot = grantOneShotContinue(raisedAgain, "carol", "continue", now);
    expect(withOneShot.overrides[2]).toMatchObject({
      type: "one_shot_continue",
      reason: "continue",
      granted_by: "carol",
      granted_at: now,
      consumed: false,
    });
    expect(hasAvailableOneShot(withOneShot)).toBe(true);

    const withSecondOneShot = grantOneShotContinue(withOneShot, "dave", "continue again", later);
    const consumed = consumeOneShot(withSecondOneShot);
    expect(consumed.overrides[3]).toMatchObject({
      type: "one_shot_continue",
      consumed: true,
    });
    expect(consumed.overrides[2]).toMatchObject({
      type: "one_shot_continue",
      consumed: false,
    });
    expect(hasAvailableOneShot(consumed)).toBe(true);

    const fullyConsumed = consumeOneShot(consumed);
    expect(fullyConsumed.overrides[2]).toMatchObject({
      consumed: true,
    });
    expect(hasAvailableOneShot(fullyConsumed)).toBe(false);
  });
});

describe("budget normalization and storage", () => {
  test("normalizes missing input to the canonical empty state", () => {
    expect(emptyBudgetScopeState()).toEqual({
      ceilings: {},
      overrides: [],
      time_tracking: emptyTimeTracking(),
    });
    expect(normalizeBudgetScopeState(undefined)).toEqual(emptyBudgetScopeState());
  });

  test("normalizes numeric YAML and generates missing override ids", () => {
    const now = "2026-07-22T00:00:00.000Z";
    const normalized = normalizeBudgetScopeState({
      ceilings: { tokens: 100, cost: 5, time: 6000 },
      overrides: [
        {
          type: "one_shot_continue",
          reason: "continue",
          granted_by: "alice",
          granted_at: now,
        },
      ],
      time_tracking: { accumulated_ms: 1234, started_at: now },
    });

    expect(normalized.ceilings).toEqual({ tokens: 100, cost: 5, time: 6000 });
    expect(normalized.overrides).toHaveLength(1);
    expect(normalized.overrides[0]?.id.startsWith("ovr_")).toBe(true);
    expect(normalized.overrides[0]).toMatchObject({
      type: "one_shot_continue",
      reason: "continue",
      granted_by: "alice",
      granted_at: now,
    });
    expect(hasAvailableOneShot(normalized)).toBe(true);
    expect(normalized.time_tracking).toEqual({ accumulated_ms: 1234, started_at: now });
  });

  test("rejects non-numeric normalized ceilings", () => {
    expect(() => normalizeBudgetScopeState({ ceilings: { tokens: "100" } })).toThrow(/budget ceilings\.tokens/i);
  });

  test("round-trips roadmap and milestone budget state through storage", async () => {
    const now = "2026-07-22T00:00:00.000Z";
    const state = sampleBudgetState(now);

    await writeRoadmapBudgetState(cwd, roadmapId, state);
    expect(await loadRoadmapBudgetState(cwd, roadmapId)).toEqual(state);

    await writeMilestoneBudgetState(cwd, roadmapId, milestoneId, state);
    expect(await loadMilestoneBudgetState(cwd, roadmapId, milestoneId)).toEqual(state);
  });

  test("returns undefined for missing budget files", async () => {
    expect(await loadRoadmapBudgetState(cwd, "missing-roadmap")).toBeUndefined();
    expect(await loadMilestoneBudgetState(cwd, "missing-roadmap", "missing-milestone")).toBeUndefined();
  });
});
