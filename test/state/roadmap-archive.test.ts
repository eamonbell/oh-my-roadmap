import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readRoadmapEvents } from "../../src/core/events";
import { fileExists } from "../../src/core/files";
import { activePointerPath } from "../../src/core/paths";
import {
  clearActivePointer,
  initRoadmap,
  loadState,
} from "../../src/core/store/index";
import {
  approvedRoadmap as approvedRoadmapForCwd,
  createTempRoadmapCwd,
  manuallyWriteRoadmapState as manuallyWriteRoadmapStateForCwd,
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

describe("new-roadmap lifecycle (auto-archive)", () => {
  test("clearActivePointer removes the active pointer", async () => {
    await approvedRoadmapForCwd(cwd);
    expect(await fileExists(activePointerPath(cwd))).toBe(true);

    await clearActivePointer(cwd);
    expect(await fileExists(activePointerPath(cwd))).toBe(false);
  });

  test("creating a new roadmap after the active one is complete archives the old one and succeeds", async () => {
    await approvedRoadmapForCwd(cwd);
    await manuallyWriteRoadmapStateForCwd(cwd, (roadmap) => {
      roadmap.phase = "complete";
      delete roadmap.active_change_request_id;
    });

    const next = await initRoadmap(cwd, { roadmapId: "next-roadmap", title: "Next Roadmap" });
    expect(next.roadmap_id).toBe("next-roadmap");

    const state = await loadState(cwd);
    expect(state.active?.roadmap_id).toBe("next-roadmap");

    const archived = await readRoadmapEvents(cwd, {
      roadmapId: "complex-refactor",
      type: ["roadmap.archived"],
    });
    expect(archived.events).toHaveLength(1);
    expect(archived.events[0]?.scope.roadmap_id).toBe("complex-refactor");

    // Old roadmap files are preserved as history.
    const oldEvents = await readRoadmapEvents(cwd, { roadmapId: "complex-refactor" });
    expect(oldEvents.total).toBeGreaterThan(0);
  });

  test("creating a new roadmap while the active one is NOT complete still throws", async () => {
    await approvedRoadmapForCwd(cwd);

    await expect(
      initRoadmap(cwd, { roadmapId: "next-roadmap", title: "Next Roadmap" }),
    ).rejects.toThrow(/is already active/);
  });

  test("a completed roadmap with an active change request is not auto-archived", async () => {
    await approvedRoadmapForCwd(cwd);
    await manuallyWriteRoadmapStateForCwd(cwd, (roadmap) => {
      roadmap.phase = "complete";
      roadmap.active_change_request_id = "cr01-followup";
    });

    await expect(
      initRoadmap(cwd, { roadmapId: "next-roadmap", title: "Next Roadmap" }),
    ).rejects.toThrow(/is already active/);
  });
});
