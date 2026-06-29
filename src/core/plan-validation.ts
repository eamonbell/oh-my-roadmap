import type {
  ChangeRequest,
  MilestonePlan,
  TaskPlan,
  ValidationIssue,
  WavePlan,
} from "./types";

export function issue(code: string, message: string, path?: string): ValidationIssue {
  return path ? { code, message, path } : { code, message };
}

function validateTasksAndWaves(
  tasks: TaskPlan[],
  waves: WavePlan[],
  errors: ValidationIssue[],
): void {
  const taskIds = new Set<string>();
  const taskById = new Map<string, TaskPlan>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) errors.push(issue("task.duplicate", `Duplicate task id: ${task.id}`));
    taskIds.add(task.id);
    taskById.set(task.id, task);
    if (!task.worker) errors.push(issue("task.worker.missing", `Task ${task.id} must assign a worker`));
    if (task.owned_files.length === 0 && task.owned_modules.length === 0) {
      errors.push(issue("task.ownership.missing", `Task ${task.id} must own files or modules`));
    }
    if (task.depends_on.includes(task.id)) {
      errors.push(issue("task.dependency.self", `Task ${task.id} cannot depend on itself`));
    }
    for (const dependency of task.depends_on) {
      if (!taskIds.has(dependency) && !tasks.some((candidate) => candidate.id === dependency)) {
        errors.push(issue("task.dependency.unknown", `Task ${task.id} depends on unknown task ${dependency}`));
      }
    }
  }

  const waveIds = new Set<string>();
  const taskWaveIndex = new Map<string, number>();
  const scheduledTasks = new Set<string>();
  let activeWaveCount = 0;

  for (let index = 0; index < waves.length; index += 1) {
    const wave = waves[index];
    if (!wave) continue;
    if (waveIds.has(wave.id)) errors.push(issue("wave.duplicate", `Duplicate wave id: ${wave.id}`));
    waveIds.add(wave.id);
    if (["running", "reviewing"].includes(wave.status)) activeWaveCount += 1;

    const owned = new Map<string, string>();
    for (const taskId of wave.tasks) {
      const task = taskById.get(taskId);
      if (!task) {
        errors.push(issue("wave.task.unknown", `Wave ${wave.id} references unknown task ${taskId}`));
        continue;
      }
      if (scheduledTasks.has(taskId)) {
        errors.push(issue("wave.task.duplicate", `Task ${taskId} is scheduled in more than one wave`));
      }
      scheduledTasks.add(taskId);
      taskWaveIndex.set(taskId, index);
      for (const owner of [...task.owned_files, ...task.owned_modules]) {
        const previous = owned.get(owner);
        if (previous) {
          errors.push(
            issue(
              "wave.ownership.overlap",
              `Wave ${wave.id} has overlapping ownership for ${owner}: ${previous} and ${task.id}`,
            ),
          );
        }
        owned.set(owner, task.id);
      }
    }
  }

  if (activeWaveCount > 1) {
    errors.push(issue("wave.active.multiple", "Only one wave can be running or reviewing at a time"));
  }

  for (const task of tasks) {
    if (!scheduledTasks.has(task.id)) {
      errors.push(issue("wave.task.missing", `Task ${task.id} is not assigned to any wave`));
    }
  }

  for (const task of tasks) {
    const taskIndex = taskWaveIndex.get(task.id);
    if (taskIndex === undefined) continue;
    for (const dependency of task.depends_on) {
      const dependencyIndex = taskWaveIndex.get(dependency);
      if (dependencyIndex === undefined) continue;
      if (dependencyIndex >= taskIndex) {
        errors.push(
          issue(
            "task.dependency.order",
            `Task ${task.id} depends on ${dependency}, which is not scheduled in an earlier wave`,
          ),
        );
      }
    }
  }
  validateDependencyCycles(tasks, errors);

  const firstIncompleteIndex = waves.findIndex((wave) => wave.status !== "complete");
  if (firstIncompleteIndex !== -1) {
    for (let index = firstIncompleteIndex + 1; index < waves.length; index += 1) {
      const wave = waves[index];
      if (wave && wave.status !== "pending") {
        errors.push(
          issue(
            "wave.order.blocked",
            `Wave ${wave.id} cannot start before earlier waves are complete`,
          ),
        );
      }
    }
  }
}

function validateDependencyCycles(tasks: TaskPlan[], errors: ValidationIssue[]): void {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (taskId: string, path: string[]): void => {
    if (visiting.has(taskId)) {
      errors.push(issue("task.dependency.cycle", `Task dependency cycle detected: ${[...path, taskId].join(" -> ")}`));
      return;
    }
    if (visited.has(taskId)) return;
    const task = taskById.get(taskId);
    if (!task) return;

    visiting.add(taskId);
    for (const dependency of task.depends_on) visit(dependency, [...path, taskId]);
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const task of tasks) visit(task.id, []);
}

export function validateMilestonePlan(plan: MilestonePlan, errors: ValidationIssue[]): void {
  if (!plan.milestone_id) errors.push(issue("milestone.id.missing", "Milestone ID is required"));
  if (!plan.title) errors.push(issue("milestone.title.missing", "Milestone title is required"));
  if (plan.cleanup_policy !== "approval-gated") {
    errors.push(issue("milestone.cleanup.invalid", "Cleanup policy must be approval-gated"));
  }
  if (plan.open_questions.length > 0) {
    errors.push(issue("milestone.questions.open", "Milestone has open material questions"));
  }
  if (plan.verification_commands.length === 0) {
    errors.push(issue("milestone.verify.missing", "Milestone plan must define verification commands"));
  }
  if (plan.acceptance_criteria.length === 0) {
    errors.push(issue("milestone.acceptance.missing", "Milestone plan must define acceptance criteria"));
  }
  if (plan.tasks.length === 0) errors.push(issue("milestone.tasks.missing", "Milestone plan must define tasks"));
  if (plan.waves.length === 0) errors.push(issue("milestone.waves.missing", "Milestone plan must define waves"));
  validateTasksAndWaves(plan.tasks, plan.waves, errors);
}

export function validateChangeRequest(change: ChangeRequest, errors: ValidationIssue[]): void {
  if (change.status !== "draft" && change.approvals.length === 0) {
    errors.push(issue("change.approval.missing", "Change request implementation requires plan approval"));
  }
  validateMilestonePlan(
    {
      roadmap_id: change.roadmap_id,
      milestone_id: change.milestone_id,
      title: change.title,
      status: "milestone_approved",
      approvals: change.approvals,
      open_questions: [],
      verification_commands: change.verification_commands,
      acceptance_criteria: change.acceptance_criteria,
      cleanup_policy: "approval-gated",
      tasks: change.tasks,
      waves: change.waves,
    },
    errors,
  );
}
