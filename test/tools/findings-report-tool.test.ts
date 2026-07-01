import { describe, expect, test } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionContext, ExtensionWidgetContent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { registeredTool, registerTools, toolContext } from "./helpers";

describe("findings report tool", () => {
  test("registers as a read-only roadmap tool", () => {
    const tools = registerTools();

    const tool = registeredTool(tools, "roadmap_engineer_submit_findings_report");

    expect(tool?.approval).toBe("read");
  });

  test("returns failure details when UI is unavailable", async () => {
    const tools = registerTools();
    const tool = registeredTool(tools, "roadmap_engineer_submit_findings_report");

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
    const tool = registeredTool(tools, "roadmap_engineer_submit_findings_report");
    let widget: ExtensionWidgetContent;

    const result = await tool?.execute(
      "findings-report",
      { title: "Findings", markdown: "## Summary\n\n- First finding" },
      new AbortController().signal,
      undefined,
      {
        cwd: "/tmp",
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
});
