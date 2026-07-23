import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { grantOneShotContinue } from "@oh-my-roadmap/core/budget";
import type { BudgetScopeState } from "@oh-my-roadmap/core/budget";
import { ensureConfig } from "@oh-my-roadmap/core/project-init";
import type { BudgetThresholdPolicy } from "@oh-my-roadmap/core/project-init";
import { roadmapsDir } from "@oh-my-roadmap/core/paths";
import { readYamlFile, writeYamlFile } from "@oh-my-roadmap/core/files";
import { emptyUsageTotals, writeUsageSummary } from "@oh-my-roadmap/core/usage";
import type { RoadmapUsageSummary, UsageTotals } from "@oh-my-roadmap/core/usage";
import {
  writeMilestoneBudgetState,
  writeRoadmapBudgetState,
} from "@oh-my-roadmap/core/store/index";
import { shouldBlockToolCall } from "@oh-my-roadmap/core/gate";
import { approvedMilestone } from "./state/helpers";

const ROADMAP_ID = "complex-refactor";
const MILESTONE_ID = "m01-core";

let cwd = "";
let home = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-budget-gate-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-budget-gate-home-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

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

// Active roadmap + milestone where the milestone token budget is hard-breached
// (550/500 = 110%, over budget) while the roadmap sits at warn (800/1000 = 80%).
async function seedHardBreached(): Promise<void> {
  await approvedMilestone(cwd);
  await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
  await writeMilestoneBudgetState(cwd, ROADMAP_ID, MILESTONE_ID, budgetWithCeilings({ tokens: 500 }));
  await writeUsageSummary(cwd, makeUsage(800, 550));
}

// Pass an isolated (empty) home so the lockout gate never reads a real global config.
function gate(toolName: string, input?: Record<string, unknown>) {
  return shouldBlockToolCall(cwd, toolName, input, home);
}

describe("budget gate with no budgets configured", () => {
  test("allows work dispatch when no budgets are configured (backward compatible)", async () => {
    await approvedMilestone(cwd);
    expect((await gate("omr_prepare_wave_dispatch", {})).block).toBe(false);
    expect((await gate("omr_prepare_worker_redispatch", {})).block).toBe(false);
    expect((await gate("task", { agent: "worker" })).block).toBe(false);
    expect((await gate("task", { tasks: [{ agent: "worker-heavy", task: "x" }] })).block).toBe(false);
  });
});

describe("hard budget limit blocks work dispatch", () => {
  beforeEach(seedHardBreached);

  test("blocks omr_prepare_wave_dispatch with an actionable reason", async () => {
    const decision = await gate("omr_prepare_wave_dispatch", {});
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("Budget hard limit");
    expect(decision.reason).toContain("milestone");
    expect(decision.reason).toContain("tokens");
    expect(decision.reason).toContain("550");
    expect(decision.reason).toContain("500");
    expect(decision.reason).toContain("110%");
    expect(decision.reason).toContain("override");
    expect(decision.reason).toContain("one-shot");
  });

  test("blocks omr_prepare_wave_dispatch dispatched via the xd:// device", async () => {
    const decision = await gate("write", {
      path: "xd://omr_prepare_wave_dispatch",
      content: JSON.stringify({}),
    });
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("Budget hard limit");
  });

  test("blocks omr_prepare_worker_redispatch with an actionable reason", async () => {
    const decision = await gate("omr_prepare_worker_redispatch", {});
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("Budget hard limit");
  });

  test("blocks a worker task spawn (flat agent form)", async () => {
    const decision = await gate("task", { agent: "worker" });
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("Budget hard limit");
  });

  test("blocks a worker task spawn (batch form)", async () => {
    const decision = await gate("task", {
      context: "wave 2",
      tasks: [{ agent: "worker-light", task: "implement gate" }],
    });
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("Budget hard limit");
  });
});

describe("hard limit does not block non-dispatch surfaces", () => {
  beforeEach(seedHardBreached);

  test("allows read-only omr tools", async () => {
    for (const tool of [
      "omr_read_state",
      "omr_list_blockers",
      "omr_search_context",
      "omr_read_context",
      "omr_read_events",
      "omr_validate",
      "omr_render_report",
      "omr_next_action",
      "omr_style_guide",
      "omr_prepare_closeout",
      "omr_render_dependency_graph",
    ]) {
      expect((await gate(tool, {})).block).toBe(false);
    }
  });

  test("allows record_*, review, and blocker tools", async () => {
    for (const tool of [
      "omr_record_wave_result",
      "omr_record_worker_dispatch",
      "omr_prepare_wave_review",
      "omr_record_wave_review",
      "omr_open_blocker",
      "omr_resolve_blocker",
      "omr_append_note",
    ]) {
      expect((await gate(tool, {})).block).toBe(false);
    }
  });

  test("does not budget-gate non-worker task spawns (reviewer, checker)", async () => {
    expect((await gate("task", { agent: "reviewer" })).block).toBe(false);
    expect((await gate("task", { agent: "wave-flow-checker" })).block).toBe(false);
    expect((await gate("task", { tasks: [{ agent: "reviewer", task: "review" }] })).block).toBe(false);
  });
});

describe("one-shot continue allows dispatch through a hard limit", () => {
  test("a one-shot at either scope lets work dispatch proceed", async () => {
    await approvedMilestone(cwd);
    // Milestone hard-breached (550/500); roadmap at warn (800/1000).
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeMilestoneBudgetState(cwd, ROADMAP_ID, MILESTONE_ID, budgetWithCeilings({ tokens: 500 }));
    await writeUsageSummary(cwd, makeUsage(800, 550));

    // Before the one-shot: dispatch is blocked.
    expect((await gate("omr_prepare_wave_dispatch", {})).block).toBe(true);

    // Grant a one-shot on the ROADMAP scope (not the breached milestone) — either
    // scope's one-shot is enough to let the dispatch through.
    const now = "2026-07-22T00:00:00.000Z";
    const roadmapBudget = grantOneShotContinue(
      budgetWithCeilings({ tokens: 1000 }),
      "alice",
      "continue",
      now,
    );
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, roadmapBudget);

    expect((await gate("omr_prepare_wave_dispatch", {})).block).toBe(false);
    expect((await gate("task", { agent: "worker" })).block).toBe(false);
  });
});

describe("soft and warn levels never block dispatch", () => {
  test("warn-level breach does not block dispatch", async () => {
    await approvedMilestone(cwd);
    // 800/1000 = 80% → warn (default warn 75, hard 100).
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(800, 0));
    expect((await gate("omr_prepare_wave_dispatch", {})).block).toBe(false);
    expect((await gate("task", { agent: "worker" })).block).toBe(false);
  });

  test("soft-level breach does not block dispatch", async () => {
    await approvedMilestone(cwd);
    await setThresholds({ warn: 50, soft: 70, hard: 90 });
    // 750/1000 = 75% → soft (>= 70 soft, < 90 hard).
    await writeRoadmapBudgetState(cwd, ROADMAP_ID, budgetWithCeilings({ tokens: 1000 }));
    await writeUsageSummary(cwd, makeUsage(750, 0));
    expect((await gate("omr_prepare_wave_dispatch", {})).block).toBe(false);
    expect((await gate("task", { agent: "worker" })).block).toBe(false);
  });
});
