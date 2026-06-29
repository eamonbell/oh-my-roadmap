import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { renderReport } from "../core/report";

const COMMANDS = [
  ["roadmap:new", "Create a new gated roadmap workflow"],
  ["roadmap:resume", "Resume the active roadmap from .roadmaps state"],
  ["roadmap:status", "Report active roadmap state, validation, and next action"],
  ["roadmap:amend", "Record an approved roadmap amendment"],
  ["milestone:plan", "Plan the next milestone with dependency waves"],
  ["milestone:implement", "Implement the approved milestone or active change plan"],
  ["milestone:status", "Report active milestone health"],
  ["milestone:close", "Close a milestone with evidence"],
  ["bypass:request", "Record a reasoned implementation-gate bypass"],
  ["bypass:clear", "Clear an active bypass"],
  ["change:request", "Plan a post-implementation change request"],
  ["change:status", "Report active change-request state"],
  ["change:close", "Close an active change request with evidence"],
] as const;

function commandPrompt(name: string, args: string, report: string): string {
  return `You are operating the roadmap-engineer OMP extension command /${name}.

User arguments:
${args || "(none)"}

Current roadmap-engineer state:
${report}

Follow the roadmap-engineer workflow strictly:
- Do not assume missing planning details.
- Use roadmap_engineer_read_state before changing state when context is unclear.
- Use roadmap_engineer_validate before asking for approval or opening implementation.
- Use roadmap_engineer_transition, roadmap_engineer_amend, roadmap_engineer_append_note, or roadmap_engineer_create_change_request for state changes.
- For milestone and change implementation, perform dependency analysis, exclusive ownership checks, worker notes, per-wave review, and evidence closeout.
- If implementation is not legally open, do not edit files.`;
}

async function sendCommandPrompt(api: ExtensionAPI, name: string, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const report = await renderReport(ctx.cwd);
  api.sendUserMessage(commandPrompt(name, args, report), { deliverAs: "followUp" });
}

export function registerRoadmapCommands(api: ExtensionAPI): void {
  for (const [name, description] of COMMANDS) {
    api.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        await sendCommandPrompt(api, name, args, ctx);
      },
    });
  }
}
