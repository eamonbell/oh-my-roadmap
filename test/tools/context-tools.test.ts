import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decisionsPath } from "../../src/core/paths";
import { initRoadmap } from "../../src/core/store/index";
import { registeredTool, registerTools, toolContext } from "./helpers";

describe("roadmap context tools", () => {
  test("registers search and read context tools as read-only tools", () => {
    const tools = registerTools();

    const readStateTool = registeredTool(tools, "roadmap_engineer_read_state");
    const searchTool = registeredTool(tools, "roadmap_engineer_search_context");
    const readTool = registeredTool(tools, "roadmap_engineer_read_context");
    const readEventsTool = registeredTool(tools, "roadmap_engineer_read_events");
    const listQualityGatesTool = registeredTool(tools, "roadmap_engineer_list_quality_gates");
    const nextActionTool = registeredTool(tools, "roadmap_engineer_next_action");
    expect(readStateTool?.approval).toBe("read");
    expect(searchTool?.approval).toBe("read");
    expect(readTool?.approval).toBe("read");
    expect(readEventsTool?.approval).toBe("read");
    expect(listQualityGatesTool?.approval).toBe("read");
    expect(nextActionTool?.approval).toBe("read");
  });

  test("reads and searches compact context without exposing full roadmap state", async () => {
    const tools = registerTools();

    const readStateTool = registeredTool(tools, "roadmap_engineer_read_state");
    const searchTool = registeredTool(tools, "roadmap_engineer_search_context");
    const readTool = registeredTool(tools, "roadmap_engineer_read_context");
    const readEventsTool = registeredTool(tools, "roadmap_engineer_read_events");
    const nextActionTool = registeredTool(tools, "roadmap_engineer_next_action");

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
        action: "Resolve validation errors: Roadmap must be finalized with roadmap_engineer_update_roadmap before approval",
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
