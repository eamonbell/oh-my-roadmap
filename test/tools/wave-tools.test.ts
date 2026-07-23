import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadState, transition } from "@oh-my-roadmap/core/store/index";
import { prepareWaveDispatch } from "@oh-my-roadmap/core/wave-orchestration/index";
import { approvedMilestone, createTempRoadmapCwd, removeTempRoadmapCwd } from "../state/helpers";
import { registeredTool, registerTools, toolContext } from "./helpers";

// Regression coverage for the Zod tool layer. The core recordWorkerDispatch/prepareWorkerRedispatch
// functions accept reworkOf via a TS intersection, but agents only ever reach them through the
// registered tools' Zod schemas. These tests go through that tool layer (unlike the core-level
// state tests) to guarantee reworkOf is actually reachable and persisted end-to-end.
describe("wave dispatch tools thread reworkOf through the Zod layer", () => {
  let cwd = "";

  beforeEach(async () => {
    cwd = await createTempRoadmapCwd();
  });

  afterEach(async () => {
    await removeTempRoadmapCwd(cwd);
    cwd = "";
  });

  test("omr_record_worker_dispatch persists WorkerRun.rework_of set via the tool schema", async () => {
    await approvedMilestone(cwd);
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);

    const tools = registerTools();
    const recordWorkerDispatchTool = registeredTool(tools, "omr_record_worker_dispatch");
    expect(recordWorkerDispatchTool).toBeDefined();
    expect(recordWorkerDispatchTool?.approval).toBe("write");

    const result = await recordWorkerDispatchTool!.execute(
      "record-worker-dispatch",
      {
        taskId: "t01-state",
        agentId: "rework-agent",
        jobId: "rework-job",
        reworkOf: "rework_abc123",
      },
      new AbortController().signal,
      undefined,
      toolContext(cwd),
    );

    // The tool result surfaces the run with rework_of populated.
    expect((result?.details as { run?: { rework_of?: string } } | undefined)?.run?.rework_of).toBe(
      "rework_abc123",
    );

    // And it round-trips through a full reload of persisted state.
    const state = await loadState(cwd);
    const run = state.milestone?.progress.worker_runs.find((r) => r.agent_id === "rework-agent");
    expect(run).toBeDefined();
    expect(run?.rework_of).toBe("rework_abc123");
  });

  test("omr_prepare_worker_redispatch schema accepts reworkOf and marks the assignment as rework", async () => {
    await approvedMilestone(cwd);
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);

    const tools = registerTools();
    const recordWorkerDispatchTool = registeredTool(tools, "omr_record_worker_dispatch");
    const prepareRedispatchTool = registeredTool(tools, "omr_prepare_worker_redispatch");
    expect(prepareRedispatchTool).toBeDefined();

    // Dispatch a worker, then fail its transport so the redispatch path is eligible.
    await recordWorkerDispatchTool!.execute(
      "record-worker-dispatch",
      { taskId: "t01-state", agentId: "agent-store", jobId: "job-store" },
      new AbortController().signal,
      undefined,
      toolContext(cwd),
    );
    const failTool = registeredTool(tools, "omr_record_worker_transport_failed");
    await failTool!.execute(
      "record-transport-failed",
      { taskId: "t01-state", jobId: "job-store", lastError: "socket closed" },
      new AbortController().signal,
      undefined,
      toolContext(cwd),
    );

    const result = await prepareRedispatchTool!.execute(
      "prepare-worker-redispatch",
      { taskId: "t01-state", reworkOf: "rework_xyz789" },
      new AbortController().signal,
      undefined,
      toolContext(cwd),
    );

    // The redispatch instructions must tell the caller to carry reworkOf onto the dispatch call.
    const details = result?.details as { instructions?: string } | undefined;
    expect(details?.instructions).toContain("reworkOf set to rework_xyz789");
  });
});
