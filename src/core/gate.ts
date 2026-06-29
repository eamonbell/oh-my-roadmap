import { validateImplementationGate } from "./validation";

export const DIRECT_FILE_WRITE_TOOLS = new Set(["write", "edit", "ast_edit", "resolve"]);

export interface ToolGateDecision {
  block: boolean;
  reason?: string;
}

export async function shouldBlockToolCall(cwd: string, toolName: string): Promise<ToolGateDecision> {
  if (!DIRECT_FILE_WRITE_TOOLS.has(toolName)) return { block: false };

  const gate = await validateImplementationGate(cwd);
  if (gate.valid) return { block: false };

  const reason = gate.errors.map((error) => `- ${error.message}`).join("\n");
  return {
    block: true,
    reason: `roadmap-engineer blocked ${toolName}: implementation gates are not satisfied.\n${reason}`,
  };
}

