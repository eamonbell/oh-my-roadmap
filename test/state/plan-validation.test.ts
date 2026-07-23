import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { validateMilestonePlan } from "@oh-my-roadmap/core/plan-validation";
import { loadState } from "@oh-my-roadmap/core/store/index";
import type { ValidationIssue } from "@oh-my-roadmap/core/types";
import { approvedMilestone, createTempRoadmapCwd, removeTempRoadmapCwd } from "./helpers";

let cwd = "";

beforeEach(async () => {
  cwd = await createTempRoadmapCwd();
});

afterEach(async () => {
  await removeTempRoadmapCwd(cwd);
  cwd = "";
});

describe("plan validation — wave ownership overlap", () => {
  // A task that lists the same path in both owned_files and owned_modules (or duplicates a
  // path within one of the arrays) must not be flagged as overlapping with itself.
  test("a task's own duplicate ownership entries do not trigger a false wave.ownership.overlap", async () => {
    await approvedMilestone(cwd);
    const state = await loadState(cwd);
    const plan = state.milestone;
    expect(plan).toBeDefined();

    const selfOverlap = {
      ...plan!,
      tasks: plan!.tasks.map((task) =>
        task.id === "t01-state"
          ? {
              ...task,
              owned_files: ["src/core/store.ts", "src/core/store.ts"],
              owned_modules: ["src/core/store.ts"],
            }
          : task,
      ),
    };

    const errors: ValidationIssue[] = [];
    validateMilestonePlan(selfOverlap, errors);
    expect(errors.map((error) => error.code)).not.toContain("wave.ownership.overlap");
  });

  // Two different tasks in the same wave claiming the same owner must still be flagged.
  test("two different tasks claiming the same owner in the same wave still trigger wave.ownership.overlap", async () => {
    await approvedMilestone(cwd);
    const state = await loadState(cwd);
    const plan = state.milestone;
    expect(plan).toBeDefined();

    const sharedOwner = "src/core/shared.ts";
    const crossOverlap = {
      ...plan!,
      tasks: plan!.tasks.map((task) =>
        task.id === "t01-state" || task.id === "t02-report"
          ? { ...task, owned_files: [sharedOwner], owned_modules: [] }
          : task,
      ),
      waves: plan!.waves.map((wave) =>
        wave.id === "w01" ? { ...wave, tasks: ["t01-state", "t02-report"] } : wave,
      ),
    };

    const errors: ValidationIssue[] = [];
    validateMilestonePlan(crossOverlap, errors);
    const overlapErrors = errors.filter((error) => error.code === "wave.ownership.overlap");
    expect(overlapErrors.length).toBeGreaterThan(0);
    expect(overlapErrors[0]?.message).toContain(sharedOwner);
  });
});
