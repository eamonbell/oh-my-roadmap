import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readYamlFile, writeYamlFile } from "oh-my-roadmap-core/files";
import { roadmapStatePath } from "oh-my-roadmap-core/paths";
import { initRoadmap, loadState, transition, updateRoadmap } from "oh-my-roadmap-core/store/index";
import type { RoadmapState } from "oh-my-roadmap-core/types";
import { registeredTool, registerTools, roadmapInput, toolContext } from "./helpers";

describe("roadmap lifecycle tools", () => {
  test("records roadmap milestone check through the transition tool", async () => {
    const tools = registerTools();
    const transitionTool = registeredTool(tools, "omr_transition");
    const listQualityGatesTool = registeredTool(tools, "omr_list_quality_gates");
    expect(transitionTool?.approval).toBe("write");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-transition-tool-"));
    try {
      await initRoadmap(cwd, { roadmapId: "tool-transition-roadmap", title: "Tool Transition Roadmap" });
      await transition(cwd, {
        operation: "record_discovery",
        discovery: { findings: ["Inspected transition tool wiring."] },
      });
      await updateRoadmap(cwd, roadmapInput());

      const result = await transitionTool?.execute(
        "transition",
        {
          operation: "record_roadmap_milestone_check",
          roadmapMilestoneCheck: {
            status: "passed",
            checkedBy: "roadmap-milestone-checker",
            summary: "Milestone flow is coherent and buildable.",
            findings: [],
          },
        },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );

      expect(result?.details).toMatchObject({
        roadmap: {
          roadmap_milestone_check: {
            status: "passed",
            checked_by: "roadmap-milestone-checker",
            roadmap_revision: 2,
          },
        },
      });
      expect(JSON.stringify(result?.details)).toContain('"event_id":"evt_');

      const gates = await listQualityGatesTool?.execute(
        "quality-gates",
        { gate: "roadmap_milestone_check", status: "passed" },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(gates?.details).toMatchObject({
        current: {
          status: "passed",
          roadmap_revision: 2,
        },
        history: [
          {
            type: "quality_gate.recorded",
            scope: { gate: "roadmap_milestone_check" },
            details: {
              gate_status: "passed",
              roadmap_revision: 2,
            },
          },
        ],
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("repairs roadmap hash drift through the repair tool", async () => {
    const tools = registerTools();
    const repairRoadmapTool = registeredTool(tools, "omr_repair_roadmap");
    const listQualityGatesTool = registeredTool(tools, "omr_list_quality_gates");
    expect(repairRoadmapTool?.approval).toBe("write");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-repair-tool-"));
    try {
      await initRoadmap(cwd, { roadmapId: "tool-repair-roadmap", title: "Tool Repair Roadmap" });
      await transition(cwd, {
        operation: "record_discovery",
        discovery: { findings: ["Inspected repair tool wiring."] },
      });
      await updateRoadmap(cwd, roadmapInput());
      await transition(cwd, {
        operation: "record_roadmap_milestone_check",
        roadmapMilestoneCheck: {
          status: "passed",
          checkedBy: "roadmap-milestone-checker",
          summary: "Initial milestone flow is coherent.",
          findings: [],
        },
      });
      await transition(cwd, { operation: "approve_roadmap", approver: "user" });

      const before = await loadState(cwd);
      if (!before.roadmap) throw new Error("Expected roadmap state");
      const statePath = roadmapStatePath(cwd, before.roadmap.roadmap_id);
      const raw = await readYamlFile<RoadmapState>(statePath);
      raw.context = ["Manual recovery changed context before tool repair."];
      await writeYamlFile(statePath, raw);

      const result = await repairRoadmapTool?.execute(
        "repair",
        {
          reason: "Manual state recovery changed roadmap context.",
          actor: "repair-tool-test",
          roadmapMilestoneCheck: {
            status: "passed",
            checkedBy: "roadmap-milestone-checker",
            summary: "Fresh checker pass after repair.",
            findings: [],
          },
        },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );

      expect(result?.details).toMatchObject({
        previous_revision: before.roadmap.roadmap_revision,
        current_revision: before.roadmap.roadmap_revision + 1,
        content_hash_changed: true,
        roadmap_doc_rewritten: true,
        gate_action: "recorded_passed",
      });

      const gates = await listQualityGatesTool?.execute(
        "quality-gates",
        { gate: "roadmap_milestone_check", status: "passed", limit: 1 },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(gates?.details).toMatchObject({
        current: {
          status: "passed",
          roadmap_revision: before.roadmap.roadmap_revision + 1,
        },
        history: [
          {
            operation: "repair_roadmap",
            details: {
              gate_status: "passed",
              repair_event_id: (result?.details as { repair_event_id?: string } | undefined)?.repair_event_id,
            },
          },
        ],
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
