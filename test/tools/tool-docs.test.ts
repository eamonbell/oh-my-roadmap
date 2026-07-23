import { describe, expect, test } from "bun:test";
import { registeredTool, registerTools } from "./helpers";

describe("omr tool documentation", () => {
  test("omr_transition description states phase preconditions for representative operations", () => {
    const tools = registerTools();
    const transitionTool = registeredTool(tools, "omr_transition");
    expect(transitionTool).toBeDefined();
    const description = transitionTool?.description ?? "";

    // record_discovery: packages/core/src/store/plans.ts:268
    expect(description).toContain("record_discovery requires phase discovery or roadmap_draft");
    // start_milestone_planning: packages/core/src/store/plans.ts:342
    expect(description).toContain("start_milestone_planning requires phase roadmap_approved or complete");
    // approve_roadmap: packages/core/src/store/plans.ts:291 (requirePhase(..., 'roadmap_draft', ...))
    expect(description).toContain("approve_roadmap requires phase roadmap_draft");
    // start_closeout: packages/core/src/store/plans.ts:433
    expect(description).toContain("start_closeout requires phase reviewing");
  });

  test("high-friction write tools document a canonical xd:// invocation example", () => {
    const tools = registerTools();

    const transitionTool = registeredTool(tools, "omr_transition");
    const initTool = registeredTool(tools, "omr_init");
    const updateRoadmapTool = registeredTool(tools, "omr_update_roadmap");

    expect(transitionTool).toBeDefined();
    expect(initTool).toBeDefined();
    expect(updateRoadmapTool).toBeDefined();

    expect(transitionTool?.description ?? "").toContain("write xd://omr_transition");
    expect(initTool?.description ?? "").toContain("write xd://omr_init");
    expect(updateRoadmapTool?.description ?? "").toContain("write xd://omr_update_roadmap");
  });
});
