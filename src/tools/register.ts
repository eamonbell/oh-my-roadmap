import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
  amend,
  appendNote,
  createChangeRequest,
  deferBlocker,
  initRoadmap,
  listBlockers,
  listQualityGates,
  loadRoadmapBlockers,
  loadState,
  openBlocker,
  repairRoadmap,
  resolveBlocker,
  transition,
  updateRoadmap,
  type AmendmentInput,
  type AppendNoteInput,
  type CreateChangeRequestInput,
  type DeferBlockerInput,
  type InitRoadmapInput,
  type ListBlockersInput,
  type ListQualityGatesInput,
  type OpenBlockerInput,
  type RepairRoadmapInput,
  type ResolveBlockerInput,
  type TransitionInput,
  type UpdateRoadmapInput,
} from "../core/store";
import { readRoadmapEvents, type ReadRoadmapEventsInput } from "../core/events";
import {
  readContext,
  searchContext,
  type ReadContextInput,
  type SearchContextInput,
} from "../core/context";
import { applyNextAction, nextActionPlan, renderReport } from "../core/report";
import { withDiagnosticTiming } from "../diagnostics";
import { summarizeState, type StateReadScope } from "../core/state-summary";
import { validateRoadmapState } from "../core/validation";
import {
  prepareWaveDispatch,
  prepareWaveReview,
  recordWorkerAbandoned,
  recordWorkerDispatch,
  recordWorkerTransportFailed,
  recordWaveResult,
  recordWaveReview,
  type RecordWorkerDispatchInput,
  type RecordWorkerRunStatusInput,
  type RecordWaveResultInput,
  type RecordWaveReviewInput,
  type WaveOrchestrationTargetInput,
} from "../core/wave-orchestration";

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

function toolMetadata(tool: ToolDefinition, toolCallId: string, params: unknown): Record<string, unknown> {
  const raw = params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
  return {
    tool_name: tool.name,
    tool_call_id: toolCallId,
    approval: tool.approval ?? "exec",
    ...(typeof raw.operation === "string" ? { operation: raw.operation } : {}),
    ...(typeof raw.scope === "string" ? { scope: raw.scope } : {}),
    ...(typeof raw.actionId === "string" ? { action_id: raw.actionId } : {}),
  };
}

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

  const approvalSchema = z.object({
    approver: z.string().optional(),
    summary: z.string().optional(),
  });
  const taskSchema = z.object({
    id: z.string(),
    title: z.string(),
    objective: z.string(),
    implementation_notes: z.array(z.string()).default([]),
    done_criteria: z.array(z.string()),
    verification_commands: z.array(z.string()).default([]),
    worker: z.enum(["worker-light", "worker", "worker-heavy"]),
    status: z.enum(["assigned", "started", "done", "blocked"]).default("assigned"),
    depends_on: z.array(z.string()).default([]),
    owned_files: z.array(z.string()).default([]),
    owned_modules: z.array(z.string()).default([]),
    shared_interfaces: z.array(z.string()).default([]),
  });
  const waveSchema = z.object({
    id: z.string(),
    goal: z.string(),
    exit_criteria: z.array(z.string()),
    review_checkpoint: z.string(),
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
    userInterview: z.array(z.string()).default([]),
    relevantExistingCode: z.array(z.string()).default([]),
    relevantDocumentation: z.array(z.string()).default([]),
    decisions: z.array(z.string()).default([]),
    dependencyAnalysis: z.array(z.string()).default([]),
    tasks: z.array(taskSchema),
    waves: z.array(waveSchema),
    openQuestions: z.array(z.string()).optional(),
  });
  const changeRequestInputSchema = z.object({
    changeRequestId: z.string(),
    title: z.string(),
    request: z.string(),
    verificationCommands: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    userInterview: z.array(z.string()).default([]),
    relevantExistingCode: z.array(z.string()).default([]),
    relevantDocumentation: z.array(z.string()).default([]),
    decisions: z.array(z.string()).default([]),
    dependencyAnalysis: z.array(z.string()).default([]),
    tasks: z.array(taskSchema),
    waves: z.array(waveSchema),
  });
  const implementationProgressStepSchema = z.enum([
    "not_started",
    "dispatching",
    "workers_running",
    "wave_review",
    "resolving_blockers",
    "ready_for_next_wave",
    "closeout_ready",
  ]);
  const implementationProgressInputSchema = z.object({
    activeWaveId: z.string().optional(),
    step: implementationProgressStepSchema,
    activeTaskIds: z.array(z.string()).default([]),
    blockedReason: z.string().optional(),
  });
  const waveFlowCheckInputSchema = z.object({
    status: z.enum(["passed", "failed"]),
    checkedBy: z.string().optional(),
    summary: z.string().optional(),
    findings: z.array(z.string()).default([]),
  });
  const contextArtifactSchema = z.enum(["notes", "decisions", "risks", "roadmap", "plan"]);
  const contextNoteKindSchema = z.enum(["worker", "review", "orchestrator", "decision", "issue"]);
  const contextNoteStatusSchema = z.enum(["open", "resolved", "deferred"]);
  const blockerSeveritySchema = z.enum(["blocking", "non_blocking"]);
  const blockerStatusSchema = z.enum(["open", "resolved", "deferred"]);
  const waveOrchestrationTargetSchema = z.object({
    roadmapId: z.string().optional(),
    milestoneId: z.string().optional(),
    changeRequestId: z.string().optional(),
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
    name: "roadmap_engineer_repair_roadmap",
    label: "Repair Roadmap",
    description: "Repair generated roadmap hash, roadmap.md, and roadmap-milestone check drift after manual state recovery.",
    approval: "write",
    parameters: z.object({
      reason: z.string(),
      actor: z.string().optional(),
      summary: z.string().optional(),
      roadmapMilestoneCheck: z.object({
        status: z.literal("passed"),
        checkedBy: z.string().optional(),
        summary: z.string(),
        findings: z.array(z.string()).default([]),
      }).optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await repairRoadmap(ctx.cwd, params as RepairRoadmapInput);
      return textResult(`Repaired roadmap ${result.roadmap_id}.`, result);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_read_state",
    label: "Read Roadmap State",
    description: "Read compact active roadmap, milestone, and change-request state. Full detail is available through roadmap_engineer_search_context and roadmap_engineer_read_context.",
    approval: "read",
    parameters: z.object({
      scope: z.enum(["compact", "roadmap", "active_milestone", "active_change", "usage"]).optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const scope = ((params as { scope?: StateReadScope }).scope ?? "compact") as StateReadScope;
      const state = await loadState(ctx.cwd);
      const blockers = state.roadmap ? await loadRoadmapBlockers(ctx.cwd, state.roadmap.roadmap_id) : [];
      const roadmapSections = ["compact", "roadmap"].includes(scope)
        ? (await searchContext(ctx.cwd, { artifacts: ["roadmap"], maxResults: 50, snippetChars: 80 })).results
        : undefined;
      const planSections = ["compact", "active_milestone", "active_change"].includes(scope)
        ? (await searchContext(ctx.cwd, { artifacts: ["plan"], maxResults: 80, snippetChars: 80 })).results
        : undefined;
      const summary = summarizeState(state, scope, {
        ...(roadmapSections !== undefined ? { roadmapSections } : {}),
        ...(planSections !== undefined ? { planSections } : {}),
        blockers,
      });
      return textResult(JSON.stringify(summary, null, 2), summary);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_search_context",
    label: "Search Roadmap Context",
    description: "Search active-roadmap notes, decisions, risks, roadmap sections, and plan sections with compact snippet results.",
    approval: "read",
    parameters: z.object({
      artifacts: z.array(contextArtifactSchema).optional(),
      query: z.string().optional(),
      useRegex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      maxResults: z.number().optional(),
      snippetChars: z.number().optional(),
      includeBodies: z.boolean().optional(),
      maxBodyChars: z.number().optional(),
      milestoneIds: z.array(z.string()).optional(),
      kinds: z.array(contextNoteKindSchema).optional(),
      statuses: z.array(contextNoteStatusSchema).optional(),
      blocking: z.boolean().optional(),
      waveId: z.string().optional(),
      taskId: z.string().optional(),
      workerId: z.string().optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await searchContext(ctx.cwd, params as SearchContextInput);
      return textResult(JSON.stringify(result, null, 2), result);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_read_context",
    label: "Read Roadmap Context",
    description: "Read selected context entries returned by roadmap_engineer_search_context.",
    approval: "read",
    parameters: z.object({
      ids: z.array(z.string()),
      maxBodyChars: z.number().optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await readContext(ctx.cwd, params as ReadContextInput);
      return textResult(JSON.stringify(result, null, 2), result);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_read_events",
    label: "Read Roadmap Events",
    description: "Read capped append-only workflow events for the active or selected roadmap.",
    approval: "read",
    parameters: z.object({
      roadmapId: z.string().optional(),
      milestoneId: z.string().optional(),
      changeRequestId: z.string().optional(),
      taskId: z.string().optional(),
      waveId: z.string().optional(),
      blockerId: z.string().optional(),
      type: z.array(z.string()).optional(),
      since: z.string().optional(),
      limit: z.number().optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await readRoadmapEvents(ctx.cwd, params as ReadRoadmapEventsInput);
      return textResult(JSON.stringify(result, null, 2), result);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_list_quality_gates",
    label: "List Quality Gates",
    description: "Read the current quality gate state and durable quality_gate.recorded history.",
    approval: "read",
    parameters: z.object({
      roadmapId: z.string().optional(),
      gate: z.enum(["roadmap_milestone_check", "wave_flow_check"]).optional(),
      status: z.enum(["pending", "passed", "failed"]).optional(),
      limit: z.number().optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await listQualityGates(ctx.cwd, params as ListQualityGatesInput);
      return textResult(JSON.stringify(result, null, 2), result);
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
        "update_milestone_plan",
        "start_implementation",
        "start_reviewing",
        "start_closeout",
        "complete_milestone",
        "request_bypass",
        "clear_bypass",
        "approve_change",
        "update_change_request_plan",
        "close_change",
        "update_task_status",
        "update_wave_status",
        "update_implementation_progress",
        "record_closeout",
        "record_wave_flow_check",
        "record_roadmap_milestone_check",
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
      changeRequest: changeRequestInputSchema.optional(),
      taskId: z.string().optional(),
      taskStatus: z.enum(["assigned", "started", "done", "blocked"]).optional(),
      waveId: z.string().optional(),
      waveStatus: z.enum(["pending", "running", "reviewing", "blocked", "complete"]).optional(),
      progress: implementationProgressInputSchema.optional(),
      closeout: closeoutSchema.optional(),
      waveFlowCheck: waveFlowCheckInputSchema.optional(),
      roadmapMilestoneCheck: waveFlowCheckInputSchema.optional(),
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
    name: "roadmap_engineer_open_blocker",
    label: "Open Blocker",
    description: "Open a canonical scoped roadmap blocker.",
    approval: "write",
    parameters: z.object({
      roadmapId: z.string().optional(),
      milestoneId: z.string().optional(),
      changeRequestId: z.string().optional(),
      taskId: z.string().optional(),
      waveId: z.string().optional(),
      severity: blockerSeveritySchema.default("blocking"),
      title: z.string(),
      description: z.string(),
      createdBy: z.string().optional(),
      notePath: z.string().optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const blocker = await openBlocker(ctx.cwd, params as OpenBlockerInput);
      return textResult(`Opened blocker ${blocker.id}.`, blocker);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_resolve_blocker",
    label: "Resolve Blocker",
    description: "Resolve an open canonical roadmap blocker.",
    approval: "write",
    parameters: z.object({
      roadmapId: z.string().optional(),
      blockerId: z.string(),
      resolvedBy: z.string().optional(),
      resolution: z.string(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const blocker = await resolveBlocker(ctx.cwd, params as ResolveBlockerInput);
      return textResult(`Resolved blocker ${blocker.id}.`, blocker);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_defer_blocker",
    label: "Defer Blocker",
    description: "Defer an open canonical roadmap blocker.",
    approval: "write",
    parameters: z.object({
      roadmapId: z.string().optional(),
      blockerId: z.string(),
      deferredBy: z.string().optional(),
      deferReason: z.string(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const blocker = await deferBlocker(ctx.cwd, params as DeferBlockerInput);
      return textResult(`Deferred blocker ${blocker.id}.`, blocker);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_list_blockers",
    label: "List Blockers",
    description: "List canonical roadmap blockers by scope, status, and severity.",
    approval: "read",
    parameters: z.object({
      roadmapId: z.string().optional(),
      milestoneId: z.string().optional(),
      changeRequestId: z.string().optional(),
      taskId: z.string().optional(),
      waveId: z.string().optional(),
      status: blockerStatusSchema.optional(),
      severity: blockerSeveritySchema.optional(),
      limit: z.number().optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await listBlockers(ctx.cwd, params as ListBlockersInput);
      return textResult(JSON.stringify(result, null, 2), result);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_prepare_wave_dispatch",
    label: "Prepare Wave Dispatch",
    description: "Validate the active implementation wave and return exact worker assignment packages.",
    approval: "write",
    parameters: waveOrchestrationTargetSchema,
    async execute(_id, params, _signal, _update, ctx) {
      const result = await prepareWaveDispatch(ctx.cwd, params as WaveOrchestrationTargetInput);
      return textResult(JSON.stringify(result, null, 2), result);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_record_worker_dispatch",
    label: "Record Worker Dispatch",
    description: "Persist an active worker-run lease immediately after spawning a background worker job.",
    approval: "write",
    parameters: waveOrchestrationTargetSchema.extend({
      taskId: z.string(),
      agentId: z.string(),
      jobId: z.string(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await recordWorkerDispatch(ctx.cwd, params as RecordWorkerDispatchInput);
      return textResult(`Recorded worker dispatch for ${result.task_id}.`, result);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_record_worker_transport_failed",
    label: "Record Worker Transport Failed",
    description: "Mark an active worker run as transport_failed while the orchestrator probes the original worker.",
    approval: "write",
    parameters: waveOrchestrationTargetSchema.extend({
      taskId: z.string(),
      agentId: z.string().optional(),
      jobId: z.string().optional(),
      lastError: z.string().optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await recordWorkerTransportFailed(ctx.cwd, params as RecordWorkerRunStatusInput);
      return textResult(`Recorded worker transport failure for ${result.task_id}.`, result);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_record_worker_abandoned",
    label: "Record Worker Abandoned",
    description: "Mark an unreachable worker run abandoned after the 5-minute probe timeout or when the job/agent is absent from the current session.",
    approval: "write",
    parameters: waveOrchestrationTargetSchema.extend({
      taskId: z.string(),
      agentId: z.string().optional(),
      jobId: z.string().optional(),
      lastError: z.string().optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await recordWorkerAbandoned(ctx.cwd, params as RecordWorkerRunStatusInput);
      return textResult(`Recorded worker abandoned for ${result.task_id}.`, result);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_record_wave_result",
    label: "Record Wave Result",
    description: "Record an active-wave worker result, update task runtime state, and open blockers when needed.",
    approval: "write",
    parameters: waveOrchestrationTargetSchema.extend({
      taskId: z.string(),
      status: z.enum(["completed", "failed", "blocked"]),
      summary: z.string().optional(),
      notes: z.array(z.string()).optional(),
      blocker: z
        .object({
          title: z.string().optional(),
          description: z.string().optional(),
        })
        .optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await recordWaveResult(ctx.cwd, params as RecordWaveResultInput);
      return textResult(`Recorded wave task ${result.task_id} as ${result.status}.`, result);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_prepare_wave_review",
    label: "Prepare Wave Review",
    description: "Validate active-wave completion and return the exact reviewer package.",
    approval: "write",
    parameters: waveOrchestrationTargetSchema,
    async execute(_id, params, _signal, _update, ctx) {
      const result = await prepareWaveReview(ctx.cwd, params as WaveOrchestrationTargetInput);
      return textResult(JSON.stringify(result, null, 2), result);
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_record_wave_review",
    label: "Record Wave Review",
    description: "Record reviewer pass/fail, mark the active wave complete or blocked, and open review blockers.",
    approval: "write",
    parameters: waveOrchestrationTargetSchema.extend({
      status: z.enum(["passed", "failed"]),
      summary: z.string(),
      findings: z.array(z.string()).optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const input = params as RecordWaveReviewInput;
      const result = await recordWaveReview(ctx.cwd, input);
      return textResult(`Recorded wave review as ${input.status}.`, result);
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
      const plan = await nextActionPlan(ctx.cwd);
      const action = plan.description;
      return textResult(action, { action, plan });
    },
  } as ToolDefinition);

  register({
    name: "roadmap_engineer_apply_next_action",
    label: "Apply Next Roadmap Action",
    description: "Apply the current safe, unambiguous next action by id.",
    approval: "write",
    parameters: z.object({
      actionId: z.string(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await applyNextAction(ctx.cwd, (params as { actionId: string }).actionId);
      return textResult(`Applied next action: ${result.plan.label}.`, result);
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
    parameters: changeRequestInputSchema,
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
