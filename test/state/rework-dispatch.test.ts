import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { transition } from "@oh-my-roadmap/core/store/index";
import {
  prepareWaveDispatch,
  prepareWorkerRedispatch,
  recordWorkerAbandoned,
  recordWorkerDispatch,
} from "@oh-my-roadmap/core/wave-orchestration/index";
import {
  approvedMilestone as approvedMilestoneForCwd,
  approvedRoadmap as approvedRoadmapForCwd,
  createTempRoadmapCwd,
  milestoneInput,
  recordPassedWaveFlowCheck as recordPassedWaveFlowCheckForCwd,
  removeTempRoadmapCwd,
  testWave,
} from "./helpers";

let cwd = "";

beforeEach(async () => {
  cwd = await createTempRoadmapCwd();
});

afterEach(async () => {
  await removeTempRoadmapCwd(cwd);
  cwd = "";
});

function approvedMilestone(): Promise<void> {
  return approvedMilestoneForCwd(cwd);
}

function approvedRoadmap(): Promise<void> {
  return approvedRoadmapForCwd(cwd);
}

function recordPassedWaveFlowCheck(summary?: string): Promise<void> {
  return recordPassedWaveFlowCheckForCwd(cwd, summary);
}

// Sets up a two-task wave (t01-state + t02-report) so the wave being dispatched has more
// than one concurrent worker in flight.
async function setUpMultiTaskWave(): Promise<void> {
  await approvedRoadmap();
  await transition(cwd, { operation: "start_milestone_planning" });
  const input = milestoneInput();
  input.tasks = [
    { ...input.tasks[0]! },
    { ...input.tasks[1]!, depends_on: [] },
  ];
  input.waves = [testWave("w01", ["t01-state", "t02-report"])];
  await transition(cwd, { operation: "create_milestone_plan", milestone: input });
  await recordPassedWaveFlowCheck();
  await transition(cwd, { operation: "approve_milestone", approver: "user" });
  await transition(cwd, { operation: "start_implementation" });
}

describe("rework_of marker on worker runs", () => {
  test("recordWorkerDispatch persists rework_of independently of replaces_agent_id", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);

    // rework_of alone, no replaces_agent_id.
    const reworkOnly = await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-rework",
      jobId: "job-rework",
      reworkOf: "rq-001",
    } as Parameters<typeof recordWorkerDispatch>[1]);
    expect(reworkOnly.run.rework_of).toBe("rq-001");
    expect(reworkOnly.run.replaces_agent_id).toBeUndefined();
  });

  test("recordWorkerDispatch can carry both rework_of and replaces_agent_id together", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store",
      jobId: "job-store",
    });
    await recordWorkerAbandoned(cwd, {
      taskId: "t01-state",
      jobId: "job-store",
      lastError: "peer gone",
    });

    const dispatch = await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store-2",
      jobId: "job-store-2",
      replacesAgentId: "agent-store",
      reworkOf: "rq-002",
    } as Parameters<typeof recordWorkerDispatch>[1]);

    expect(dispatch.run.replaces_agent_id).toBe("agent-store");
    expect(dispatch.run.rework_of).toBe("rq-002");
  });

  test("recordWorkerDispatch omits rework_of when not supplied", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);

    const dispatch = await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store",
      jobId: "job-store",
    });
    expect(dispatch.run.rework_of).toBeUndefined();
  });
});

describe("per-dispatch worker verification permission", () => {
  test("single-task wave: worker prompt permits owned-file verification_commands and always mandates LSP", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });

    // Default plan's w01 has exactly one task (t01-state).
    const result = await prepareWaveDispatch(cwd);
    expect(result.assignments).toHaveLength(1);
    const prompt = result.assignments[0]!.prompt;

    expect(prompt).toContain("Mandatory, in every dispatch: run LSP diagnostics");
    expect(prompt).toContain("You MAY run your task's own verification_commands");
    expect(prompt).toContain("no concurrent sibling to collide with");
    // The reviewer-verifies-only ban must be withheld for a single-task wave.
    expect(prompt).not.toContain("The wave reviewer owns all build and test execution");
  });

  test("multi-task wave: fresh dispatch withholds owned-file tests but still mandates LSP", async () => {
    await setUpMultiTaskWave();
    const result = await prepareWaveDispatch(cwd);
    expect(result.assignments).toHaveLength(2);

    for (const assignment of result.assignments) {
      expect(assignment.prompt).toContain("Mandatory, in every dispatch: run LSP diagnostics");
      // Owned-file verification_commands are withheld for a fresh multi-worker wave.
      expect(assignment.prompt).not.toContain("You MAY run your task's own verification_commands");
      expect(assignment.prompt).toContain(
        "Do NOT run builds, compilers, test suites, or these verification commands",
      );
      expect(assignment.prompt).toContain("The wave reviewer owns all build and test execution");
    }
  });

  test("a GENUINE rework redispatch (reworkOf set) permits owned-file tests even in a multi-task wave", async () => {
    await setUpMultiTaskWave();
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store",
      jobId: "job-store",
    });
    await recordWorkerAbandoned(cwd, {
      taskId: "t01-state",
      jobId: "job-store",
      lastError: "peer gone",
    });

    // Genuine rework linkage: reworkOf ties this redispatch to a post-review rework-queue item.
    const redispatch = await prepareWorkerRedispatch(cwd, {
      taskId: "t01-state",
      reworkOf: "rq-004",
    } as Parameters<typeof prepareWorkerRedispatch>[1]);
    const prompt = redispatch.assignment.prompt;

    expect(prompt).toContain("Mandatory, in every dispatch: run LSP diagnostics");
    expect(prompt).toContain("You MAY run your task's own verification_commands");
    expect(prompt).toContain("This is a rework dispatch: review has already run for this wave");
  });

  test("a plain transport-failure/abandon redispatch (no reworkOf) in a multi-task wave with a running sibling withholds owned-file tests", async () => {
    await setUpMultiTaskWave();
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store",
      jobId: "job-store",
    });
    // t02-report's worker is still running (no review has happened) — a genuine concurrent
    // sibling risk for t01-state's redispatch.
    await recordWorkerDispatch(cwd, {
      taskId: "t02-report",
      agentId: "agent-report",
      jobId: "job-report",
    });
    await recordWorkerAbandoned(cwd, {
      taskId: "t01-state",
      jobId: "job-store",
      lastError: "peer gone",
    });

    // No reworkOf: this is a plain transport-failure/abandon continuation, not tied to review.
    const redispatch = await prepareWorkerRedispatch(cwd, { taskId: "t01-state" });
    const prompt = redispatch.assignment.prompt;

    expect(prompt).toContain("Mandatory, in every dispatch: run LSP diagnostics");
    // Owned-file verification_commands must be withheld: no review has run, and the t02-report
    // sibling worker is still active, so a build/test could collide.
    expect(prompt).not.toContain("You MAY run your task's own verification_commands");
    expect(prompt).toContain(
      "Do NOT run builds, compilers, test suites, or these verification commands",
    );
    expect(prompt).toContain("The wave reviewer owns all build and test execution");
  });

  test("all prompts instruct the worker to record command receipts in its note", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    const single = await prepareWaveDispatch(cwd);
    expect(single.assignments[0]!.prompt).toContain("command receipts");

    await removeTempRoadmapCwd(cwd);
    cwd = await createTempRoadmapCwd();
    await setUpMultiTaskWave();
    const multi = await prepareWaveDispatch(cwd);
    for (const assignment of multi.assignments) {
      expect(assignment.prompt).toContain("command receipts");
    }
  });

  test("prepareWorkerRedispatch instructions mention reworkOf when passed through", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    await recordWorkerDispatch(cwd, {
      taskId: "t01-state",
      agentId: "agent-store",
      jobId: "job-store",
    });
    await recordWorkerAbandoned(cwd, {
      taskId: "t01-state",
      jobId: "job-store",
      lastError: "peer gone",
    });

    const redispatch = await prepareWorkerRedispatch(cwd, {
      taskId: "t01-state",
      reworkOf: "rq-003",
    } as Parameters<typeof prepareWorkerRedispatch>[1]);

    expect(redispatch.instructions).toContain("reworkOf set to rq-003");
    expect(redispatch.instructions).toContain("replacesAgentId set to agent-store");
  });
});
