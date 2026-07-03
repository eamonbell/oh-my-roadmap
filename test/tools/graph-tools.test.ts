import { describe, expect, test } from "bun:test";
import { approvedMilestone, createTempRoadmapCwd, removeTempRoadmapCwd } from "../state/helpers";
import { renderMilestoneDependencyGraph } from "oh-my-roadmap-core/plan-validation";
import { registeredTool, registerTools, toolContext } from "./helpers";

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
  return content.find((entry) => entry.type === "text")?.text ?? "";
}

describe("render dependency graph tool", () => {
  test("registers as a read-only tool", () => {
    const tools = registerTools();
    const tool = registeredTool(tools, "omr_render_dependency_graph");
    expect(tool?.approval).toBe("read");
  });

  test("emits Mermaid with a node per task and an edge per depends_on", async () => {
    const tools = registerTools();
    const tool = registeredTool(tools, "omr_render_dependency_graph");
    const cwd = await createTempRoadmapCwd();
    try {
      await approvedMilestone(cwd);
      const result = await tool?.execute("graph", {}, new AbortController().signal, undefined, toolContext(cwd));
      const mermaid = firstText(result);

      expect(mermaid.startsWith("graph TD")).toBe(true);
      // One node per task, labelled with id + title.
      expect(mermaid).toContain('["t01-state: State engine"]');
      expect(mermaid).toContain('["t02-report: Report engine"]');
      // Node ids are index-based and stable (insertion order).
      expect(mermaid).toContain('n0["t01-state: State engine"]');
      expect(mermaid).toContain('n1["t02-report: Report engine"]');
      // Edge: t01-state (dependency) --> t02-report (dependent).
      expect(mermaid).toContain("n0 --> n1");

      const details = (result as { details?: { milestone_id?: string; task_count?: number; mermaid?: string } }).details;
      expect(details?.milestone_id).toBe("m01-core");
      expect(details?.task_count).toBe(2);
      expect(details?.mermaid).toBe(mermaid);
    } finally {
      await removeTempRoadmapCwd(cwd);
    }
  });

  test("returns an empty-plan placeholder when there are no tasks", () => {
    expect(renderMilestoneDependencyGraph([])).toContain('empty["No tasks in active plan"]');
  });
});
