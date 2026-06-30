import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerRoadmapTools } from "../src/tools/register";
import { initRoadmap } from "../src/core/store";
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
    expect(readStateTool?.approval).toBe("read");
    expect(searchTool?.approval).toBe("read");
    expect(readTool?.approval).toBe("read");

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
});
