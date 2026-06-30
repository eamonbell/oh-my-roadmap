import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
  amend,
  appendNote,
  createChangeRequest,
  initRoadmap,
  loadState,
  transition,
  updateRoadmap,
  type AmendmentInput,
  type AppendNoteInput,
  type CreateChangeRequestInput,
  type InitRoadmapInput,
  type TransitionInput,
  type UpdateRoadmapInput,
} from "../core/store";
import { nextAction, renderReport } from "../core/report";
import { validateRoadmapState } from "../core/validation";

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

export function registerRoadmapTools(api: ExtensionAPI): void {
  const z = api.zod.z;
  const register = (tool: ToolDefinition) => api.registerTool(tool);

  const approvalSchema = z.object({
    approver: z.string().optional(),
    summary: z.string().optional(),
  });
  const taskSchema = z.object({
    id: z.string(),
    title: z.string(),
    worker: z.string(),
    status: z.enum(["assigned", "started", "done", "blocked"]).default("assigned"),
    depends_on: z.array(z.string()).default([]),
    owned_files: z.array(z.string()).default([]),
    owned_modules: z.array(z.string()).default([]),
    shared_interfaces: z.array(z.string()).default([]),
  });
  const waveSchema = z.object({
    id: z.string(),
    status: z.enum(["pending", "running", "reviewing", "blocked", "complete"]).default("pending"),
    tasks: z.array(z.string()),
  });
  const evidenceResultSchema = z.object({
    item: z.string(),
    status: z.enum(["open", "passed", "failed", "deferred"]),
    reason: z.string().optional(),
    approver: z.string().optional(),
    at: z.string().optional(),
  });
  const riskDispositionSchema = z.object({
    risk: z.string(),
    disposition: z.enum(["resolved", "deferred"]),
    reason: z.string().optional(),
    approver: z.string().optional(),
  });
  const closeoutSchema = z.object({
    status: z.enum(["open", "recorded", "closed"]),
    acceptance_results: z.array(evidenceResultSchema),
    verification_results: z.array(evidenceResultSchema),
    worker_notes_reviewed: z.boolean(),
    review_summary: z.string(),
    unresolved_risks: z.array(riskDispositionSchema),
    closed_by: z.string().optional(),
    closed_at: z.string().optional(),
  });
  const milestoneInputSchema = z.object({
    milestoneId: z.string(),
    title: z.string(),
    verificationCommands: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    tasks: z.array(taskSchema),
    waves: z.array(waveSchema),
    openQuestions: z.array(z.string()).optional(),
  });
  const roadmapMilestoneSchema = z.object({
    id: z.string(),
    title: z.string(),
    status: z
      .enum([
        "planned",
        "blocked",
        "discovery",
        "roadmap_draft",
        "roadmap_approved",
        "milestone_planning",
        "milestone_approved",
        "implementing",
        "reviewing",
        "closeout",
        "complete",
      ])
      .default("planned"),
    goal: z.string(),
    scope: z.array(z.string()),
    non_goals: z.array(z.string()),
    evidence: z.array(z.string()),
    dependencies: z.array(z.string()).default([]),
    risks: z.array(z.string()),
    acceptance_intent: z.array(z.string()),
    verification_intent: z.array(z.string()),
  });

  register({
    name: "roadmap_engineer_init",
    label: "Init Roadmap",
    description: "Create .roadmaps state and set a single active roadmap.",
    approval: "write",
    parameters: z.object({
      roadmapId: z.string(),
      title: z.string(),
      summary: z.string().optional(),
      discovery: z
        .object({
          recorded: z.boolean().optional(),
          external_research_required: z.boolean().optional(),
          external_research_recorded: z.boolean().optional(),
          findings: z.array(z.string()).optional(),
        })
        .optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const state = await initRoadmap(ctx.cwd, params as InitRoadmapInput);
      return textResult(`Initialized roadmap ${state.roadmap_id}.`, state);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_update_roadmap",
    label: "Update Roadmap",
    description: "Finalize the structured roadmap outline and generate roadmap.md before roadmap approval.",
    approval: "write",
    parameters: z.object({
      goal: z.string(),
      successCriteria: z.array(z.string()),
      constraints: z.array(z.string()),
      nonGoals: z.array(z.string()),
      context: z.array(z.string()),
      evidence: z.array(z.string()),
      risks: z.array(z.string()),
      milestones: z.array(roadmapMilestoneSchema),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const state = await updateRoadmap(ctx.cwd, params as UpdateRoadmapInput);
      return textResult(`Updated roadmap ${state.roadmap_id}.`, state);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_read_state",
    label: "Read Roadmap State",
    description: "Read the active roadmap, milestone, and change-request state.",
    approval: "read",
    parameters: z.object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const state = await loadState(ctx.cwd);
      return textResult(JSON.stringify(state, null, 2), state);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_transition",
    label: "Transition Roadmap",
    description: "Apply a legal roadmap, milestone, bypass, or change-request state transition.",
    approval: "write",
    parameters: z.object({
      operation: z.enum([
        "record_discovery",
        "approve_roadmap",
        "reopen_roadmap",
        "start_milestone_planning",
        "create_milestone_plan",
        "approve_milestone",
        "start_implementation",
        "start_reviewing",
        "start_closeout",
        "complete_milestone",
        "request_bypass",
        "clear_bypass",
        "approve_change",
        "close_change",
        "update_task_status",
        "update_wave_status",
        "record_closeout",
      ]),
      ...approvalSchema.shape,
      reason: z.string().optional(),
      discovery: z
        .object({
          recorded: z.boolean().optional(),
          external_research_required: z.boolean().optional(),
          external_research_recorded: z.boolean().optional(),
          findings: z.array(z.string()).optional(),
        })
        .optional(),
      milestone: milestoneInputSchema.optional(),
      taskId: z.string().optional(),
      taskStatus: z.enum(["assigned", "started", "done", "blocked"]).optional(),
      waveId: z.string().optional(),
      waveStatus: z.enum(["pending", "running", "reviewing", "blocked", "complete"]).optional(),
      closeout: closeoutSchema.optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const input = params as TransitionInput;
      const state = await transition(ctx.cwd, input);
      return textResult(`Transition applied: ${input.operation}.`, state);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_append_note",
    label: "Append Roadmap Note",
    description: "Append an immutable scoped note to the active milestone log.",
    approval: "write",
    parameters: z.object({
      kind: z.enum(["worker", "review", "orchestrator", "decision", "issue"]),
      roadmapId: z.string().optional(),
      milestoneId: z.string().optional(),
      waveId: z.string().optional(),
      taskId: z.string().optional(),
      workerId: z.string().optional(),
      blocking: z.boolean().optional(),
      status: z.enum(["open", "resolved", "deferred"]).optional(),
      title: z.string(),
      body: z.string(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const filePath = await appendNote(ctx.cwd, params as AppendNoteInput);
      return textResult(`Appended note to ${filePath}.`, { filePath });
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_validate",
    label: "Validate Roadmap",
    description: "Validate roadmap artifacts, approvals, waves, ownership, notes, and gates.",
    approval: "read",
    parameters: z.object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const result = await validateRoadmapState(ctx.cwd);
      return textResult(result.valid ? "Roadmap state is valid." : "Roadmap state is invalid.", result);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_next_action",
    label: "Next Roadmap Action",
    description: "Compute the next legal action for the active roadmap workflow.",
    approval: "read",
    parameters: z.object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const action = await nextAction(ctx.cwd);
      return textResult(action, { action });
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_amend",
    label: "Amend Roadmap",
    description: "Record approved roadmap amendments or milestone plan amendments.",
    approval: "write",
    parameters: z.object({
      scope: z.enum(["roadmap", "milestone"]),
      title: z.string(),
      body: z.string(),
      material: z.boolean(),
      approvedBy: z.string().optional(),
      approvalSummary: z.string().optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const filePath = await amend(ctx.cwd, params as AmendmentInput);
      return textResult(`Recorded amendment in ${filePath}.`, { filePath });
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_create_change_request",
    label: "Create Change Request",
    description: "Create an active post-implementation change request and change plan.",
    approval: "write",
    parameters: z.object({
      changeRequestId: z.string(),
      title: z.string(),
      request: z.string(),
      verificationCommands: z.array(z.string()),
      acceptanceCriteria: z.array(z.string()),
      tasks: z.array(taskSchema),
      waves: z.array(waveSchema),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const change = await createChangeRequest(ctx.cwd, params as CreateChangeRequestInput);
      return textResult(`Created change request ${change.change_request_id}.`, change);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_render_report",
    label: "Render Roadmap Report",
    description: "Render active roadmap status, validation, implementation gate, and next action.",
    approval: "read",
    parameters: z.object({}),
    async execute(_id, _params, _signal, _update, ctx: ExtensionContext) {
      const report = await renderReport(ctx.cwd);
      return textResult(report, { report });
    },
  } as ToolDefinition);
}
