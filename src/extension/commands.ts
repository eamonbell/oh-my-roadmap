import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { initProject } from "../core/project-init";
import { renderReport } from "../core/report";

const COMMANDS = [
  ["roadmap:new", "Create a new gated roadmap workflow"],
  ["roadmap:resume", "Resume the active roadmap from .roadmaps state"],
  ["roadmap:status", "Report active roadmap state, validation, and next action"],
  ["roadmap:amend", "Record an approved roadmap amendment"],
  ["roadmap:reopen", "Reopen the approved roadmap for pre-milestone changes"],
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

const INIT_COMMAND = "roadmap:init";

function commandSpecificInstructions(name: string): string {
  if (name === "milestone:plan") {
    return `
Command-specific workflow for /milestone:plan:
- If the roadmap phase is roadmap_approved, call roadmap_engineer_transition with operation start_milestone_planning before creating the milestone plan.
- If the roadmap phase is complete and the roadmap has remaining planned or blocked milestone outlines, do not call reopen_roadmap. Call roadmap_engineer_transition with operation start_milestone_planning to advance from the completed milestone into planning for the next milestone.
- If the roadmap phase is complete and there are no remaining planned or blocked milestone outlines, stop and ask whether the user wants a post-implementation change request or a new roadmap.
- After milestone planning is open, use roadmap_engineer_transition with operation create_milestone_plan for the selected roadmap milestone, then validate before asking for approval.`;
  }
  if (name !== "roadmap:reopen") return "";
  return `
Command-specific workflow for /roadmap:reopen:
- Read state and validate that the active roadmap is exactly in roadmap_approved with no active milestone or change request.
- Inspect the current roadmap, decisions, risks, relevant code, and relevant documentation before proposing changes.
- Use the built-in ask tool until the requested roadmap delta and required reopen reason are explicit.
- Call roadmap_engineer_transition with operation reopen_roadmap and a non-empty reason.
- Call roadmap_engineer_update_roadmap with the full revised structured roadmap.
- Call roadmap_engineer_validate, ask for explicit roadmap reapproval, then call roadmap_engineer_transition with operation approve_roadmap.
- Do not create milestone plans, tasks, waves, workers, ownership, change requests, or implementation work during reopening.`;
}

function commandPrompt(name: string, args: string, report: string): string {
  return `You are operating the roadmap-engineer OMP extension command /${name}.

User arguments:
${args || "(none)"}

Current roadmap-engineer state:
${report}

Follow the roadmap-engineer workflow strictly:
- Do not assume missing planning details.
- Inspect existing code and documentation before planning or changing state.
- Use the built-in ask tool to interview the user whenever additional information, decisions, tradeoffs, gaps, approvals, or unresolved questions remain.
- Reference relevant existing code and documentation paths in roadmap, milestone, change, review, and closeout artifacts when those references help future agents.
- Use roadmap_engineer_read_state for compact orientation before changing state when context is unclear; request a focused scope when only roadmap, active milestone, active change, or usage context is needed.
- Use roadmap_engineer_search_context for roadmap sections, plan sections, decisions, risks, notes, issues, and review findings; use roadmap_engineer_read_context only for selected entries that need full detail. Do not read full roadmap.md or plan.md directly unless the section tools cannot answer the question.
- Use roadmap_engineer_validate before asking for approval or opening implementation.
- Use roadmap_engineer_update_roadmap to finalize a detailed generated roadmap before asking for roadmap approval.
- Use roadmap_engineer_transition, roadmap_engineer_amend, roadmap_engineer_append_note, or roadmap_engineer_create_change_request for state changes.
- Record discovery with roadmap_engineer_transition operation record_discovery before roadmap approval.
- For milestone and change planning, define concrete executable tasks before dependency analysis or wave creation; each task needs objective, implementation notes, done criteria, task verification commands, dependencies, exclusive ownership, shared interfaces, and worker assignment.
- For milestone planning, explicitly ask the user what test coverage they want based on the implementation tasks: which areas should create tests, which should run existing tests, what detail those tests should cover, and what coverage is intentionally deferred or not required.
- For implementation progress, update task, wave, and cursor state with update_task_status, update_wave_status, and update_implementation_progress.
- For implementation resume, treat the persisted progress cursor as authoritative for active wave, orchestration step, active tasks, and blocker reason.
- Before closing milestones or changes, record structured closeout evidence with record_closeout.
- For milestone and change implementation, perform dependency analysis, exclusive ownership checks, worker notes, per-wave review, and evidence closeout.
- If implementation is not legally open, do not edit files.
${commandSpecificInstructions(name)}`;
}

async function sendCommandPrompt(api: ExtensionAPI, name: string, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const report = await renderReport(ctx.cwd);
  api.sendUserMessage(commandPrompt(name, args, report));
}

export function registerRoadmapCommands(api: ExtensionAPI): void {
  api.registerCommand(INIT_COMMAND, {
    description: "Scaffold roadmap-engineer project config and local worker/reviewer agents",
    handler: async (_args, ctx) => {
      try {
        const result = await initProject(ctx.cwd);
        ctx.ui.notify(
          `Initialized roadmap-engineer project files: ${result.configPath}, ${result.agentPaths.worker}, ${result.agentPaths.reviewer}`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`roadmap:init failed: ${message}`, "error");
        throw error;
      }
    },
  });

  for (const [name, description] of COMMANDS) {
    api.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        await sendCommandPrompt(api, name, args, ctx);
      },
    });
  }
}
