import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { z } from "zod";
import { registerRoadmapTools } from "../../src/tools/register";
import type { UpdateRoadmapInput } from "../../src/core/store/index";

export interface RegisteredTool extends ToolDefinition {
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

export function registerTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;

  registerRoadmapTools(api);
  return tools;
}

export function registeredTool(tools: ReadonlyMap<string, RegisteredTool>, name: string): RegisteredTool | undefined {
  return tools.get(name);
}

export function toolContext(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

export function roadmapInput(): UpdateRoadmapInput {
  return {
    goal: "Check transition tool roadmap milestone flow.",
    successCriteria: ["The transition tool records checker results."],
    constraints: ["Keep tool behavior aligned with core state."],
    nonGoals: ["Do not approve the roadmap from this tool test."],
    context: ["The transition tool wraps core transition input."],
    evidence: ["registerRoadmapTools exposes roadmap_engineer_transition."],
    risks: ["Schema drift could hide checker results from tool callers."],
    milestones: [
      {
        id: "m01-core",
        title: "Core milestone",
        status: "planned",
        goal: "Record the roadmap milestone check through the tool.",
        scope: ["Pass roadmapMilestoneCheck through roadmap_engineer_transition."],
        non_goals: ["Do not run implementation."],
        evidence: ["src/tools/register.ts owns the tool schema."],
        dependencies: [],
        risks: ["Tool callers may be blocked from approval if recording fails."],
        acceptance_intent: ["Tool result exposes the passed check in state details."],
        verification_intent: ["Run bun test test/tools.test.ts."],
      },
    ],
  };
}
