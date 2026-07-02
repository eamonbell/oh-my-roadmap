import { describe, expect, test } from "bun:test";
import { ScrollView } from "@oh-my-pi/pi-tui";
import { RoadmapDetailsView, renderRoadmapDetailsFrame, type RoadmapDetailSummary } from "../packages/extension/src/extension/report-ui/index";

function text(lines: readonly string[]): string {
  return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

function renderedLines(
  summary: RoadmapDetailSummary,
  width: number,
  height = 80,
  activeTabIndex = 0,
  focus: "rail" | "main" = "rail",
  message = "",
): string[] {
  return renderRoadmapDetailsFrame({
    summary,
    width,
    height,
    scrollView: new ScrollView([], { height: 1, scrollbar: "auto" }),
    activeTabIndex,
    focus,
    message,
  }).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
}

function render(summary: RoadmapDetailSummary, width: number, activeTabIndex = 0): string {
  return text(renderedLines(summary, width, 80, activeTabIndex));
}

function testTui(): { tui: { terminal: { rows: number; columns: number }; requestRender(): void }; renders: () => number } {
  let renderCount = 0;
  return {
    tui: {
      terminal: { rows: 24, columns: 100 },
      requestRender() {
        renderCount += 1;
      },
    },
    renders: () => renderCount,
  };
}

const summary: RoadmapDetailSummary = {
  kind: "active",
  roadmap: {
    id: "demo",
    title: "Demo Roadmap",
    phase: "implementing",
    label: "demo (Demo Roadmap)",
  },
  active: {
    milestone: {
      id: "m01-core",
      title: "Core milestone",
      status: "implementing",
      label: "m01-core - Core milestone (implementing)",
    },
    changeRequest: null,
  },
  bypass: {
    active: false,
    label: "inactive",
  },
  qualityGate: {
    gate: "roadmap_milestone_check",
    status: "passed",
    label: "passed (checked revision 1, current revision 1)",
    roadmapRevision: 1,
    checkedRevision: 1,
    roadmapContentHash: "sha256:current",
    checkedContentHash: "sha256:current",
    eventId: "evt_test",
    history: [
      {
        id: "evt_test",
        at: "2026-06-30T12:00:00.000Z",
        type: "quality_gate.recorded",
        actor: "roadmap-milestone-checker",
        summary: "Quality gate roadmap_milestone_check recorded as passed.",
        label: "quality_gate.recorded evt_test: Quality gate roadmap_milestone_check recorded as passed.",
      },
    ],
  },
  validation: {
    valid: true,
    status: "valid",
    errors: [],
    warnings: [],
    issues: [],
  },
  gate: {
    valid: true,
    status: "open",
    errors: [],
    warnings: [
      {
        severity: "warning",
        code: "plan.warning",
        message: "Review checkpoint is pending.",
        label: "WARNING plan.warning: Review checkpoint is pending.",
      },
    ],
    issues: [
      {
        severity: "warning",
        code: "plan.warning",
        message: "Review checkpoint is pending.",
        label: "WARNING plan.warning: Review checkpoint is pending.",
      },
    ],
  },
  roadmapHealth: {
    status: "healthy",
    label: "healthy; 0 open blockers",
    activePhase: "implementing",
    validationStatus: "valid",
    implementationGateStatus: "open",
    qualityGateStatus: "passed",
    openBlockerCount: 0,
  },
  nextAction: {
    id: "progress:w01:collect-worker-notes",
    label: "Collect worker notes",
    description: "Collect worker notes for active tasks, then update progress to wave_review.",
    status: "agent_required",
    safe_to_apply: false,
    blockers: [],
    missing_inputs: [],
    scope: {
      roadmap_id: "demo",
      milestone_id: "m01-core",
      wave_id: "w01",
    },
  },
  nextCommand: {
    command: "/omr:ms-implement",
    description: "Collect worker notes for active tasks, then update progress to wave_review.",
    label: "/omr:ms-implement - Collect worker notes",
  },
  waves: {
    total: 2,
    counts: {
      pending: 1,
      running: 1,
      reviewing: 0,
      blocked: 0,
      complete: 0,
    },
    active: {
      id: "w01",
      status: "running",
      goal: "Build the UI",
      label: "w01 (running)",
    },
  },
  activeExecution: {
    activeWave: {
      id: "w01",
      status: "running",
      goal: "Build the UI",
      label: "w01 (running)",
    },
    progressStep: "workers_running",
    activeTasks: [
      {
        id: "task-a",
        worker: "worker-light",
        status: "started",
        title: "Build summary renderer",
        label: "task-a [started, worker-light] Build summary renderer",
      },
    ],
    waveCounts: {
      pending: 1,
      running: 1,
      reviewing: 0,
      blocked: 0,
      complete: 0,
    },
    taskCounts: {
      assigned: 0,
      started: 1,
      done: 0,
      blocked: 0,
    },
  },
  activeTasks: [
    {
      id: "task-a",
      worker: "worker-light",
      status: "started",
      title: "Build summary renderer",
      label: "task-a [started, worker-light] Build summary renderer",
    },
  ],
  milestones: [
    {
      id: "m01-core",
      title: "Core milestone",
      status: "implementing",
      label: "m01-core - Core milestone (implementing)",
      detail: "plan",
      waves: [
        {
          id: "w01",
          status: "running",
          goal: "Build the UI",
          label: "w01 (running)",
          tasks: [
            {
              id: "task-a",
              worker: "worker-light",
              status: "started",
              title: "Build summary renderer",
              label: "task-a [started, worker-light] Build summary renderer",
            },
          ],
        },
      ],
    },
    {
      id: "m02-followup",
      title: "Follow-up milestone",
      status: "planned",
      label: "m02-followup - Follow-up milestone (planned)",
      detail: "outline",
      waves: [],
    },
  ],
  blockers: [],
  canonicalBlockers: {
    counts: {
      open: 0,
      resolved: 1,
      deferred: 0,
    },
    open: [],
  },
  recentEvents: [
    {
      id: "evt_recent",
      at: "2026-06-30T12:01:00.000Z",
      type: "implementation.progress.updated",
      actor: "user",
      summary: "Implementation progress updated.",
      label: "implementation.progress.updated evt_recent: Implementation progress updated.",
    },
  ],
  availableControls: [
    {
      key: "a",
      label: "Apply safe next action",
      action: "apply_next_action",
      enabled: false,
      reason: "Next action is agent_required and safe_to_apply=false",
      tool: {
        name: "omr_apply_next_action",
        input: { actionId: "progress:w01:collect-worker-notes" },
      },
      prompt: "Call omr_apply_next_action with input:\n{}",
    },
    {
      key: "d",
      label: "Prepare wave dispatch",
      action: "insert_tool_call",
      enabled: true,
      tool: {
        name: "omr_prepare_wave_dispatch",
        input: { roadmapId: "demo", milestoneId: "m01-core" },
      },
      prompt: "Call omr_prepare_wave_dispatch with input:\n{}",
    },
  ],
  usage: {
    roadmap: {
      raw: {
        estimated_usd: 0.01,
        usd_unavailable: false,
        requests: 2,
        input_tokens: 50,
        output_tokens: 30,
        cache_read_tokens: 10,
        cache_write_tokens: 10,
        reasoning_tokens: 0,
      },
      label: "$0.0100, 2 req, 100 tok, in 50, out 30, cache 10/10, reasoning 0",
      costLabel: "$0.0100",
      totalTokens: 100,
    },
    topAgents: [
      {
        agent: "implementation_orchestrator",
        totals: {
          raw: {
            estimated_usd: 0.01,
            usd_unavailable: false,
            requests: 2,
            input_tokens: 50,
            output_tokens: 30,
            cache_read_tokens: 10,
            cache_write_tokens: 10,
            reasoning_tokens: 0,
          },
          label: "$0.0100, 2 req, 100 tok, in 50, out 30, cache 10/10, reasoning 0",
          costLabel: "$0.0100",
          totalTokens: 100,
        },
        label: "implementation_orchestrator: $0.0100, 2 req, 100 tok, in 50, out 30, cache 10/10, reasoning 0",
      },
    ],
    topAgentsLabel: "implementation_orchestrator: $0.0100, 2 req, 100 tok, in 50, out 30, cache 10/10, reasoning 0",
  },
};

describe("roadmap details renderer", () => {
  test("renders rail tabs with overview selected and focused by default", () => {
    const output = render(summary, 120);

    expect(output).toContain("Demo Roadmap");
    expect(output).toContain("Tabs *");
    expect(output).toContain("> Overview");
    expect(output).toContain("Plan");
    expect(output).toContain("Gates");
    expect(output).toContain("Usage");
    expect(output).toContain("Activity");
    expect(output).toContain("/omr:ms-implement - Collect worker notes");
    expect(output).not.toContain("omr_prepare_wave_dispatch");
  });

  test("renders the plan tab with all milestones and planned wave task rows", () => {
    const output = render(summary, 120, 1);

    expect(output).toContain("m01-core");
    expect(output).toContain("Core milestone");
    expect(output).toContain("w01 [running] Build the UI");
    expect(output).toContain("task-a [started, worker-light] Build summary renderer");
    expect(output).toContain("m02-followup");
    expect(output).toContain("outline only; run /omr:ms-plan");
  });

  test("renders organized usage detail without tool json", () => {
    const output = render(summary, 120, 3);

    expect(output).toContain("Roadmap");
    expect(output).toContain("Cost");
    expect(output).toContain("$0.0100");
    expect(output).toContain("Requests");
    expect(output).toContain("Tokens");
    expect(output).toContain("Input");
    expect(output).toContain("Output");
    expect(output).toContain("Cache");
    expect(output).toContain("Reasoning");
    expect(output).toContain("implementation_orchestrator");
    expect(output).not.toContain("omr_apply_next_action");
  });

  test("rail arrow keys switch tabs before enter activates main scrolling", () => {
    const { tui, renders } = testTui();
    const view = new RoadmapDetailsView(summary, tui as never, () => {});

    view.handleInput("\x1b[B");
    expect(text(view.render(100))).toContain("m01-core");
    expect(text(view.render(100))).toContain("> Plan");

    view.handleInput("\n");
    expect(text(view.render(100))).toContain("Main:");
    view.handleInput("\x1b[B");
    expect(text(view.render(100))).toContain("* Plan");
    expect(renders()).toBeGreaterThan(0);
  });

  test("escape returns from main to rail, then closes from rail", () => {
    const { tui } = testTui();
    let closeCount = 0;
    const view = new RoadmapDetailsView(summary, tui as never, () => {
      closeCount += 1;
    });

    view.handleInput("\n");
    expect(text(view.render(100))).toContain("Main:");
    view.handleInput("\x1b");
    expect(text(view.render(100))).toContain("Rail:");
    expect(closeCount).toBe(0);
    view.handleInput("\x1b");
    expect(closeCount).toBe(1);
  });

  test("action shortcuts report disabled state and call enabled controls globally", () => {
    const { tui } = testTui();
    const calls: string[] = [];
    const view = new RoadmapDetailsView(summary, tui as never, () => {}, (key: string) => {
      calls.push(key);
    });

    view.handleInput("a");
    expect(text(view.render(100))).toContain("[a] Apply safe next action disabled");
    expect(calls).toEqual([]);

    if (summary.kind !== "active") throw new Error("Expected active summary");
    const enabledSummary: RoadmapDetailSummary = {
      ...summary,
      nextAction: {
        ...summary.nextAction,
        status: "ready",
        safe_to_apply: true,
      },
      availableControls: summary.availableControls.map((control) => {
        if (control.key !== "a") return control;
        const { reason: _reason, ...rest } = control;
        return { ...rest, enabled: true };
      }),
    };
    view.setSummary(enabledSummary);
    view.handleInput("\n");
    view.handleInput("a");
    expect(calls).toEqual(["a"]);
  });

  test("fits rendered lines to the requested terminal dimensions", () => {
    const width = 200;
    const height = 18;
    const lines = renderedLines(summary, width, height);

    expect(lines).toHaveLength(height);
    expect(lines.every((line) => line.length <= width)).toBe(true);
  });

  test("renders empty summaries without parsing report text", () => {
    const output = render({
      kind: "empty",
      message: "No active roadmap. Run /omr:rm-new to start a gated roadmap workflow.",
    }, 80);

    expect(output).toContain("Roadmap Details");
    expect(output).toContain("Create a roadmap with /omr:rm-new.");
    expect(output).toContain("No active roadmap");
    expect(output).not.toContain("# oh-my-roadmap status");
  });
});
