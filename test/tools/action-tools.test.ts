import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decisionsPath } from "@oh-my-roadmap/core/paths";
import { initRoadmap, transition, updateRoadmap } from "@oh-my-roadmap/core/store/index";
import { registeredTool, registerTools, roadmapInput, toolContext } from "./helpers";

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
});
