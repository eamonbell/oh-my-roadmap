import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { initProject } from "../core/project-init";
import { applyRoadmapDetailControl, buildRoadmapDetailSummary } from "../core/roadmap-detail-summary";
import { renderReport } from "../core/report";
import { RoadmapDetailsView } from "./report-ui.ts";

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
const DETAILS_COMMAND = "roadmap:details";


function commandSpecificInstructions(name: string): string {
  if (name === "roadmap:new") {
    return `
Command-specific workflow for /roadmap:new:
- After roadmap_engineer_update_roadmap writes the finalized roadmap, dispatch roadmap-milestone-checker before asking for roadmap approval.
- Record the checker result with roadmap_engineer_transition operation record_roadmap_milestone_check.
- If the checker fails, revise the roadmap with roadmap_engineer_update_roadmap, rerun roadmap-milestone-checker, and record the new result.
- Only call roadmap_engineer_validate and ask for roadmap approval after the recorded roadmap-milestone check has passed.`;
  }
  if (name === "milestone:plan") {
    return `
Command-specific workflow for /milestone:plan:
- If the roadmap phase is roadmap_approved, call roadmap_engineer_transition with operation start_milestone_planning before creating the milestone plan.
- If the roadmap phase is complete and the roadmap has remaining planned or blocked milestone outlines, do not call reopen_roadmap. Call roadmap_engineer_transition with operation start_milestone_planning to advance from the completed milestone into planning for the next milestone.
- If the roadmap phase is complete and there are no remaining planned or blocked milestone outlines, stop and ask whether the user wants a post-implementation change request or a new roadmap.
- Do not pad the milestone plan with filler tasks; every task must directly implement the approved roadmap milestone scope.
- After milestone planning is open, use roadmap_engineer_transition with operation create_milestone_plan for the selected roadmap milestone, then validate before asking for approval.`;
  }
  if (name === "milestone:implement") {
    return `
Command-specific workflow for /milestone:implement:
- Use the built-in \`ask\` tool from the orchestrator/main-agent role if implementation uncovers missing decisions, ownership gaps, unplanned files, acceptance ambiguity, cleanup scope questions, or approval needs.
- Do not write or modify code yourself.
- Call roadmap_engineer_prepare_wave_dispatch before dispatching implementation work. Dispatch only the returned active-wave assignments with the built-in task/subagent mechanism, using each assignment's exact worker and prompt.
- After each worker returns, call roadmap_engineer_record_wave_result with completed, failed, or blocked status before taking any next orchestration step.
- When all active-wave workers are completed, call roadmap_engineer_prepare_wave_review and dispatch the returned reviewer package with the built-in task/subagent mechanism.
- After the reviewer returns, call roadmap_engineer_record_wave_review with passed or failed status.
- If workers or reviewers report blockers, rely on the record tools to update task/wave/progress state and open canonical blockers, then ask the user from the orchestrator/main-agent role when needed before redispatching or replanning.
- Require worker results whose worker role matches each returned assignment before preparing review.
- Never perform wave reviews yourself and never perform wave-flow checks during implementation.`;
  }
  if (name !== "roadmap:reopen") return "";
  return `
Command-specific workflow for /roadmap:reopen:
- Read state and validate that the active roadmap is exactly in roadmap_approved with no active milestone or change request.
- Inspect the current roadmap, decisions, risks, relevant code, and relevant documentation before proposing changes.
- Use the built-in ask tool until the requested roadmap delta and required reopen reason are explicit.
- Call roadmap_engineer_transition with operation reopen_roadmap and a non-empty reason.
- Call roadmap_engineer_update_roadmap with the full revised structured roadmap.
- After roadmap_engineer_update_roadmap writes the finalized roadmap, dispatch roadmap-milestone-checker before asking for roadmap approval.
- Record the checker result with roadmap_engineer_transition operation record_roadmap_milestone_check.
- If the checker fails, revise the roadmap with roadmap_engineer_update_roadmap, rerun roadmap-milestone-checker, and record the new result.
- Only call roadmap_engineer_validate and ask for roadmap approval after the recorded roadmap-milestone check has passed.
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
- For roadmap planning, each milestone outline must group multiple meaningful deliverables or workstreams that belong together; do not create a separate milestone for one small edit, isolated cleanup, or one narrow task.
- Use roadmap_engineer_transition, roadmap_engineer_amend, roadmap_engineer_append_note, or roadmap_engineer_create_change_request for state changes.
- Record discovery with roadmap_engineer_transition operation record_discovery before roadmap approval.
- For milestone and change planning, define concrete executable tasks before dependency analysis or wave creation; each task needs objective, implementation notes, done criteria, task verification commands, dependencies, exclusive ownership, shared interfaces, and worker assignment.
- For milestone and change planning, assign each task to exactly one of worker-light, worker, or worker-heavy based on risk and blast radius.
- Before milestone or change approval, dispatch wave-flow-checker, record its result with record_wave_flow_check, and revise draft plans with update_milestone_plan or update_change_request_plan until the check passes.
- For milestone planning, explicitly ask the user what test coverage they want based on the implementation tasks: which areas should create tests, which should run existing tests, what detail those tests should cover, and what coverage is intentionally deferred or not required.
- For implementation progress, prefer roadmap_engineer_prepare_wave_dispatch, roadmap_engineer_record_wave_result, roadmap_engineer_prepare_wave_review, and roadmap_engineer_record_wave_review; use update_task_status, update_wave_status, and update_implementation_progress only for manual recovery.
- For implementation resume, treat the persisted progress cursor as authoritative for active wave, orchestration step, active tasks, and blocker reason.
- Before closing milestones or changes, record structured closeout evidence with record_closeout.
- For milestone and change implementation, do not edit files yourself; call the wave orchestration tools, dispatch each returned task to the exact agent named by assignment.worker, dispatch reviewer for wave reviews, and collect evidence closeout.
- If implementation is not legally open, do not edit files.
${commandSpecificInstructions(name)}`;
}

async function sendCommandPrompt(api: ExtensionAPI, name: string, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const report = await renderReport(ctx.cwd);
  api.sendUserMessage(commandPrompt(name, args, report));
}

async function showRoadmapDetails(api: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const summary = await buildRoadmapDetailSummary(ctx.cwd);

  void ctx.ui
    .custom(
      (tui, _theme, _keybindings, done) => {
        const close = () => done(undefined);
        return new RoadmapDetailsView(summary, tui, close, (key) => {
          void applyRoadmapDetailControl(ctx.cwd, key)
            .then((result) => {
              if (result.action === "applied_next_action") {
                ctx.ui.notify(`Applied next action: ${result.result.plan.label}`, "info");
              } else {
                api.sendUserMessage(result.prompt);
              }
              close();
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              ctx.ui.notify(`roadmap:details control failed: ${message}`, "error");
            });
        });
      },
      { overlay: true },
    )
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`roadmap:details failed: ${message}`, "error");
    });
}

export function registerRoadmapCommands(api: ExtensionAPI): void {
  api.registerCommand(INIT_COMMAND, {
    description: "Scaffold roadmap-engineer project config and local generated agents",
    handler: async (_args, ctx) => {
      try {
        const result = await initProject(ctx.cwd);
        ctx.ui.notify(
          `Initialized roadmap-engineer project files: ${result.configPath}, ${Object.values(result.agentPaths).join(", ")}`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`roadmap:init failed: ${message}`, "error");
        throw error;
      }
    },
  });

  api.registerCommand(DETAILS_COMMAND, {
    description: "View current roadmap state without prompting the model",
    handler: async (_args, ctx) => {
      await showRoadmapDetails(api, ctx);
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
