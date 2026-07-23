import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionContext, ExtensionWidgetContent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { loadBudgetSummary } from "@oh-my-roadmap/core/budget-report";
import { writeRoadmapBudgetState } from "@oh-my-roadmap/core/store/index";
import { emptyUsageTotals, writeUsageSummary } from "@oh-my-roadmap/core/usage";
import { appendBudgetSummaryMarkdown } from "../../packages/extension/src/tools/register/findings-report-tool";
import { approvedMilestone, createTempRoadmapCwd, removeTempRoadmapCwd } from "../state/helpers";
import { registeredTool, registerTools, toolContext } from "./helpers";

const ROADMAP_ID = "complex-refactor";
const MILESTONE_ID = "m01-core";

let cwd = "";

beforeEach(async () => {
  cwd = await createTempRoadmapCwd();
  await approvedMilestone(cwd);
});

afterEach(async () => {
  await removeTempRoadmapCwd(cwd);
});

async function configureBudget(): Promise<void> {
  await writeRoadmapBudgetState(cwd, ROADMAP_ID, {
    ceilings: { tokens: 100, cost: 20, time: 60_000 },
    overrides: [{
      id: "override-raise",
      type: "raise_ceiling",
      dimension: "tokens",
      old_ceiling: 50,
      new_ceiling: 100,
      reason: "finish review",
      granted_by: "alice",
      granted_at: "2026-07-22T12:00:00.000Z",
    }],
    time_tracking: { accumulated_ms: 90_000 },
  });
  await writeUsageSummary(cwd, {
    roadmap_id: ROADMAP_ID,
    total: { ...emptyUsageTotals(), input_tokens: 125, estimated_usd: 10 },
    by_agent: {},
    dedupe_keys: [],
    milestones: {
      [MILESTONE_ID]: {
        total: emptyUsageTotals(),
        by_agent: {},
        change_requests: {},
      },
    },
  });
}

async function renderedSubmission(markdown: string): Promise<string> {
  const tool = registeredTool(registerTools(), "omr_submit_findings_report");
  let widget: ExtensionWidgetContent | undefined;
  const result = await tool?.execute(
    "findings-report",
    { title: "Findings", markdown },
    new AbortController().signal,
    undefined,
    {
      cwd,
      hasUI: true,
      ui: {
        setWidget(_key: string, content: ExtensionWidgetContent) {
          widget = content;
        },
      },
    } as ExtensionContext,
  );
  const theme = await getThemeByName("dark");
  if (!theme) throw new Error("Expected built-in dark theme");
  if (typeof widget !== "function") throw new Error("Expected widget factory");

  expect(result?.details).toEqual({ success: true });
  return widget({} as never, theme).render(200).join("\n");
}

describe("findings report tool", () => {
  test("registers as a read-only roadmap tool", () => {
    const tools = registerTools();

    const tool = registeredTool(tools, "omr_submit_findings_report");

    expect(tool?.approval).toBe("read");
  });

  test("returns failure details when UI is unavailable", async () => {
    const tools = registerTools();
    const tool = registeredTool(tools, "omr_submit_findings_report");

    const result = await tool?.execute(
      "findings-report",
      { title: "Findings", markdown: "## Summary\n\nNo UI available." },
      new AbortController().signal,
      undefined,
      toolContext("/tmp"),
    );

    expect(result?.details).toEqual({
      success: false,
      error: "UI unavailable",
    });
  });

  test("renders the widget with the active UI theme", async () => {
    const tools = registerTools();
    const tool = registeredTool(tools, "omr_submit_findings_report");
    let widget: ExtensionWidgetContent;

    const result = await tool?.execute(
      "findings-report",
      { title: "Findings", markdown: "## Summary\n\n- First finding" },
      new AbortController().signal,
      undefined,
      {
        cwd,
        hasUI: true,
        ui: {
          setWidget(_key: string, content: ExtensionWidgetContent) {
            widget = content;
          },
        },
      } as ExtensionContext,
    );

    const theme = await getThemeByName("dark");
    if (!theme) throw new Error("Expected built-in dark theme");
    if (typeof widget !== "function") throw new Error("Expected widget factory");

    const component = widget({} as never, theme);
    const lines = component.render(80);

    expect(result?.details).toEqual({ success: true });
    expect(lines.join("\n")).toContain("Findings");
    expect(lines.join("\n")).toContain("First finding");
  });

  test("preserves caller Markdown exactly without configured budgets", async () => {
    const markdown = "## Summary\n\n- Exact caller content";
    const summary = await loadBudgetSummary(cwd);

    expect(summary.scopes).toEqual([]);
    expect(appendBudgetSummaryMarkdown(markdown, summary)).toBe(markdown);
  });

  test("appends configured budget dimensions and overrides once per independent submission", async () => {
    await configureBudget();
    const summary = await loadBudgetSummary(cwd);
    const markdown = appendBudgetSummaryMarkdown("## Summary\n\n- First finding", summary);

    expect(markdown.match(/^## Budget$/gm) ?? []).toHaveLength(1);
    expect(markdown).toContain(
      "- Budget roadmap tokens: spent 125 tokens; ceiling 100 tokens; remaining -25 tokens; 125% used; level hard, over budget",
    );
    expect(markdown).toContain(
      "- Budget roadmap cost: spent $10.0000; ceiling $20.0000; remaining $10.0000; 50% used; level none",
    );
    expect(markdown).toContain(
      "- Budget roadmap time: spent 1m 30s; ceiling 1m; remaining -30s; 150% used; level hard, over budget",
    );
    expect(markdown).toContain(
      "- Budget roadmap overrides: 1 total; 0 one-shots available; latest raise tokens ceiling by alice at 2026-07-22T12:00:00.000Z: finish review",
    );

    const first = await renderedSubmission("## Summary\n\n- First finding");
    const second = await renderedSubmission("## Summary\n\n- Second finding");

    expect(first).toContain("First finding");
    expect(second).toContain("Second finding");
    expect(first.match(/Budget roadmap tokens/g) ?? []).toHaveLength(1);
    expect(second.match(/Budget roadmap tokens/g) ?? []).toHaveLength(1);
  });

  test("clears the widget on session shutdown", async () => {
    const tools = registerTools();
    const tool = registeredTool(tools, "omr_submit_findings_report");
    const widgetCalls: Array<{ key: string; content: ExtensionWidgetContent | undefined }> = [];

    function setWidget(key: string, content: ExtensionWidgetContent) {
      widgetCalls.push({ key, content });
    }

    await tool?.onSession?.(
      { reason: "shutdown" } as never,
      {
        cwd: "/tmp",
        hasUI: true,
        ui: { setWidget },
      } as unknown as ExtensionContext,
    );

    expect(widgetCalls).toEqual([{ key: "findings-report-tile", content: undefined }]);
  });
});
