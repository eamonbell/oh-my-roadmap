import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { configureDiagnosticLogger } from "./diagnostics";
import { registerRoadmapCommands } from "./extension/commands";
import { registerRoadmapUsageTracking } from "./extension/usage-tracking";
import { registerRoadmapTools } from "./tools/register";

export default function roadmapEngineer(api: ExtensionAPI): void {
  configureDiagnosticLogger({ fallbackLogger: api.logger });
  api.setLabel("roadmap-engineer");
  registerRoadmapTools(api);
  registerRoadmapCommands(api);
  registerRoadmapUsageTracking(api);
}
