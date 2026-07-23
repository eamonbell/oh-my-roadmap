import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";
import { decisionsPath } from "@oh-my-roadmap/core/paths";
import { initRoadmap, loadRoadmapBlockers, loadState, transition, updateRoadmap } from "@oh-my-roadmap/core/store/index";
import {
  prepareWaveDispatch,
  prepareWaveReview,
  recordWaveResult,
  recordWaveReview,
} from "@oh-my-roadmap/core/wave-orchestration/index";
import { approvedMilestone } from "../state/helpers";
import { registeredTool, registerTools, roadmapInput, toolContext } from "./helpers";

async function captureRejection(run: () => Promise<unknown> | undefined): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the tool call to reject");
}

function resultText(result: AgentToolResult<unknown> | undefined): string {
  const block = result?.content?.[0];
  return block && block.type === "text" ? block.text : "";
}

describe("roadmap action tools", () => {
  test("registers action tools with expected approval modes", () => {
    const tools = registerTools();

    const openBlockerTool = registeredTool(tools, "omr_open_blocker");
    const resolveBlockerTool = registeredTool(tools, "omr_resolve_blocker");
    const deferBlockerTool = registeredTool(tools, "omr_defer_blocker");
    const listBlockersTool = registeredTool(tools, "omr_list_blockers");
    const prepareWaveDispatchTool = registeredTool(tools, "omr_prepare_wave_dispatch");
    const recordWorkerDispatchTool = registeredTool(tools, "omr_record_worker_dispatch");
    const recordWorkerTransportFailedTool = registeredTool(tools, "omr_record_worker_transport_failed");
    const recordWorkerAbandonedTool = registeredTool(tools, "omr_record_worker_abandoned");
    const recordReviewerDispatchTool = registeredTool(tools, "omr_record_reviewer_dispatch");
    const recordWaveResultTool = registeredTool(tools, "omr_record_wave_result");
    const prepareWaveReviewTool = registeredTool(tools, "omr_prepare_wave_review");
    const recordWaveReviewTool = registeredTool(tools, "omr_record_wave_review");
    const applyNextActionTool = registeredTool(tools, "omr_apply_next_action");
    expect(openBlockerTool?.approval).toBe("write");
    expect(resolveBlockerTool?.approval).toBe("write");
    expect(deferBlockerTool?.approval).toBe("write");
    expect(listBlockersTool?.approval).toBe("read");
    expect(prepareWaveDispatchTool?.approval).toBe("write");
    expect(recordWorkerDispatchTool?.approval).toBe("write");
    expect(recordWorkerTransportFailedTool?.approval).toBe("write");
    expect(recordWorkerAbandonedTool?.approval).toBe("write");
    expect(recordReviewerDispatchTool?.approval).toBe("write");
    expect(recordWaveResultTool?.approval).toBe("write");
    expect(prepareWaveReviewTool?.approval).toBe("write");
    expect(recordWaveReviewTool?.approval).toBe("write");
    expect(applyNextActionTool?.approval).toBe("write");
  });

  test("opens, lists, resolves, and defers canonical blockers through tools", async () => {
    const tools = registerTools();

    const openBlockerTool = registeredTool(tools, "omr_open_blocker");
    const resolveBlockerTool = registeredTool(tools, "omr_resolve_blocker");
    const deferBlockerTool = registeredTool(tools, "omr_defer_blocker");
    const listBlockersTool = registeredTool(tools, "omr_list_blockers");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-tools-"));
    try {
      await initRoadmap(cwd, { roadmapId: "tool-roadmap", title: "Tool Roadmap" });
      await fs.writeFile(
        decisionsPath(cwd, "tool-roadmap"),
        "# Decision Register\n\n## Compact context\n\nUse snippets before full bodies.\n",
        "utf8",
      );

      const opened = await openBlockerTool?.execute(
        "open-blocker",
        {
          title: "Tool blocker",
          description: "Tool callers need a canonical blocker.",
          taskId: "t-tool",
          createdBy: "tool-test",
        },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      const openedId = (opened?.details as { id?: string } | undefined)?.id;
      expect(opened?.details).toMatchObject({
        severity: "blocking",
        status: "open",
        task_id: "t-tool",
      });
      expect(openedId).toMatch(/^blk_/);

      const listed = await listBlockersTool?.execute(
        "list-blockers",
        { status: "open", severity: "blocking", taskId: "t-tool" },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(listed?.details).toMatchObject({
        total: 1,
        returned: 1,
        blockers: [{ id: openedId }],
      });

      const resolved = await resolveBlockerTool?.execute(
        "resolve-blocker",
        { blockerId: openedId, resolution: "The tool blocker was resolved." },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(resolved?.details).toMatchObject({
        id: openedId,
        status: "resolved",
        resolution: "The tool blocker was resolved.",
      });

      const deferred = await openBlockerTool?.execute(
        "open-deferred-blocker",
        {
          title: "Deferred tool blocker",
          description: "This blocker can wait.",
        },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      const deferredId = (deferred?.details as { id?: string } | undefined)?.id;
      const deferredResult = await deferBlockerTool?.execute(
        "defer-blocker",
        { blockerId: deferredId, deferReason: "Accepted follow-up risk." },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(deferredResult?.details).toMatchObject({
        id: deferredId,
        status: "deferred",
        defer_reason: "Accepted follow-up risk.",
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("prepare_wave_dispatch before start_implementation appends the start-implementation next action", async () => {
    const tools = registerTools();
    const prepareWaveDispatchTool = registeredTool(tools, "omr_prepare_wave_dispatch");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-dispatch-gate-"));
    try {
      // Milestone is approved but implementation is not legally open yet.
      await approvedMilestone(cwd);

      const message = await captureRejection(() =>
        prepareWaveDispatchTool?.execute(
          "prepare-dispatch",
          {},
          new AbortController().signal,
          undefined,
          toolContext(cwd),
        ),
      );
      // The original implementation-gate failure is preserved.
      expect(message).toContain("Implementation gate is closed");
      // ...and the tool appends the next executable action.
      expect(message).toContain("Next action: Start implementation via omr_transition");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("prepare_wave_dispatch after a passed review dispatches the next wave with no intervening transition", async () => {
    const tools = registerTools();
    const prepareWaveDispatchTool = registeredTool(tools, "omr_prepare_wave_dispatch");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-dispatch-complete-"));
    try {
      await approvedMilestone(cwd);
      await transition(cwd, { operation: "start_implementation" });
      await prepareWaveDispatch(cwd);
      await recordWaveResult(cwd, {
        taskId: "t01-state",
        status: "completed",
        summary: "State task completed.",
      });
      await prepareWaveReview(cwd);
      await recordWaveReview(cwd, {
        status: "passed",
        summary: "Wave implementation passed review.",
      });
      // R6: recordWaveReview(passed) auto-advances progress to w02, so the dispatch tool
      // succeeds immediately — no "already complete" error and no intervening
      // update_implementation_progress transition.

      const dispatched = await prepareWaveDispatchTool?.execute(
        "prepare-dispatch",
        {},
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(dispatched?.details).toMatchObject({ wave_id: "w02" });
      const assignments = (dispatched?.details as { assignments?: Array<{ task_id: string }> } | undefined)
        ?.assignments;
      expect(assignments?.map((assignment) => assignment.task_id)).toContain("t02-report");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("record_reviewer_dispatch persists a durable reviewer run for the active wave", async () => {
    const tools = registerTools();
    const recordReviewerDispatchTool = registeredTool(tools, "omr_record_reviewer_dispatch");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-reviewer-dispatch-"));
    try {
      await approvedMilestone(cwd);
      await transition(cwd, { operation: "start_implementation" });
      await prepareWaveDispatch(cwd);

      const recorded = await recordReviewerDispatchTool?.execute(
        "record-reviewer-dispatch",
        { agentId: "agent-rev-1", jobId: "job-rev-1" },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(recorded?.details).toMatchObject({
        wave_id: "w01",
        run: { wave_id: "w01", agent_id: "agent-rev-1", job_id: "job-rev-1", status: "active" },
      });

      const state = await loadState(cwd);
      expect(state.milestone?.progress.reviewer_runs).toMatchObject([
        { wave_id: "w01", agent_id: "agent-rev-1", job_id: "job-rev-1", status: "active" },
      ]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("applies the current safe next action through the apply tool", async () => {
    const tools = registerTools();
    const nextActionTool = registeredTool(tools, "omr_next_action");
    const applyNextActionTool = registeredTool(tools, "omr_apply_next_action");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-apply-next-action-tool-"));
    try {
      await initRoadmap(cwd, { roadmapId: "tool-apply-roadmap", title: "Tool Apply Roadmap" });
      await transition(cwd, {
        operation: "record_discovery",
        discovery: { findings: ["Inspected apply-next-action wiring."] },
      });
      await updateRoadmap(cwd, roadmapInput());
      await transition(cwd, {
        operation: "record_roadmap_milestone_check",
        roadmapMilestoneCheck: {
          status: "passed",
          checkedBy: "roadmap-milestone-checker",
          summary: "Milestone flow is coherent and buildable.",
          findings: [],
        },
      });
      await transition(cwd, { operation: "approve_roadmap", approver: "user" });

      const nextAction = await nextActionTool?.execute(
        "next-action",
        {},
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      const actionId = (nextAction?.details as { plan?: { id?: string } } | undefined)?.plan?.id;
      expect(nextAction?.details).toMatchObject({
        plan: {
          label: "Start milestone planning",
          status: "ready",
          safe_to_apply: true,
        },
      });

      const applied = await applyNextActionTool?.execute(
        "apply-next-action",
        { actionId },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(applied?.details).toMatchObject({
        plan: { id: actionId },
        state: { roadmap: { phase: "milestone_planning" } },
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("R13: omr_append_note accepts blocker_status and persists a canonical blocker", async () => {
    const tools = registerTools();
    const appendNoteTool = registeredTool(tools, "omr_append_note");
    expect(appendNoteTool?.description).toContain("blocker_status");
    expect(appendNoteTool?.description).toContain("irrelevant for ordinary non-blocking notes");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-append-note-"));
    try {
      await approvedMilestone(cwd);
      await transition(cwd, { operation: "start_implementation" });

      const result = await appendNoteTool?.execute(
        "append-note",
        {
          kind: "review",
          title: "Blocking review finding",
          body: "The wave changed unowned files.",
          blocking: true,
          blocker_status: "open",
        },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );

      expect(result?.details).toMatchObject({ filePath: expect.any(String) });

      const blockers = await loadRoadmapBlockers(cwd, "complex-refactor");
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toMatchObject({
        status: "open",
        title: "Blocking review finding",
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("R15: omr_open_blocker returns a rich receipt with next_actions", async () => {
    const tools = registerTools();
    const openBlockerTool = registeredTool(tools, "omr_open_blocker");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-open-blocker-receipt-"));
    try {
      await initRoadmap(cwd, { roadmapId: "receipt-roadmap", title: "Receipt Roadmap" });
      await fs.writeFile(
        decisionsPath(cwd, "receipt-roadmap"),
        "# Decision Register\n\n## Compact context\n\nUse snippets before full bodies.\n",
        "utf8",
      );

      const opened = await openBlockerTool?.execute(
        "open-blocker",
        {
          title: "Receipt blocker",
          description: "Verify the rich receipt shape.",
          createdBy: "tool-test",
        },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );

      // next_actions must be present as a field (it may be empty depending on workflow
      // state), and the receipt text always keeps the original human summary as a prefix.
      expect(Array.isArray((opened?.details as { next_actions?: unknown } | undefined)?.next_actions)).toBe(true);
      const text = resultText(opened);
      expect(text.startsWith("Opened blocker")).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("R15: omr_record_wave_review preserves the core auto-advance next_actions hint", async () => {
    const tools = registerTools();
    const recordWaveReviewTool = registeredTool(tools, "omr_record_wave_review");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-record-wave-review-receipt-"));
    try {
      await approvedMilestone(cwd);
      await transition(cwd, { operation: "start_implementation" });
      await prepareWaveDispatch(cwd);
      await recordWaveResult(cwd, {
        taskId: "t01-state",
        status: "completed",
        summary: "State task completed.",
      });
      await prepareWaveReview(cwd);

      const reviewed = await recordWaveReviewTool?.execute(
        "record-wave-review",
        { status: "passed", summary: "Wave implementation passed review." },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );

      const details = reviewed?.details as
        | { next_actions?: Array<{ label?: string; tool?: { name?: string } }> }
        | undefined;
      expect(details?.next_actions?.length).toBeGreaterThan(0);
      // The core recordWaveReview computes a precise, concrete auto-advance hint (with a
      // real omr_transition tool payload) when a wave passes and a next wave exists.
      // receiptResult must preserve it rather than overwrite it with a generically
      // recomputed (and in this state, empty) hint.
      expect(details?.next_actions?.[0]?.tool?.name).toBe("omr_transition");
      const text = resultText(reviewed);
      expect(text).toContain("Next action:");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("R15: omr_record_worker_dispatch returns a rich receipt with next_actions", async () => {
    const tools = registerTools();
    const recordWorkerDispatchTool = registeredTool(tools, "omr_record_worker_dispatch");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-record-worker-dispatch-receipt-"));
    try {
      await approvedMilestone(cwd);
      await transition(cwd, { operation: "start_implementation" });
      await prepareWaveDispatch(cwd);

      const recorded = await recordWorkerDispatchTool?.execute(
        "record-worker-dispatch",
        { taskId: "t01-state", agentId: "agent-1", jobId: "job-1" },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );

      expect(Array.isArray((recorded?.details as { next_actions?: unknown } | undefined)?.next_actions)).toBe(true);
      const text = resultText(recorded);
      expect(text.startsWith("Recorded worker dispatch for t01-state.")).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("R15: omr_record_scout_finding returns a rich receipt with next_actions", async () => {
    const tools = registerTools();
    const recordScoutFindingTool = registeredTool(tools, "omr_record_scout_finding");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-record-scout-finding-receipt-"));
    try {
      await initRoadmap(cwd, { roadmapId: "scout-receipt-roadmap", title: "Scout Receipt Roadmap" });

      const result = await recordScoutFindingTool?.execute(
        "record-scout-finding",
        {
          subsystem: "auth",
          summary: "Auth subsystem overview.",
          findings: ["Uses signed JWT sessions."],
        },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );

      const details = result?.details as { id?: string; next_actions?: unknown } | undefined;
      expect(Array.isArray(details?.next_actions)).toBe(true);
      const text = resultText(result);
      expect(text.startsWith(`Recorded scout finding ${details?.id} for auth.`)).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("R15: omr_prepare_closeout hints that start_closeout must run before record_closeout", async () => {
    const tools = registerTools();
    const prepareCloseoutTool = registeredTool(tools, "omr_prepare_closeout");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-prepare-closeout-hint-"));
    try {
      // Mirrors the production ordering bug: omr_prepare_closeout can succeed while the
      // milestone is still in the `reviewing` phase, before `start_closeout` has run —
      // but `record_closeout` requires the `closeout` phase.
      await approvedMilestone(cwd);
      await transition(cwd, { operation: "start_implementation" });
      await transition(cwd, { operation: "start_reviewing" });

      const result = await prepareCloseoutTool?.execute(
        "prepare-closeout",
        {},
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );

      const text = resultText(result);
      expect(text).toContain("Call omr_transition start_closeout before record_closeout.");
      const details = result?.details as { next_operation?: string; ordering_hint?: string } | undefined;
      expect(details?.next_operation).toBe("record_closeout");
      expect(details?.ordering_hint).toBe("Call omr_transition start_closeout before record_closeout.");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("R15: omr_prepare_closeout omits ordering_hint once record_closeout is no longer the next op", async () => {
    const tools = registerTools();
    const prepareCloseoutTool = registeredTool(tools, "omr_prepare_closeout");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-prepare-closeout-no-hint-"));
    try {
      await approvedMilestone(cwd);
      await transition(cwd, { operation: "start_implementation" });
      await transition(cwd, { operation: "start_reviewing" });
      await transition(cwd, { operation: "start_closeout" });

      const before = await prepareCloseoutTool?.execute(
        "prepare-closeout-before",
        {},
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      const exampleCloseout = (before?.details as { example_closeout?: unknown } | undefined)?.example_closeout;

      await transition(cwd, {
        operation: "record_closeout",
        closeout: exampleCloseout,
      } as Parameters<typeof transition>[1]);

      const after = await prepareCloseoutTool?.execute(
        "prepare-closeout-after",
        {},
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );

      const details = after?.details as { next_operation?: string; ordering_hint?: string } | undefined;
      expect(details?.next_operation).not.toBe("record_closeout");
      expect(details?.ordering_hint).toBeUndefined();
      const text = resultText(after);
      expect(text).not.toContain("Call omr_transition start_closeout before record_closeout.");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
