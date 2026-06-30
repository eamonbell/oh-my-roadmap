import type { ExtensionAPI, MessageEndEvent, ToolExecutionEndEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { recordMainUsage, recordTaskUsage } from "../core/usage";
import { withDiagnosticTiming } from "../diagnostics";

export function registerRoadmapUsageTracking(api: ExtensionAPI): void {
  api.on("message_end", async (event: MessageEndEvent, ctx) => {
    await withDiagnosticTiming({
      component: "extension-event",
      operation: "message_end",
      cwd: ctx.cwd,
      slowMs: 1000,
      metadata: { event_type: event.type },
    }, async () => {
      await recordMainUsage(ctx.cwd, event.message);
    });
  });
  api.on("tool_execution_end", async (event: ToolExecutionEndEvent, ctx) => {
    await withDiagnosticTiming({
      component: "extension-event",
      operation: "tool_execution_end",
      cwd: ctx.cwd,
      slowMs: 1000,
      metadata: {
        event_type: event.type,
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
        skipped: event.toolName !== "task" || event.isError,
      },
    }, async () => {
      if (event.toolName !== "task" || event.isError) return;
      await recordTaskUsage(ctx.cwd, event.toolCallId, event.result);
    });
  });
}
