import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { shouldBlockToolCall } from "../../src/core/gate";

export default function roadmapEngineerGate(pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const decision = await shouldBlockToolCall(ctx.cwd, event.toolName);
    if (!decision.block) return;
    return decision.reason
      ? { block: true, reason: decision.reason }
      : { block: true };
  });
}
