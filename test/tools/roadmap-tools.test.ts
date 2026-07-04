import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readYamlFile, writeYamlFile } from "@oh-my-roadmap/core/files";
import { roadmapStatePath } from "@oh-my-roadmap/core/paths";
import { initRoadmap, loadState, transition, updateRoadmap } from "@oh-my-roadmap/core/store/index";
import type { RoadmapState } from "@oh-my-roadmap/core/types";
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

      // Default result is a compact transition receipt, not the full loaded state.
      expect(result?.details).toMatchObject({
        operation: "record_roadmap_milestone_check",
        event_type: "quality_gate.recorded",
        scope: { gate: "roadmap_milestone_check" },
        after: {
          status: "passed",
          checked_by: "roadmap-milestone-checker",
          roadmap_revision: 2,
        },
      });
      expect(result?.details).not.toHaveProperty("roadmap");
      expect(result?.details).toHaveProperty("next_actions");
      expect(result?.details).toHaveProperty("summary");
      expect(result?.details).toHaveProperty("before");
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

  test("returnScope state restores the full loaded-state shape plus next_actions", async () => {
    const tools = registerTools();
    const transitionTool = registeredTool(tools, "omr_transition");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-return-scope-"));
    try {
      await initRoadmap(cwd, { roadmapId: "return-scope-roadmap", title: "Return Scope Roadmap" });
      await transition(cwd, {
        operation: "record_discovery",
        discovery: { findings: ["Inspected return-scope wiring."] },
      });
      await updateRoadmap(cwd, roadmapInput());
      await transition(cwd, {
        operation: "record_roadmap_milestone_check",
        roadmapMilestoneCheck: {
          status: "passed",
          checkedBy: "roadmap-milestone-checker",
          summary: "Milestone flow is coherent and buildable.",
          findings: [],
        },
      });
      await transition(cwd, { operation: "approve_roadmap", approver: "user" });

      const started = await transitionTool?.execute(
        "transition-return-scope",
        { operation: "start_milestone_planning", returnScope: "state" },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      // returnScope: "state" returns the old top-level full loaded-state shape.
      expect(started?.details).toMatchObject({
        roadmap: { roadmap_id: "return-scope-roadmap", phase: "milestone_planning" },
      });
      expect(started?.details).toHaveProperty("next_actions");
      // Receipt-only fields are not surfaced at the top level in state scope.
      expect(started?.details).not.toHaveProperty("event_id");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects irrelevant operation fields and accepts the bare valid payload", async () => {
    const tools = registerTools();
    const transitionTool = registeredTool(tools, "omr_transition");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-strict-input-"));
    try {
      await initRoadmap(cwd, { roadmapId: "strict-input-roadmap", title: "Strict Input Roadmap" });
      await transition(cwd, {
        operation: "record_discovery",
        discovery: { findings: ["Inspected strict input wiring."] },
      });
      await updateRoadmap(cwd, roadmapInput());
      await transition(cwd, {
        operation: "record_roadmap_milestone_check",
        roadmapMilestoneCheck: {
          status: "passed",
          checkedBy: "roadmap-milestone-checker",
          summary: "Milestone flow is coherent and buildable.",
          findings: [],
        },
      });
      await transition(cwd, { operation: "approve_roadmap", approver: "user" });

      // start_milestone_planning accepts no operation-specific fields; `milestone` is irrelevant
      // and must be rejected before the core state machine runs, with a focused message.
      await expect(
        transitionTool?.execute(
          "transition-strict-reject",
          { operation: "start_milestone_planning", milestone: { milestoneId: "m01-core" } },
          new AbortController().signal,
          undefined,
          toolContext(cwd),
        ),
      ).rejects.toThrow("Operation start_milestone_planning does not accept field milestone.");

      // The bare valid payload succeeds in the roadmap_approved phase.
      const started = await transitionTool?.execute(
        "transition-strict-accept",
        { operation: "start_milestone_planning" },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(started?.details).toMatchObject({ operation: "start_milestone_planning" });
      expect((await loadState(cwd)).roadmap?.phase).toBe("milestone_planning");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("surfaces the next executable action on transition and validate tool success", async () => {
    const tools = registerTools();
    const transitionTool = registeredTool(tools, "omr_transition");
    const validateTool = registeredTool(tools, "omr_validate");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-next-action-tool-"));
    try {
      await initRoadmap(cwd, { roadmapId: "tool-next-action-roadmap", title: "Tool Next Action Roadmap" });
      await transition(cwd, {
        operation: "record_discovery",
        discovery: { findings: ["Inspected next-action wiring."] },
      });
      await updateRoadmap(cwd, roadmapInput());
      await transition(cwd, {
        operation: "record_roadmap_milestone_check",
        roadmapMilestoneCheck: {
          status: "passed",
          checkedBy: "roadmap-milestone-checker",
          summary: "Milestone flow is coherent and buildable.",
          findings: [],
        },
      });

      const approved = await transitionTool?.execute(
        "transition-approve",
        { operation: "approve_roadmap", approver: "user" },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      const approvedActions = (approved?.details as {
        next_actions?: Array<{ label: string; tool: { name: string; input: { operation?: string } } }>;
      } | undefined)?.next_actions;
      expect(approvedActions?.[0]?.label).toBe("Start milestone planning");
      expect(approvedActions?.[0]?.tool.name).toBe("omr_transition");
      expect(approvedActions?.[0]?.tool.input.operation).toBe("start_milestone_planning");

      const validated = await validateTool?.execute(
        "validate",
        {},
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      const validatedActions = (validated?.details as {
        valid?: boolean;
        next_actions?: Array<{ tool: { input: { operation?: string } } }>;
      } | undefined);
      expect(validatedActions?.valid).toBe(true);
      expect(validatedActions?.next_actions?.[0]?.tool.input.operation).toBe("start_milestone_planning");
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
