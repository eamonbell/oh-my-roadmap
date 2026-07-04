import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decisionsPath } from "@oh-my-roadmap/core/paths";
import { initRoadmap, transition } from "@oh-my-roadmap/core/store/index";
import { approvedMilestone, createTempRoadmapCwd, removeTempRoadmapCwd } from "../state/helpers";
import { registeredTool, registerTools, toolContext } from "./helpers";

describe("roadmap context tools", () => {
  test("registers search and read context tools as read-only tools", () => {
    const tools = registerTools();

    const readStateTool = registeredTool(tools, "omr_read_state");
    const searchTool = registeredTool(tools, "omr_search_context");
    const readTool = registeredTool(tools, "omr_read_context");
    const readEventsTool = registeredTool(tools, "omr_read_events");
    const listQualityGatesTool = registeredTool(tools, "omr_list_quality_gates");
    const nextActionTool = registeredTool(tools, "omr_next_action");
    expect(readStateTool?.approval).toBe("read");
    expect(searchTool?.approval).toBe("read");
    expect(readTool?.approval).toBe("read");
    expect(readEventsTool?.approval).toBe("read");
    expect(listQualityGatesTool?.approval).toBe("read");
    expect(nextActionTool?.approval).toBe("read");
  });

  test("serializes agent-facing tool text compactly while details stay structured", async () => {
    const tools = registerTools();
    const readStateTool = registeredTool(tools, "omr_read_state");
    const searchTool = registeredTool(tools, "omr_search_context");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-compact-"));
    try {
      await initRoadmap(cwd, { roadmapId: "compact-roadmap", title: "Compact Roadmap" });

      const state = await readStateTool?.execute(
        "state",
        {},
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      const firstText = (result: unknown): string => {
        const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
        return content.find((entry) => entry.type === "text")?.text ?? "";
      };
      const stateText = firstText(state);
      // Compact: no pretty-print indentation/newlines in the agent-facing text.
      expect(stateText).not.toContain("\n");
      expect(stateText).not.toContain("  ");
      // The parsed text still matches the structured details rendered for the UI.
      expect(JSON.parse(stateText)).toEqual(state?.details);

      const search = await searchTool?.execute(
        "search",
        { artifacts: ["roadmap"] },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      const searchText = firstText(search);
      expect(searchText).not.toContain("\n");
      expect(JSON.parse(searchText)).toEqual(search?.details);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("reads and searches compact context without exposing full roadmap state", async () => {
    const tools = registerTools();

    const readStateTool = registeredTool(tools, "omr_read_state");
    const searchTool = registeredTool(tools, "omr_search_context");
    const readTool = registeredTool(tools, "omr_read_context");
    const readEventsTool = registeredTool(tools, "omr_read_events");
    const nextActionTool = registeredTool(tools, "omr_next_action");

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
        toolContext(cwd),
      );
      expect(state?.details).toMatchObject({
        active: { roadmap_id: "tool-roadmap" },
        roadmap: { roadmap_id: "tool-roadmap", title: "Tool Roadmap" },
      });
      expect(JSON.stringify(state?.details)).toContain("context_sections");
      expect(JSON.stringify(state?.details)).not.toContain("success_criteria");

      const nextAction = await nextActionTool?.execute(
        "next-action",
        {},
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(nextAction?.details).toMatchObject({
        action: "Resolve validation errors: Roadmap must be finalized with omr_update_roadmap before approval",
        plan: {
          label: "Resolve validation errors",
          status: "needs_input",
          safe_to_apply: false,
        },
      });

      const search = await searchTool?.execute(
        "search",
        { artifacts: ["decisions"], query: "snippets" },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
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
        toolContext(cwd),
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
        toolContext(cwd),
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
        toolContext(cwd),
      );
      expect(roadmapSearch?.details).toMatchObject({
        total: 1,
        returned: 1,
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("narrow read-state scopes return only their own payloads", async () => {
    const readStateTool = registeredTool(registerTools(), "omr_read_state");
    const cwd = await createTempRoadmapCwd();
    try {
      await approvedMilestone(cwd);
      await transition(cwd, { operation: "start_implementation" });

      const read = async (scope: string): Promise<Record<string, unknown>> => {
        const result = await readStateTool?.execute(
          "state",
          { scope },
          new AbortController().signal,
          undefined,
          toolContext(cwd),
        );
        return result?.details as Record<string, unknown>;
      };

      const phase = await read("phase");
      expect(phase.roadmap).toMatchObject({ roadmap_id: "complex-refactor", phase: "implementing" });
      expect(JSON.stringify(phase)).not.toContain('"discovery"');
      expect(JSON.stringify(phase)).not.toContain('"milestones"');

      const progress = await read("progress");
      expect(progress).toHaveProperty("progress");
      expect(progress).toHaveProperty("task_counts");
      expect(progress).toHaveProperty("wave_counts");
      expect(JSON.stringify(progress)).not.toContain("implementation_notes");

      const gates = await read("quality_gates");
      expect(gates).toHaveProperty("roadmap_milestone_check");
      expect(gates).toHaveProperty("wave_flow_check");

      const outlines = await read("milestone_outlines");
      const outlineMilestones = outlines.milestones as Array<Record<string, unknown>>;
      expect(outlineMilestones[0]).toHaveProperty("scope_items");
      expect(JSON.stringify(outlines)).not.toContain("implementation_notes");

      const closeout = await read("closeout_requirements");
      const acceptance = closeout.acceptance as Array<{ id: string; item: string }>;
      const verification = closeout.verification as Array<{ id: string; item: string }>;
      expect(acceptance[0]).toMatchObject({ id: "acceptance:1", item: "State validates" });
      expect(verification[0]).toMatchObject({ id: "verification:1", item: "bun test" });

      const roadmapPkg = await read("roadmap_checker_package");
      const roadmapPkgRoadmap = roadmapPkg.roadmap as Record<string, unknown>;
      expect(roadmapPkgRoadmap).toHaveProperty("roadmap_milestone_check_status");
      expect(roadmapPkgRoadmap).not.toHaveProperty("discovery");
      expect(roadmapPkgRoadmap).not.toHaveProperty("success_criteria");
      expect(roadmapPkgRoadmap).not.toHaveProperty("open_questions");
      const pkgMilestones = roadmapPkg.milestones as Array<Record<string, unknown>>;
      expect(pkgMilestones[0]).toHaveProperty("goal");
      expect(pkgMilestones[0]).toHaveProperty("scope");

      const wavePkg = await read("wave_flow_checker_package");
      const wavePlan = wavePkg.plan as Record<string, unknown>;
      expect(wavePlan).toHaveProperty("acceptance_criteria");
      expect(wavePlan).toHaveProperty("verification_commands");
      const wavePkgTasks = wavePkg.tasks as Array<Record<string, unknown>>;
      expect(wavePkgTasks[0]).toHaveProperty("done_criteria");
      expect(JSON.stringify(wavePkg)).not.toContain("implementation_notes");
      expect(JSON.stringify(wavePkg)).not.toContain("user_interview");
    } finally {
      await removeTempRoadmapCwd(cwd);
    }
  });

  test("search modes control result density: count, ids, and bodies", async () => {
    const searchTool = registeredTool(registerTools(), "omr_search_context");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-search-modes-"));
    try {
      await initRoadmap(cwd, { roadmapId: "search-modes", title: "Search Modes" });
      await fs.writeFile(
        decisionsPath(cwd, "search-modes"),
        "# Decision Register\n\n## Staged search\n\nPrefer count and ids before snippets and full bodies.\n",
        "utf8",
      );

      const search = (params: Record<string, unknown>) =>
        searchTool?.execute("search", params, new AbortController().signal, undefined, toolContext(cwd));

      const count = await search({ artifacts: ["decisions"], mode: "count" });
      expect(count?.details).toMatchObject({ total: 1, returned: 0 });
      expect((count?.details as { results: unknown[] }).results).toEqual([]);

      const ids = await search({ artifacts: ["decisions"], mode: "ids" });
      expect(ids?.details).toMatchObject({ total: 1, returned: 1 });
      const idResults = (ids?.details as { results: Array<Record<string, unknown>> }).results;
      expect(idResults[0]?.id).toBe("decisions:1");
      expect(idResults[0]?.snippet).toBe("");
      expect(idResults[0]).not.toHaveProperty("body");
      expect(JSON.stringify(ids?.details)).not.toContain('"body"');

      const bodies = await search({ artifacts: ["decisions"], mode: "bodies", maxBodyChars: 8 });
      const bodyResults = (bodies?.details as { results: Array<Record<string, unknown>> }).results;
      expect((bodyResults[0]?.body as string).length).toBeLessThanOrEqual(8);
      expect(bodyResults[0]?.bodyTruncated).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
