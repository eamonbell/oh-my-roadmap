import {
  listBlockers,
  loadState,
  nowIso,
  openBlocker,
  transition,
  writeChangeRequestRuntime,
  writeMilestoneRuntime,
  type OpenBlockerInput,
} from "./store";
import { withDiagnosticTiming } from "../diagnostics";
import type {
  ChangeRequest,
  ImplementationProgressStep,
  ImplementationWorkerName,
  LoadedState,
  MilestonePlan,
  RoadmapBlocker,
  TaskPlan,
  WavePlan,
  WorkerRun,
  WorkerRunStatus,
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
  active_runs: WorkerRun[];
  instructions: string;
}

export interface RecordWorkerDispatchInput extends WaveOrchestrationTargetInput {
  taskId: string;
  agentId: string;
  jobId: string;
}

export interface RecordWorkerRunStatusInput extends WaveOrchestrationTargetInput {
  taskId: string;
  agentId?: string;
  jobId?: string;
  lastError?: string;
}

export interface RecordWorkerRunResult {
  task_id: string;
  wave_id: string;
  run: WorkerRun;
  progress_step: ImplementationProgressStep;
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
const ACTIVE_WORKER_RUN_STATUSES = new Set<WorkerRunStatus>(["running", "transport_failed"]);

function activeWorkerRuns(plan: MilestonePlan | ChangeRequest): WorkerRun[] {
  return plan.progress.worker_runs.filter((run) => ACTIVE_WORKER_RUN_STATUSES.has(run.status));
}

function hasOverlap(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function updateTaskStatusLocal(tasks: TaskPlan[], taskId: string, status: TaskPlan["status"]): TaskPlan[] {
  let found = false;
  const updated = tasks.map((task) => {
    if (task.id !== taskId) return task;
    found = true;
    return { ...task, status };
  });
  if (!found) throw new Error(`Unknown task: ${taskId}`);
  return updated;
}

async function writePlanRuntime(cwd: string, plan: MilestonePlan | ChangeRequest): Promise<void> {
  if ("change_request_id" in plan) {
    await writeChangeRequestRuntime(cwd, plan);
    return;
  }
  await writeMilestoneRuntime(cwd, plan);
}

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
  return await withDiagnosticTiming({
    component: "core",
    operation: "wave.prepareWaveDispatch",
    cwd,
    slowMs: 250,
  }, async () => {
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
    const activeRuns = activeWorkerRuns(ctx.plan).filter((run) => run.wave_id === ctx.activeWave.id);
    if (activeRuns.length > 0) {
      await setProgress(cwd, ctx, "workers_running", activeRuns.map((run) => run.task_id));
      return {
        roadmap_id: ctx.roadmapId,
        milestone_id: ctx.milestoneId,
        ...(ctx.changeRequestId ? { change_request_id: ctx.changeRequestId } : {}),
        wave_id: ctx.activeWave.id,
        wave_goal: ctx.activeWave.goal,
        progress_step: "workers_running",
        assignments: [],
        active_runs: activeRuns,
        instructions:
          "Do not redispatch tasks with active worker runs. First check the current session's background jobs and IRC peers for each run's job_id or agent_id. If neither background jobs nor IRC peers list the run, record it abandoned immediately; do not poll, probe, or wait. Only poll or probe runs that exist in the current session. If an existing current-session run has a transport failure, record transport_failed, wait up to 2 minutes for recovery, then record abandoned before redispatching only that task.",
      };
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
      active_runs: [],
      instructions:
        "Dispatch each assignment as a background job using the assignment's exact worker and prompt. Immediately call roadmap_engineer_record_worker_dispatch with the returned agentId and jobId before polling workers.",
    };
  });
}

function requireTaskInActiveWave(ctx: ActivePlanContext, taskId: string): TaskPlan {
  const task = ctx.activeTasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Task ${taskId} is not in active wave ${ctx.activeWave.id}`);
  return task;
}

function requireActiveWorkerRun(
  ctx: ActivePlanContext,
  input: RecordWorkerRunStatusInput,
): WorkerRun {
  const matches = activeWorkerRuns(ctx.plan).filter((run) =>
    run.task_id === input.taskId &&
    (input.agentId === undefined || run.agent_id === input.agentId) &&
    (input.jobId === undefined || run.job_id === input.jobId)
  );
  if (matches.length === 0) throw new Error(`Task ${input.taskId} has no matching active worker run`);
  if (matches.length > 1) throw new Error(`Task ${input.taskId} has multiple matching active worker runs; include agentId or jobId`);
  const run = matches[0];
  if (!run) throw new Error(`Task ${input.taskId} has no matching active worker run`);
  return run;
}

function replaceWorkerRun(runs: WorkerRun[], replacement: WorkerRun): WorkerRun[] {
  return runs.map((run) =>
    run.task_id === replacement.task_id && run.agent_id === replacement.agent_id && run.job_id === replacement.job_id
      ? replacement
      : run
  );
}

async function writeProgressWithRuns(
  cwd: string,
  ctx: ActivePlanContext,
  workerRuns: WorkerRun[],
  activeTaskIds: string[],
  tasks: TaskPlan[] = ctx.plan.tasks,
  step: ImplementationProgressStep = ctx.plan.progress.step,
): Promise<void> {
  await writePlanRuntime(cwd, {
    ...ctx.plan,
    tasks,
    progress: {
      ...ctx.plan.progress,
      active_wave_id: ctx.activeWave.id,
      step,
      active_task_ids: activeTaskIds,
      worker_runs: workerRuns,
      updated_at: nowIso(),
    },
  });
}

function assertNoActiveOwnershipOverlap(ctx: ActivePlanContext, task: TaskPlan): void {
  for (const run of activeWorkerRuns(ctx.plan)) {
    if (run.task_id === task.id) throw new Error(`Task ${task.id} already has an active worker run`);
    if (hasOverlap(task.owned_files, run.owned_files)) {
      throw new Error(`Task ${task.id} overlaps active worker run ${run.task_id} owned files`);
    }
    if (hasOverlap(task.owned_modules, run.owned_modules)) {
      throw new Error(`Task ${task.id} overlaps active worker run ${run.task_id} owned modules`);
    }
  }
}

export async function recordWorkerDispatch(
  cwd: string,
  input: RecordWorkerDispatchInput,
): Promise<RecordWorkerRunResult> {
  return await withDiagnosticTiming({
    component: "core",
    operation: "wave.recordWorkerDispatch",
    cwd,
    slowMs: 250,
    metadata: { task_id: input.taskId, agent_id: input.agentId, job_id: input.jobId },
  }, async () => {
    const ctx = await activePlanContext(cwd, input);
    const task = requireTaskInActiveWave(ctx, input.taskId);
    assertTaskDispatchFields(task);
    assertDependenciesComplete(ctx.plan, task);
    assertNoActiveOwnershipOverlap(ctx, task);

    const now = nowIso();
    const run: WorkerRun = {
      task_id: task.id,
      wave_id: ctx.activeWave.id,
      worker: task.worker,
      agent_id: input.agentId,
      job_id: input.jobId,
      owned_files: task.owned_files,
      owned_modules: task.owned_modules,
      status: "running",
      started_at: now,
      updated_at: now,
    };
    const tasks = updateTaskStatusLocal(ctx.plan.tasks, task.id, "started");
    const activeTaskIds = Array.from(new Set([...ctx.plan.progress.active_task_ids, task.id]));
    await writeProgressWithRuns(cwd, ctx, [...ctx.plan.progress.worker_runs, run], activeTaskIds, tasks, "workers_running");
    return {
      task_id: task.id,
      wave_id: ctx.activeWave.id,
      run,
      progress_step: "workers_running",
    };
  });
}

export async function recordWorkerTransportFailed(
  cwd: string,
  input: RecordWorkerRunStatusInput,
): Promise<RecordWorkerRunResult> {
  return await withDiagnosticTiming({
    component: "core",
    operation: "wave.recordWorkerTransportFailed",
    cwd,
    slowMs: 250,
    metadata: { task_id: input.taskId },
  }, async () => {
    const ctx = await activePlanContext(cwd, input);
    const current = requireActiveWorkerRun(ctx, input);
    const run: WorkerRun = {
      ...current,
      status: "transport_failed",
      updated_at: nowIso(),
      ...(input.lastError ? { last_error: input.lastError } : {}),
    };
    await writeProgressWithRuns(
      cwd,
      ctx,
      replaceWorkerRun(ctx.plan.progress.worker_runs, run),
      Array.from(new Set([...ctx.plan.progress.active_task_ids, run.task_id])),
      ctx.plan.tasks,
      "workers_running",
    );
    return {
      task_id: run.task_id,
      wave_id: run.wave_id,
      run,
      progress_step: "workers_running",
    };
  });
}

export async function recordWorkerAbandoned(
  cwd: string,
  input: RecordWorkerRunStatusInput,
): Promise<RecordWorkerRunResult> {
  return await withDiagnosticTiming({
    component: "core",
    operation: "wave.recordWorkerAbandoned",
    cwd,
    slowMs: 250,
    metadata: { task_id: input.taskId },
  }, async () => {
    const ctx = await activePlanContext(cwd, input);
    const current = requireActiveWorkerRun(ctx, input);
    const run: WorkerRun = {
      ...current,
      status: "abandoned",
      updated_at: nowIso(),
      ...(input.lastError ? { last_error: input.lastError } : current.last_error ? { last_error: current.last_error } : {}),
    };
    const activeTaskIds = ctx.plan.progress.active_task_ids.filter((taskId) => taskId !== run.task_id);
    await writeProgressWithRuns(
      cwd,
      ctx,
      replaceWorkerRun(ctx.plan.progress.worker_runs, run),
      activeTaskIds,
      ctx.plan.tasks,
      activeTaskIds.length > 0 ? "workers_running" : "dispatching",
    );
    return {
      task_id: run.task_id,
      wave_id: run.wave_id,
      run,
      progress_step: activeTaskIds.length > 0 ? "workers_running" : "dispatching",
    };
  });
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

function closeWorkerRunForTask(plan: MilestonePlan | ChangeRequest, taskId: string, status: WorkerRunStatus): WorkerRun[] {
  const now = nowIso();
  let closed = false;
  return plan.progress.worker_runs.map((run) => {
    if (closed || run.task_id !== taskId || !ACTIVE_WORKER_RUN_STATUSES.has(run.status)) return run;
    closed = true;
    return {
      ...run,
      status,
      updated_at: now,
    };
  });
}

export async function recordWaveResult(
  cwd: string,
  input: RecordWaveResultInput,
): Promise<RecordWaveResultResult> {
  return await withDiagnosticTiming({
    component: "core",
    operation: "wave.recordWaveResult",
    cwd,
    slowMs: 250,
    metadata: { task_id: input.taskId, status: input.status },
  }, async () => {
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
      const workerRuns = closeWorkerRunForTask(updated.plan, task.id, "completed");
      if (remaining.length === 0) {
        await writeProgressWithRuns(cwd, updated, workerRuns, [], updated.plan.tasks, "wave_review");
        return {
          task_id: task.id,
          status: "done",
          wave_id: updated.activeWave.id,
          wave_status: updated.activeWave.status,
          progress_step: "wave_review",
        };
      }
      await writeProgressWithRuns(cwd, updated, workerRuns, remaining, updated.plan.tasks, "workers_running");
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
    const updated = await activePlanContext(cwd, input);
    const workerRuns = closeWorkerRunForTask(updated.plan, task.id, input.status === "failed" ? "failed" : "blocked");
    await writePlanRuntime(cwd, {
      ...updated.plan,
      progress: {
        ...updated.plan.progress,
        active_wave_id: updated.activeWave.id,
        step: "resolving_blockers",
        active_task_ids: [task.id],
        worker_runs: workerRuns,
        blocked_reason: blocker.title,
        updated_at: nowIso(),
      },
    });
    return {
      task_id: task.id,
      status: "blocked",
      wave_id: ctx.activeWave.id,
      wave_status: "blocked",
      progress_step: "resolving_blockers",
      blocker,
    };
  });
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
  return await withDiagnosticTiming({
    component: "core",
    operation: "wave.prepareWaveReview",
    cwd,
    slowMs: 250,
  }, async () => {
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
  });
}

function normalizeReviewText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function reviewBlockingFindings(input: RecordWaveReviewInput): string[] {
  const findings = input.findings && input.findings.length > 0 ? input.findings : [input.summary];
  return findings.flatMap((finding) => {
    const normalized = normalizeReviewText(finding);
    const upper = normalized.toUpperCase();
    if (
      upper.startsWith("PASS:") ||
      upper.startsWith("INFO:") ||
      upper.startsWith("NON_BLOCKING:") ||
      upper.startsWith("NON-BLOCKING:")
    ) {
      return [];
    }
    if (upper.startsWith("BLOCKING:")) {
      const stripped = normalizeReviewText(normalized.slice("BLOCKING:".length));
      return stripped ? [stripped] : [];
    }
    return normalized ? [normalized] : [];
  });
}

function sameReviewBlocker(blocker: RoadmapBlocker, ctx: ActivePlanContext, title: string, description: string): boolean {
  return (
    blocker.roadmap_id === ctx.roadmapId &&
    blocker.milestone_id === ctx.milestoneId &&
    blocker.change_request_id === ctx.changeRequestId &&
    blocker.wave_id === ctx.activeWave.id &&
    normalizeReviewText(blocker.title) === normalizeReviewText(title) &&
    normalizeReviewText(blocker.description) === normalizeReviewText(description)
  );
}

export async function recordWaveReview(
  cwd: string,
  input: RecordWaveReviewInput,
): Promise<RecordWaveReviewResult> {
  return await withDiagnosticTiming({
    component: "core",
    operation: "wave.recordWaveReview",
    cwd,
    slowMs: 250,
    metadata: { status: input.status },
  }, async () => {
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
    const existingBlockers = await listBlockers(cwd, {
      roadmapId: ctx.roadmapId,
      milestoneId: ctx.milestoneId,
      ...(ctx.changeRequestId ? { changeRequestId: ctx.changeRequestId } : {}),
      waveId: ctx.activeWave.id,
    });
    for (const finding of reviewBlockingFindings(input)) {
      const title = `Wave ${ctx.activeWave.id} review failed`;
      const existing = existingBlockers.blockers.find((blocker) => sameReviewBlocker(blocker, ctx, title, finding));
      if (existing) {
        blockers.push(existing);
        continue;
      }
      blockers.push(await openBlocker(cwd, {
        roadmapId: ctx.roadmapId,
        milestoneId: ctx.milestoneId,
        ...(ctx.changeRequestId ? { changeRequestId: ctx.changeRequestId } : {}),
        waveId: ctx.activeWave.id,
        severity: "blocking",
        title,
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
  });
}
