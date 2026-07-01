import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initRoadmap,
  loadState,
  transition,
  updateRoadmap,
  type CreateMilestonePlanInput,
  type UpdateRoadmapInput,
} from "../../src/core/store/index";
import { roadmapStatePath } from "../../src/core/paths";
import type { CloseoutEvidence, RoadmapState } from "../../src/core/types";
import { readYamlFile, writeYamlFile } from "../../src/core/files";

export async function createTempRoadmapCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "roadmap-engineer-"));
}

export async function removeTempRoadmapCwd(cwd: string): Promise<void> {
  if (!cwd) return;
  await fs.rm(cwd, { recursive: true, force: true });
}

export function milestoneInput(): CreateMilestonePlanInput {
  return {
    milestoneId: "m01-core",
    title: "Core milestone",
    verificationCommands: ["bun test"],
    acceptanceCriteria: ["State validates", "Gate opens only during implementation"],
    tasks: [
      {
        id: "t01-state",
        title: "State engine",
        objective: "Persist roadmap state changes safely.",
        implementation_notes: ["Update state storage and lifecycle transitions."],
        done_criteria: ["State lifecycle operations remain valid."],
        verification_commands: ["bun test"],
        worker: "worker-light",
        status: "assigned",
        depends_on: [],
        owned_files: ["src/core/store.ts"],
        owned_modules: [],
        shared_interfaces: ["RoadmapState"],
      },
      {
        id: "t02-report",
        title: "Report engine",
        objective: "Render roadmap state and next actions.",
        implementation_notes: ["Update report output from loaded state."],
        done_criteria: ["Reports show current milestone status."],
        verification_commands: ["bun test"],
        worker: "worker-heavy",
        status: "assigned",
        depends_on: ["t01-state"],
        owned_files: ["src/core/report.ts"],
        owned_modules: [],
        shared_interfaces: ["LoadedState"],
      },
    ],
    waves: [
      {
        id: "w01",
        goal: "Implement state storage.",
        exit_criteria: ["State task is complete."],
        review_checkpoint: "Review state ownership and verification.",
        status: "pending",
        tasks: ["t01-state"],
      },
      {
        id: "w02",
        goal: "Implement reporting.",
        exit_criteria: ["Report task is complete."],
        review_checkpoint: "Review report output and next action.",
        status: "pending",
        tasks: ["t02-report"],
      },
    ],
  };
}

export function testWave(id: string, tasks: string[]): CreateMilestonePlanInput["waves"][number] {
  return {
    id,
    goal: `Complete ${id}.`,
    exit_criteria: [`${id} tasks are complete.`],
    review_checkpoint: `Review ${id} outputs.`,
    status: "pending",
    tasks,
  };
}

export function additionalMilestone(id: string, title: string): UpdateRoadmapInput["milestones"][number] {
  const base = roadmapInput().milestones[0]!;
  return {
    ...base,
    id,
    title,
    status: "planned",
    goal: `Complete ${title}.`,
    dependencies: ["m01-core"],
  };
}

export function closedEvidence(overrides: Partial<CloseoutEvidence> = {}): CloseoutEvidence {
  return {
    roadmap_id: "complex-refactor",
    milestone_id: "m01-core",
    status: "closed",
    acceptance_results: [
      { item: "State validates", status: "passed" },
      { item: "Gate opens only during implementation", status: "passed" },
    ],
    verification_results: [{ item: "bun test", status: "passed" }],
    worker_notes_reviewed: true,
    review_summary: "Worker notes and acceptance criteria were reviewed.",
    unresolved_risks: [],
    closed_by: "user",
    ...overrides,
  };
}

export function roadmapInput(overrides: Partial<UpdateRoadmapInput> = {}): UpdateRoadmapInput {
  return {
    goal: "Refactor roadmap-engineer state safely.",
    successCriteria: ["Roadmap approval requires concrete milestones."],
    constraints: ["Keep the implementation simple and direct."],
    nonGoals: ["Do not create milestone task plans during roadmap creation."],
    context: ["Reviewed src/core/store.ts and src/core/validation.ts."],
    evidence: ["Discovery recorded current state lifecycle behavior."],
    risks: ["Validation may block old incomplete roadmap states."],
    milestones: [
      {
        id: "m01-core",
        title: "Core milestone",
        status: "planned",
        goal: "Harden core roadmap state and validation.",
        scope: ["Add structured roadmap finalization."],
        non_goals: ["Do not implement milestone tasks in roadmap planning."],
        evidence: ["src/core/store.ts owns roadmap transitions."],
        dependencies: [],
        risks: ["Approval may fail until the generated roadmap is current."],
        acceptance_intent: ["Roadmap cannot be approved without concrete milestone outlines."],
        verification_intent: ["Run bun test."],
      },
    ],
    ...overrides,
  };
}

export async function approvedRoadmap(cwd: string): Promise<void> {
  await initRoadmap(cwd, { roadmapId: "complex-refactor", title: "Complex Refactor" });
  await transition(cwd, {
    operation: "record_discovery",
    discovery: { findings: ["Inspected local roadmap-engineer sources."] },
  });
  await updateRoadmap(cwd, roadmapInput());
  await recordPassedRoadmapMilestoneCheck(cwd);
  await transition(cwd, {
    operation: "approve_roadmap",
    approver: "user",
    summary: "Roadmap approved",
  });
}

export async function recordPassedWaveFlowCheck(cwd: string, summary = "Wave flow check passed."): Promise<void> {
  await transition(cwd, {
    operation: "record_wave_flow_check",
    waveFlowCheck: {
      status: "passed",
      checkedBy: "wave-flow-checker",
      summary,
      findings: [],
    },
  });
}

export async function recordPassedRoadmapMilestoneCheck(
  cwd: string,
  summary = "Roadmap milestone check passed.",
): Promise<void> {
  await transition(cwd, {
    operation: "record_roadmap_milestone_check",
    roadmapMilestoneCheck: {
      status: "passed",
      checkedBy: "roadmap-milestone-checker",
      summary,
      findings: [],
    },
  });
}

export async function approvedMilestone(cwd: string): Promise<void> {
  await approvedRoadmap(cwd);
  await transition(cwd, { operation: "start_milestone_planning" });
  await transition(cwd, { operation: "create_milestone_plan", milestone: milestoneInput() });
  await recordPassedWaveFlowCheck(cwd);
  await transition(cwd, {
    operation: "approve_milestone",
    approver: "user",
    summary: "Milestone approved",
  });
}

export async function manuallyWriteRoadmapState(cwd: string, update: (roadmap: RoadmapState) => void): Promise<void> {
  const state = await loadState(cwd);
  if (!state.roadmap) throw new Error("Expected roadmap state");
  const filePath = roadmapStatePath(cwd, state.roadmap.roadmap_id);
  const roadmap = await readYamlFile<RoadmapState>(filePath);
  update(roadmap);
  await writeYamlFile(filePath, roadmap);
}

export async function closeoutPhase(cwd: string): Promise<void> {
  await approvedMilestone(cwd);
  await transition(cwd, { operation: "start_implementation" });
  await transition(cwd, { operation: "start_reviewing" });
  await transition(cwd, { operation: "start_closeout" });
}
