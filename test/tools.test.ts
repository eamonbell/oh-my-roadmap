import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerRoadmapTools } from "../src/tools/register";
import { initRoadmap, transition, updateRoadmap, type UpdateRoadmapInput } from "../src/core/store";
import { decisionsPath } from "../src/core/paths";

interface RegisteredTool extends ToolDefinition {
  name: string;
  approval: "read" | "write";
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal,
    update: unknown,
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<unknown>>;
}


function roadmapInput(): UpdateRoadmapInput {
  return {
    goal: "Check transition tool roadmap milestone flow.",
    successCriteria: ["The transition tool records checker results."],
    constraints: ["Keep tool behavior aligned with core state."],
    nonGoals: ["Do not approve the roadmap from this tool test."],
    context: ["The transition tool wraps core transition input."],
    evidence: ["registerRoadmapTools exposes roadmap_engineer_transition."],
    risks: ["Schema drift could hide checker results from tool callers."],
    milestones: [
      {
        id: "m01-core",
        title: "Core milestone",
        status: "planned",
        goal: "Record the roadmap milestone check through the tool.",
        scope: ["Pass roadmapMilestoneCheck through roadmap_engineer_transition."],
        non_goals: ["Do not run implementation."],
        evidence: ["src/tools/register.ts owns the tool schema."],
        dependencies: [],
        risks: ["Tool callers may be blocked from approval if recording fails."],
        acceptance_intent: ["Tool result exposes the passed check in state details."],
        verification_intent: ["Run bun test test/tools.test.ts."],
      },
    ],
  };
}
describe("roadmap context tools", () => {
  test("registers search and read context tools as read-only tools", async () => {
    const tools = new Map<string, RegisteredTool>();
    const api = {
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI;

    registerRoadmapTools(api);

    const readStateTool = tools.get("roadmap_engineer_read_state");
    const searchTool = tools.get("roadmap_engineer_search_context");
    const readTool = tools.get("roadmap_engineer_read_context");
    const readEventsTool = tools.get("roadmap_engineer_read_events");
    const listQualityGatesTool = tools.get("roadmap_engineer_list_quality_gates");
    expect(readStateTool?.approval).toBe("read");
    expect(searchTool?.approval).toBe("read");
    expect(readTool?.approval).toBe("read");
    expect(readEventsTool?.approval).toBe("read");
    expect(listQualityGatesTool?.approval).toBe("read");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-tools-"));
    try {
      await initRoadmap(cwd, { roadmapId: "tool-roadmap", title: "Tool Roadmap" });
      await fs.writeFile(
        decisionsPath(cwd, "tool-roadmap"),
        "# Decision Register\n\n## Compact context\n\nUse snippets before full bodies.\n",
        "utf8",
      );

      const state = await readStateTool?.execute(
        "state",
        {},
        new AbortController().signal,
        undefined,
        { cwd } as ExtensionContext,
      );
      expect(state?.details).toMatchObject({
        active: { roadmap_id: "tool-roadmap" },
        roadmap: { roadmap_id: "tool-roadmap", title: "Tool Roadmap" },
      });
      expect(JSON.stringify(state?.details)).toContain("context_sections");
      expect(JSON.stringify(state?.details)).not.toContain("success_criteria");

      const search = await searchTool?.execute(
        "search",
        { artifacts: ["decisions"], query: "snippets" },
        new AbortController().signal,
        undefined,
        { cwd } as ExtensionContext,
      );
      expect(search?.details).toMatchObject({
        total: 1,
        returned: 1,
      });
      expect(JSON.stringify(search?.details)).not.toContain('"body"');

      const read = await readTool?.execute(
        "read",
        { ids: ["decisions:1"], maxBodyChars: 8 },
        new AbortController().signal,
        undefined,
        { cwd } as ExtensionContext,
      );
      expect(read?.details).toMatchObject({
        requested: 1,
        found: 1,
      });
      expect(JSON.stringify(read?.details)).toContain('"body":"## Compa"');

      const events = await readEventsTool?.execute(
        "events",
        { type: ["roadmap.initialized"] },
        new AbortController().signal,
        undefined,
        { cwd } as ExtensionContext,
      );
      expect(events?.details).toMatchObject({
        total: 1,
        returned: 1,
        events: [{ type: "roadmap.initialized" }],
      });

      const roadmapSearch = await searchTool?.execute(
        "search-roadmap",
        { artifacts: ["roadmap"], query: "not finalized" },
        new AbortController().signal,
        undefined,
        { cwd } as ExtensionContext,
      );
      expect(roadmapSearch?.details).toMatchObject({
        total: 1,
        returned: 1,
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("records roadmap milestone check through the transition tool", async () => {
    const tools = new Map<string, RegisteredTool>();
    const api = {
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI;

    registerRoadmapTools(api);
    const transitionTool = tools.get("roadmap_engineer_transition");
    const listQualityGatesTool = tools.get("roadmap_engineer_list_quality_gates");
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
        { cwd } as ExtensionContext,
      );

      expect(result?.details).toMatchObject({
        roadmap: {
          roadmap_milestone_check: {
            status: "passed",
            checked_by: "roadmap-milestone-checker",
            roadmap_revision: 1,
          },
        },
      });
      expect(JSON.stringify(result?.details)).toContain('"event_id":"evt_');

      const gates = await listQualityGatesTool?.execute(
        "quality-gates",
        { gate: "roadmap_milestone_check", status: "passed" },
        new AbortController().signal,
        undefined,
        { cwd } as ExtensionContext,
      );
      expect(gates?.details).toMatchObject({
        current: {
          status: "passed",
          roadmap_revision: 1,
        },
        history: [
          {
            type: "quality_gate.recorded",
            scope: { gate: "roadmap_milestone_check" },
            details: {
              gate_status: "passed",
              roadmap_revision: 1,
            },
          },
        ],
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
