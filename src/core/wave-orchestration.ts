import {
  listBlockers,
  loadState,
  openBlocker,
  transition,
  type OpenBlockerInput,
} from "./store";
import type {
  ChangeRequest,
  ImplementationProgressStep,
  ImplementationWorkerName,
  LoadedState,
  MilestonePlan,
  RoadmapBlocker,
  TaskPlan,
  WavePlan,
} from "./types";
import { IMPLEMENTATION_WORKER_NAMES } from "./types";
import { validateImplementationGate } from "./validation";

export interface WaveOrchestrationTargetInput {
  roadmapId?: string;
  milestoneId?: string;
  changeRequestId?: string;
}

export interface WaveWorkerAssignment {
  task_id: string;
  title: string;
  worker: ImplementationWorkerName;
  owned_files: string[];
  owned_modules: string[];
  shared_interfaces: string[];
  dependencies: string[];
  prompt: string;
}

export interface PrepareWaveDispatchResult {
  roadmap_id: string;
  milestone_id: string;
  change_request_id?: string;
  wave_id: string;
  wave_goal: string;
  progress_step: ImplementationProgressStep;
  assignments: WaveWorkerAssignment[];
  instructions: string;
}

export interface RecordWaveResultInput extends WaveOrchestrationTargetInput {
  taskId: string;
  status: "completed" | "failed" | "blocked";
  summary?: string;
  notes?: string[];
  blocker?: {
    title?: string;
    description?: string;
  };
}

export interface RecordWaveResultResult {
  task_id: string;
  status: TaskPlan["status"];
  wave_id: string;
  wave_status: WavePlan["status"];
  progress_step: ImplementationProgressStep;
  blocker?: RoadmapBlocker;
}

export interface PrepareWaveReviewResult {
  roadmap_id: string;
  milestone_id: string;
  change_request_id?: string;
  wave_id: string;
  reviewer: "reviewer";
  prompt: string;
  tasks: Array<{
    task_id: string;
    title: string;
    worker: ImplementationWorkerName;
    owned_files: string[];
    owned_modules: string[];
    shared_interfaces: string[];
  }>;
}

export interface RecordWaveReviewInput extends WaveOrchestrationTargetInput {
  status: "passed" | "failed";
  summary: string;
  findings?: string[];
}

export interface RecordWaveReviewResult {
  wave_id: string;
  wave_status: WavePlan["status"];
  progress_step: ImplementationProgressStep;
  blockers: RoadmapBlocker[];
}

interface ActivePlanContext {
  loaded: LoadedState;
  roadmapId: string;
  milestoneId: string;
  changeRequestId?: string;
  plan: MilestonePlan | ChangeRequest;
  activeWave: WavePlan;
  activeTasks: TaskPlan[];
}

const WORKERS = new Set<string>(IMPLEMENTATION_WORKER_NAMES);

async function assertImplementationReady(cwd: string): Promise<void> {
  const gate = await validateImplementationGate(cwd);
  if (!gate.valid) {
    const messages = gate.errors.map((error) => `${error.code}: ${error.message}`).join("; ");
    throw new Error(`Implementation gate is closed: ${messages}`);
  }
}

function requireMatchingTarget(
  loaded: LoadedState,
  input: WaveOrchestrationTargetInput,
): { roadmapId: string; milestoneId: string; changeRequestId?: string } {
  const roadmapId = loaded.active?.roadmap_id;
  const milestoneId = loaded.active?.milestone_id;
  const changeRequestId = loaded.active?.change_request_id;
  if (!roadmapId || !milestoneId) throw new Error("Wave orchestration requires an active roadmap and milestone");
  if (input.roadmapId && input.roadmapId !== roadmapId) {
    throw new Error(`Requested roadmap ${input.roadmapId} is not active`);
  }
  if (input.milestoneId && input.milestoneId !== milestoneId) {
    throw new Error(`Requested milestone ${input.milestoneId} is not active`);
  }
  if (input.changeRequestId && input.changeRequestId !== changeRequestId) {
    throw new Error(`Requested change request ${input.changeRequestId} is not active`);
  }
  return { roadmapId, milestoneId, ...(changeRequestId ? { changeRequestId } : {}) };
}

function requireActiveWave(plan: MilestonePlan | ChangeRequest): WavePlan {
  const activeWaveId = plan.progress.active_wave_id;
  if (!activeWaveId) throw new Error("Implementation progress has no active wave");
  const wave = plan.waves.find((candidate) => candidate.id === activeWaveId);
  if (!wave) throw new Error(`Active wave ${activeWaveId} is missing from the plan`);
  return wave;
}

async function activePlanContext(
  cwd: string,
  input: WaveOrchestrationTargetInput,
): Promise<ActivePlanContext> {
  const loaded = await loadState(cwd);
  const target = requireMatchingTarget(loaded, input);
  const plan = loaded.changeRequest ?? loaded.milestone;
  if (!plan) throw new Error("Wave orchestration requires an active milestone or change plan");
  const activeWave = requireActiveWave(plan);
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
  const activeTasks = activeWave.tasks.map((taskId) => {
    const task = taskById.get(taskId);
    if (!task) throw new Error(`Active wave ${activeWave.id} references unknown task ${taskId}`);
    return task;
  });
  return { loaded, ...target, plan, activeWave, activeTasks };
}

function assertDispatchableWave(ctx: ActivePlanContext): void {
  if (ctx.plan.progress.step === "resolving_blockers") {
    throw new Error(`Active wave ${ctx.activeWave.id} is resolving blockers`);
  }
  if (ctx.activeWave.status === "complete") throw new Error(`Active wave ${ctx.activeWave.id} is already complete`);
  if (ctx.activeWave.status === "blocked") throw new Error(`Active wave ${ctx.activeWave.id} is blocked`);
  if (ctx.activeWave.status === "reviewing") throw new Error(`Active wave ${ctx.activeWave.id} is already in review`);
}

function assertTaskDispatchFields(task: TaskPlan): void {
  if (!WORKERS.has(task.worker)) {
    throw new Error(`Task ${task.id} must assign worker-light, worker, or worker-heavy`);
  }
  if (task.owned_files.length === 0 && task.owned_modules.length === 0) {
    throw new Error(`Task ${task.id} must own files or modules`);
  }
}

function assertDependenciesComplete(plan: MilestonePlan | ChangeRequest, task: TaskPlan): void {
  for (const dependency of task.depends_on) {
    const dependencyTask = plan.tasks.find((candidate) => candidate.id === dependency);
    if (!dependencyTask) throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
    if (dependencyTask.status !== "done") {
      throw new Error(`Task ${task.id} depends on incomplete task ${dependency}`);
    }
  }
}

function notesText(notes: string[] | undefined): string {
  return notes && notes.length > 0 ? notes.join("\n") : "";
}

function workerPrompt(
  ctx: ActivePlanContext,
  task: TaskPlan,
): string {
  return `You are ${task.worker} for roadmap-engineer task ${task.id}: ${task.title}.

Roadmap: ${ctx.roadmapId}
Milestone: ${ctx.milestoneId}
${ctx.changeRequestId ? `Change request: ${ctx.changeRequestId}\n` : ""}Wave: ${ctx.activeWave.id} - ${ctx.activeWave.goal}

Objective:
${task.objective}

Implementation notes:
${task.implementation_notes.map((item) => `- ${item}`).join("\n")}

Done criteria:
${task.done_criteria.map((item) => `- ${item}`).join("\n")}

Verification commands:
${task.verification_commands.map((item) => `- ${item}`).join("\n")}

Ownership:
- Owned files: ${task.owned_files.length > 0 ? task.owned_files.join(", ") : "(none)"}
- Owned modules: ${task.owned_modules.length > 0 ? task.owned_modules.join(", ") : "(none)"}
- Shared interfaces: ${task.shared_interfaces.length > 0 ? task.shared_interfaces.join(", ") : "(none)"}
- Dependencies: ${task.depends_on.length > 0 ? task.depends_on.join(", ") : "(none)"}

Work only on this task's scope. Report completed, failed, or blocked status with a concise summary, verification run, and any blocker details for the orchestrator to record with roadmap_engineer_record_wave_result.`;
}

function assignment(ctx: ActivePlanContext, task: TaskPlan): WaveWorkerAssignment {
  return {
    task_id: task.id,
    title: task.title,
    worker: task.worker,
    owned_files: task.owned_files,
    owned_modules: task.owned_modules,
    shared_interfaces: task.shared_interfaces,
    dependencies: task.depends_on,
    prompt: workerPrompt(ctx, task),
  };
}

async function setProgress(
  cwd: string,
  ctx: ActivePlanContext,
  step: ImplementationProgressStep,
  activeTaskIds: string[],
  blockedReason?: string,
): Promise<void> {
  await transition(cwd, {
    operation: "update_implementation_progress",
    progress: {
      activeWaveId: ctx.activeWave.id,
      step,
      activeTaskIds,
      ...(blockedReason ? { blockedReason } : {}),
    },
  });
}

export async function prepareWaveDispatch(
  cwd: string,
  input: WaveOrchestrationTargetInput = {},
): Promise<PrepareWaveDispatchResult> {
  await assertImplementationReady(cwd);
  const ctx = await activePlanContext(cwd, input);
  assertDispatchableWave(ctx);

  const incompleteTasks = ctx.activeTasks.filter((task) => task.status !== "done");
  if (incompleteTasks.length === 0) {
    throw new Error(`Active wave ${ctx.activeWave.id} has no incomplete tasks to dispatch`);
  }
  for (const task of incompleteTasks) {
    assertTaskDispatchFields(task);
    assertDependenciesComplete(ctx.plan, task);
  }

  if (ctx.activeWave.status === "pending") {
    await transition(cwd, { operation: "update_wave_status", waveId: ctx.activeWave.id, waveStatus: "running" });
  }
  await setProgress(cwd, ctx, "dispatching", incompleteTasks.map((task) => task.id));

  return {
    roadmap_id: ctx.roadmapId,
    milestone_id: ctx.milestoneId,
    ...(ctx.changeRequestId ? { change_request_id: ctx.changeRequestId } : {}),
    wave_id: ctx.activeWave.id,
    wave_goal: ctx.activeWave.goal,
    progress_step: "dispatching",
    assignments: incompleteTasks.map((task) => assignment(ctx, task)),
    instructions:
      "Dispatch each assignment with the built-in task/subagent mechanism using the assignment's exact worker and prompt. Do not spawn workers from extension code.",
  };
}

function activeIncompleteTaskIds(tasks: TaskPlan[]): string[] {
  return tasks.filter((task) => task.status !== "done").map((task) => task.id);
}

function blockerInputForTask(
  ctx: ActivePlanContext,
  task: TaskPlan,
  input: RecordWaveResultInput,
): OpenBlockerInput {
  const reason =
    input.blocker?.description ?? (notesText(input.notes) || input.summary || `${task.id} reported ${input.status}`);
  return {
    roadmapId: ctx.roadmapId,
    milestoneId: ctx.milestoneId,
    ...(ctx.changeRequestId ? { changeRequestId: ctx.changeRequestId } : {}),
    taskId: task.id,
    waveId: ctx.activeWave.id,
    severity: "blocking",
    title: input.blocker?.title ?? `Task ${task.id} ${input.status}`,
    description: reason,
    createdBy: task.worker,
  };
}

export async function recordWaveResult(
  cwd: string,
  input: RecordWaveResultInput,
): Promise<RecordWaveResultResult> {
  const ctx = await activePlanContext(cwd, input);
  const task = ctx.activeTasks.find((candidate) => candidate.id === input.taskId);
  if (!task) throw new Error(`Task ${input.taskId} is not in active wave ${ctx.activeWave.id}`);
  if (ctx.activeWave.status === "complete") throw new Error(`Active wave ${ctx.activeWave.id} is already complete`);

  if (input.status === "completed") {
    await transition(cwd, {
      operation: "update_task_status",
      taskId: task.id,
      taskStatus: "done",
      ...(input.summary ? { summary: input.summary } : {}),
    });
    const updated = await activePlanContext(cwd, input);
    const remaining = activeIncompleteTaskIds(updated.activeTasks);
    if (remaining.length === 0) {
      await setProgress(cwd, updated, "wave_review", []);
      return {
        task_id: task.id,
        status: "done",
        wave_id: updated.activeWave.id,
        wave_status: updated.activeWave.status,
        progress_step: "wave_review",
      };
    }
    await setProgress(cwd, updated, "workers_running", remaining);
    return {
      task_id: task.id,
      status: "done",
      wave_id: updated.activeWave.id,
      wave_status: updated.activeWave.status,
      progress_step: "workers_running",
    };
  }

  await transition(cwd, {
    operation: "update_task_status",
    taskId: task.id,
    taskStatus: "blocked",
    ...(input.summary ? { summary: input.summary } : {}),
  });
  await transition(cwd, { operation: "update_wave_status", waveId: ctx.activeWave.id, waveStatus: "blocked" });
  const blocker = await openBlocker(cwd, blockerInputForTask(ctx, task, input));
  await setProgress(cwd, ctx, "resolving_blockers", [task.id], blocker.title);
  return {
    task_id: task.id,
    status: "blocked",
    wave_id: ctx.activeWave.id,
    wave_status: "blocked",
    progress_step: "resolving_blockers",
    blocker,
  };
}

async function assertNoOpenBlockingBlockers(cwd: string, ctx: ActivePlanContext): Promise<void> {
  const result = await listBlockers(cwd, {
    roadmapId: ctx.roadmapId,
    milestoneId: ctx.milestoneId,
    ...(ctx.changeRequestId ? { changeRequestId: ctx.changeRequestId } : {}),
    status: "open",
    severity: "blocking",
  });
  if (result.blockers.length > 0) {
    throw new Error(`Active plan has open blocking blockers: ${result.blockers.map((blocker) => blocker.title).join(", ")}`);
  }
}

function reviewPrompt(ctx: ActivePlanContext): string {
  const taskLines = ctx.activeTasks
    .map((task) => `- ${task.id}: ${task.title} (${task.worker}); owned files ${task.owned_files.join(", ") || "(none)"}; owned modules ${task.owned_modules.join(", ") || "(none)"}`)
    .join("\n");
  return `You are reviewer for roadmap-engineer wave ${ctx.activeWave.id}: ${ctx.activeWave.goal}.

Roadmap: ${ctx.roadmapId}
Milestone: ${ctx.milestoneId}
${ctx.changeRequestId ? `Change request: ${ctx.changeRequestId}\n` : ""}Review checkpoint:
${ctx.activeWave.review_checkpoint}

Wave exit criteria:
${ctx.activeWave.exit_criteria.map((item) => `- ${item}`).join("\n")}

Tasks in this wave:
${taskLines}

Acceptance criteria:
${ctx.plan.acceptance_criteria.map((item) => `- ${item}`).join("\n")}

Verification commands:
${ctx.plan.verification_commands.map((item) => `- ${item}`).join("\n")}

Review only this active wave. Verify completed work against task scope, ownership, shared interfaces, exit criteria, and acceptance criteria. Report passed or failed status with a summary and concrete findings for the orchestrator to record with roadmap_engineer_record_wave_review.`;
}

export async function prepareWaveReview(
  cwd: string,
  input: WaveOrchestrationTargetInput = {},
): Promise<PrepareWaveReviewResult> {
  await assertImplementationReady(cwd);
  const ctx = await activePlanContext(cwd, input);
  if (ctx.activeWave.status === "complete") throw new Error(`Active wave ${ctx.activeWave.id} is already complete`);
  if (ctx.activeWave.status === "blocked") throw new Error(`Active wave ${ctx.activeWave.id} is blocked`);
  await assertNoOpenBlockingBlockers(cwd, ctx);

  const incomplete = ctx.activeTasks.filter((task) => task.status !== "done");
  if (incomplete.length > 0) {
    throw new Error(`Active wave ${ctx.activeWave.id} still has incomplete tasks: ${incomplete.map((task) => task.id).join(", ")}`);
  }

  if (ctx.activeWave.status !== "reviewing") {
    await transition(cwd, { operation: "update_wave_status", waveId: ctx.activeWave.id, waveStatus: "reviewing" });
  }
  await setProgress(cwd, ctx, "wave_review", []);

  return {
    roadmap_id: ctx.roadmapId,
    milestone_id: ctx.milestoneId,
    ...(ctx.changeRequestId ? { change_request_id: ctx.changeRequestId } : {}),
    wave_id: ctx.activeWave.id,
    reviewer: "reviewer",
    prompt: reviewPrompt(ctx),
    tasks: ctx.activeTasks.map((task) => ({
      task_id: task.id,
      title: task.title,
      worker: task.worker,
      owned_files: task.owned_files,
      owned_modules: task.owned_modules,
      shared_interfaces: task.shared_interfaces,
    })),
  };
}

function reviewFindings(input: RecordWaveReviewInput): string[] {
  return input.findings && input.findings.length > 0 ? input.findings : [input.summary];
}

export async function recordWaveReview(
  cwd: string,
  input: RecordWaveReviewInput,
): Promise<RecordWaveReviewResult> {
  const ctx = await activePlanContext(cwd, input);
  const incomplete = ctx.activeTasks.filter((task) => task.status !== "done");
  if (incomplete.length > 0) {
    throw new Error(`Active wave ${ctx.activeWave.id} still has incomplete tasks: ${incomplete.map((task) => task.id).join(", ")}`);
  }

  if (input.status === "passed") {
    await assertNoOpenBlockingBlockers(cwd, ctx);
    await transition(cwd, {
      operation: "update_wave_status",
      waveId: ctx.activeWave.id,
      waveStatus: "complete",
      summary: input.summary,
    });
    await setProgress(cwd, ctx, "ready_for_next_wave", []);
    return {
      wave_id: ctx.activeWave.id,
      wave_status: "complete",
      progress_step: "ready_for_next_wave",
      blockers: [],
    };
  }

  const blockers: RoadmapBlocker[] = [];
  for (const finding of reviewFindings(input)) {
    blockers.push(await openBlocker(cwd, {
      roadmapId: ctx.roadmapId,
      milestoneId: ctx.milestoneId,
      ...(ctx.changeRequestId ? { changeRequestId: ctx.changeRequestId } : {}),
      waveId: ctx.activeWave.id,
      severity: "blocking",
      title: `Wave ${ctx.activeWave.id} review failed`,
      description: finding,
      createdBy: "reviewer",
    }));
  }
  await transition(cwd, {
    operation: "update_wave_status",
    waveId: ctx.activeWave.id,
    waveStatus: "blocked",
    summary: input.summary,
  });
  await setProgress(cwd, ctx, "resolving_blockers", [], input.summary);
  return {
    wave_id: ctx.activeWave.id,
    wave_status: "blocked",
    progress_step: "resolving_blockers",
    blockers,
  };
}
