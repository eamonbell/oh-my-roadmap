import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { nextActionPlan } from "../../src/core/report/index";
import {
  appendNote,
  createChangeRequest,
  loadState,
  transition,
} from "../../src/core/store/index";
import {
  prepareWaveDispatch,
  prepareWaveReview,
  recordWaveResult,
} from "../../src/core/wave-orchestration/index";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";
import {
  approvedMilestone as approvedMilestoneForCwd,
  approvedRoadmap as approvedRoadmapForCwd,
  closedEvidence,
  closeoutPhase as closeoutPhaseForCwd,
  createTempRoadmapCwd,
  milestoneInput,
  removeTempRoadmapCwd,
} from "./helpers";
import { registeredTool, registerTools, toolContext } from "../tools/helpers";

let cwd = "";

beforeEach(async () => {
  cwd = await createTempRoadmapCwd();
});

afterEach(async () => {
  await removeTempRoadmapCwd(cwd);
  cwd = "";
});

function resultText(result: AgentToolResult<unknown> | undefined): string {
  const block = result?.content?.[0];
  return block && block.type === "text" ? block.text : "";
}

describe("tool friction improvements", () => {
  test("validate tool surfaces the structured error list, not just a bare summary", async () => {
    await approvedRoadmapForCwd(cwd);
    await transition(cwd, { operation: "start_milestone_planning" });
    const input = milestoneInput();
    // Strip ownership from the first task so validation fails with a specific code.
    input.tasks[0] = { ...input.tasks[0]!, owned_files: [], owned_modules: [] };
    await transition(cwd, { operation: "create_milestone_plan", milestone: input });

    const tools = registerTools();
    const validateTool = registeredTool(tools, "roadmap_engineer_validate");
    const result = await validateTool?.execute(
      "validate",
      {},
      new AbortController().signal,
      undefined,
      toolContext(cwd),
    );

    const text = resultText(result);
    expect(text).toContain("Roadmap state is invalid.");
    // The specific reason must appear in the visible text (previously only render_report showed it).
    expect(text).toContain("ERROR task.ownership.missing");
    expect((result?.details as { valid: boolean }).valid).toBe(false);
  });

  test("validate tool reports a clean pass without error lines", async () => {
    await approvedMilestoneForCwd(cwd);
    const tools = registerTools();
    const validateTool = registeredTool(tools, "roadmap_engineer_validate");
    const result = await validateTool?.execute(
      "validate",
      {},
      new AbortController().signal,
      undefined,
      toolContext(cwd),
    );
    const text = resultText(result);
    expect(text).toContain("Roadmap state is valid.");
    expect(text).not.toContain("ERROR ");
  });

  test("record_closeout is blocked for a milestone outside the closeout phase", async () => {
    await approvedMilestoneForCwd(cwd);
    await transition(cwd, { operation: "start_implementation" });

    await expect(
      transition(cwd, { operation: "record_closeout", closeout: closedEvidence() }),
    ).rejects.toThrow("record_closeout requires phase closeout");
    await expect(
      transition(cwd, { operation: "record_closeout", closeout: closedEvidence() }),
    ).rejects.toThrow("start_reviewing then start_closeout");
  });

  test("record_closeout succeeds for a milestone in the closeout phase", async () => {
    await closeoutPhaseForCwd(cwd);
    await transition(cwd, { operation: "record_closeout", closeout: closedEvidence() });
    const state = await loadState(cwd);
    expect(state.closeout?.status).toBe("closed");
  });

  test("change-request closeout is unaffected by the milestone phase guard", async () => {
    await closeoutPhaseForCwd(cwd);
    await createChangeRequest(cwd, {
      changeRequestId: "c01-guard",
      title: "Guard-safe change",
      request: "Adjust behavior after review.",
      verificationCommands: ["bun test"],
      acceptanceCriteria: ["Requested delta is implemented"],
      tasks: [{ ...milestoneInput().tasks[0]!, id: "t01-guard", depends_on: [] }],
      waves: [
        {
          id: "w01",
          goal: "Complete the change.",
          exit_criteria: ["Change task complete."],
          review_checkpoint: "Review the change.",
          status: "pending",
          tasks: ["t01-guard"],
        },
      ],
    });
    // start_implementation for a change request leaves roadmap.phase at closeout; the guard
    // must not fire on the change-request branch regardless.
    await transition(cwd, { operation: "record_closeout", closeout: {
      ...closedEvidence({
        acceptance_results: [{ item: "Requested delta is implemented", status: "passed" }],
        verification_results: [{ item: "bun test", status: "passed" }],
      }),
      change_request_id: "c01-guard",
    } });
    const state = await loadState(cwd);
    expect(state.changeRequest?.closeout?.status).toBe("closed");
  });

  test("phase-transition errors name the remediation step", async () => {
    await approvedMilestoneForCwd(cwd);
    await transition(cwd, { operation: "start_implementation" });

    await expect(
      transition(cwd, { operation: "start_closeout" }),
    ).rejects.toThrow("Call start_reviewing to enter the reviewing phase first.");

    await transition(cwd, { operation: "start_reviewing" });
    await expect(
      transition(cwd, { operation: "complete_milestone" }),
    ).rejects.toThrow("Enter closeout via start_closeout");
  });

  test("next_action guides start_closeout from the reviewing phase", async () => {
    await approvedMilestoneForCwd(cwd);
    await transition(cwd, { operation: "start_implementation" });
    await transition(cwd, { operation: "start_reviewing" });

    const action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Enter closeout",
      status: "ready",
      safe_to_apply: true,
      tool: { input: { operation: "start_closeout" } },
    });
  });

  test("next_action distinguishes recorded vs closed closeout evidence in the closeout phase", async () => {
    await closeoutPhaseForCwd(cwd);

    // No evidence yet: prompt to record and close it.
    let action = await nextActionPlan(cwd);
    expect(action.label).toBe("Record closeout evidence");
    expect(action.description).toContain('status "closed"');
    expect(action.tool).toBeUndefined();

    // Recorded-but-not-closed: prompt to re-record as closed.
    await transition(cwd, {
      operation: "record_closeout",
      closeout: closedEvidence({ status: "recorded" }),
    });
    action = await nextActionPlan(cwd);
    expect(action.label).toBe("Record closeout evidence");
    expect(action.description).toContain("Re-record");

    // Closed: prompt to complete the milestone with a safe transition tool.
    await transition(cwd, {
      operation: "record_closeout",
      closeout: closedEvidence({ status: "closed" }),
    });
    action = await nextActionPlan(cwd);
    expect(action).toMatchObject({
      label: "Complete milestone",
      status: "ready",
      safe_to_apply: true,
      tool: { input: { operation: "complete_milestone" } },
    });
  });

  test("prepareWaveReview returns worker notes appended without an explicit waveId", async () => {
    await approvedMilestoneForCwd(cwd);
    await transition(cwd, { operation: "start_implementation" });
    await prepareWaveDispatch(cwd);
    // No waveId passed — this previously dropped the note from the review package.
    await appendNote(cwd, {
      kind: "worker",
      taskId: "t01-state",
      workerId: "alice",
      status: "resolved",
      title: "Note without waveId",
      body: "Implemented the store lock and ran bun test.",
    });
    await recordWaveResult(cwd, {
      taskId: "t01-state",
      status: "completed",
      summary: "State task completed.",
    });

    const review = await prepareWaveReview(cwd);
    expect(review.worker_notes.length).toBe(1);
    expect(review.worker_notes[0]?.title).toBe("Note without waveId");
    // The writer-side default should also stamp the active wave id onto the note.
    expect(review.worker_notes[0]?.metadata.wave_id).toBe("w01");
  });
});
