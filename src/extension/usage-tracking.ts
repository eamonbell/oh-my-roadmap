import type { ExtensionAPI, MessageEndEvent, ToolExecutionEndEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { recordMainUsage, recordTaskUsage } from "../core/usage";

export function registerRoadmapUsageTracking(api: ExtensionAPI): void {
  api.on("message_end", async (event: MessageEndEvent, ctx) => {
    await recordMainUsage(ctx.cwd, event.message);
  });
  api.on("tool_execution_end", async (event: ToolExecutionEndEvent, ctx) => {
    if (event.toolName !== "task" || event.isError) return;
    await recordTaskUsage(ctx.cwd, event.toolCallId, event.result);
  });
}
