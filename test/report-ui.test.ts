import { describe, expect, test } from "bun:test";
import { ScrollView } from "@oh-my-pi/pi-tui";
import { renderRoadmapDetailsFrame, type RoadmapDetailSummary } from "../src/extension/report-ui.ts";

function text(lines: readonly string[]): string {
  return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

function renderedLines(summary: RoadmapDetailSummary, width: number, height = 80): string[] {
  return renderRoadmapDetailsFrame({
    summary,
    width,
    height,
    scrollView: new ScrollView([], { height: 1, scrollbar: "auto" }),
  }).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
}

function render(summary: RoadmapDetailSummary, width: number): string {
  return text(renderedLines(summary, width));
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
        label: "worker-light started: Build summary renderer",
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
      label: "worker-light started: Build summary renderer",
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
        name: "roadmap_engineer_apply_next_action",
        input: { actionId: "progress:w01:collect-worker-notes" },
      },
      prompt: "Call roadmap_engineer_apply_next_action with input:\n{}",
    },
    {
      key: "d",
      label: "Prepare wave dispatch",
      action: "insert_tool_call",
      enabled: true,
      tool: {
        name: "roadmap_engineer_prepare_wave_dispatch",
        input: { roadmapId: "demo", milestoneId: "m01-core" },
      },
      prompt: "Call roadmap_engineer_prepare_wave_dispatch with input:\n{}",
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
  test("renders structured sections in the expected stacked order", () => {
    const output = render(summary, 80);

    expect(output).toContain("Demo Roadmap");
    expect(output).toContain("Roadmap   demo (Demo");
    expect(output).toContain("Phase     implementing");
    expect(output).toContain("↑/↓ scroll");

    const nextAction = output.indexOf("Next Action");
    const activeWork = output.indexOf("Active Work");
    const controls = output.indexOf("Controls");
    const qualityGate = output.indexOf("Quality Gate");
    const blockers = output.indexOf(" Blockers", qualityGate);
    const recentEvents = output.indexOf("Recent Events");
    const issues = output.lastIndexOf("Issues");
    const usage = output.indexOf("Usage");
    const metadata = output.indexOf("Metadata");

    expect(nextAction).toBeGreaterThan(-1);
    expect(activeWork).toBeGreaterThan(nextAction);
    expect(controls).toBeGreaterThan(activeWork);
    expect(qualityGate).toBeGreaterThan(controls);
    expect(blockers).toBeGreaterThan(qualityGate);
    expect(recentEvents).toBeGreaterThan(blockers);
    expect(issues).toBeGreaterThan(recentEvents);
    expect(usage).toBeGreaterThan(issues);
    expect(metadata).toBeGreaterThan(usage);
    expect(output).toContain("Scope");
    expect(output).toContain("Usage");
    expect(output).toContain("Status    passed");
    expect(output).toContain("Revision  1/1");
    expect(output).toContain("Event     evt_test");
    expect(output).toContain("[a] Apply safe next action");
    expect(output).toContain("roadmap_engineer_prepare_wave_dispatch");
    expect(output).toContain("Recent Events");
    expect(output).toContain("implementation.progress.updated");
    expect(output).toContain("implementation_orchestrator");
  });

  test("uses a two-column body on wide terminals", () => {
    const output = render(summary, 120);

    expect(output).toContain("Health");
    expect(output).toContain("Quality gate");
    expect(output).toContain("Quality Gate");
    expect(output).toContain("Active Work");
    expect(output).toContain("Controls");
    expect(output).toContain("Blockers");
    expect(output).toContain("Recent Events");
    expect(output).toContain("Issues");
    expect(output).toContain("task-a [worker-light");
    expect(output).toContain("Scope");
    expect(output).toContain("Usage");
  });

  test("stacks the rail above content when the terminal is narrow", () => {
    const output = render(summary, 60);

    expect(output).toContain("Health");
    expect(output).toContain("Next Action");
    expect(output.indexOf("Next Action")).toBeGreaterThan(output.indexOf("Health"));
    expect(renderedLines(summary, 60).some((line) => line.includes("Health") && line.includes("Next Action"))).toBe(false);
  });

  test("uses the full usage table on ultra-wide terminals without capping column growth", () => {
    const output = render(summary, 200);

    expect(output).toContain("Cost");
    expect(output).toContain("Req");
    expect(output).toContain("Tokens");
    expect(output).toContain("Top agents");
    expect(output).toContain("roadmap_engineer_prepare_wave_dispatch");
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
      message: "No active roadmap. Run /roadmap:new to start a gated roadmap workflow.",
    }, 80);

    expect(output).toContain("Roadmap Details");
    expect(output).toContain("Create a roadmap with /roadmap:new.");
    expect(output).toContain("No active roadmap");
    expect(output).not.toContain("# roadmap-engineer status");
  });
});
