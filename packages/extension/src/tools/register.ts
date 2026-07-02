import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { withDiagnosticTiming } from "@oh-my-roadmap/core/diagnostics";
import { registerBlockerTools } from "./register/blocker-tools";
import { registerContextTools } from "./register/context-tools";
import { registerFindingsReportTool } from "./register/findings-report-tool";
import { registerGraphTools } from "./register/graph-tools";
import { registerReportTools } from "./register/report-tools";
import { registerRoadmapLifecycleTools } from "./register/roadmap-tools";
import { createToolRegistrationSchemas, toolMetadata, type ToolRegistrationContext } from "./register/shared";
import { registerTransitionTools } from "./register/transition-tools";
import { registerWaveTools } from "./register/wave-tools";

export function registerRoadmapTools(api: ExtensionAPI): void {
  const z = api.zod.z;
  const register = (tool: ToolDefinition) =>
    api.registerTool({
      ...tool,
      async execute(toolCallId, params, signal, update, ctx) {
        return await withDiagnosticTiming({
          component: "tool",
          operation: tool.name,
          cwd: ctx.cwd,
          slowMs: 1000,
          metadata: toolMetadata(tool, toolCallId, params),
        }, async () => await tool.execute(toolCallId, params, signal, update, ctx));
      },
    } as ToolDefinition);

  const schemas = createToolRegistrationSchemas(z);
  const ctx: ToolRegistrationContext = { api, z, register, schemas };

  registerRoadmapLifecycleTools(ctx);
  registerContextTools(ctx);
  registerTransitionTools(ctx);
  registerBlockerTools(ctx);
  registerWaveTools(ctx);
  registerReportTools(ctx);
  registerFindingsReportTool(ctx);
  registerGraphTools(ctx);
}
