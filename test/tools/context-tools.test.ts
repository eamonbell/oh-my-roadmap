import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decisionsPath } from "@oh-my-roadmap/core/paths";
import { initRoadmap } from "@oh-my-roadmap/core/store/index";
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
});
