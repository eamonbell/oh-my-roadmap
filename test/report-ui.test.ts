import { describe, expect, test } from "bun:test";
import { ScrollView } from "@oh-my-pi/pi-tui";
import { renderRoadmapDetailsFrame, type RoadmapDetailSummary } from "../src/extension/report-ui.ts";

function text(lines: readonly string[]): string {
  return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

function render(summary: RoadmapDetailSummary, width: number): string {
  return text(renderRoadmapDetailsFrame({
    summary,
    width,
    height: 80,
    scrollView: new ScrollView([], { height: 1, scrollbar: "auto" }),
  }));
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
  nextAction: "Collect worker notes for active tasks, then update progress to wave_review.",
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
    const issues = output.lastIndexOf("Issues");
    const usage = output.indexOf("Usage");
    const metadata = output.indexOf("Metadata");

    expect(nextAction).toBeGreaterThan(-1);
    expect(activeWork).toBeGreaterThan(nextAction);
    expect(issues).toBeGreaterThan(activeWork);
    expect(usage).toBeGreaterThan(issues);
    expect(metadata).toBeGreaterThan(usage);
    expect(output).toContain("Scope");
    expect(output).toContain("Usage");
    expect(output).toContain("implementation_orchestrator");
  });

  test("uses a two-column body on wide terminals", () => {
    const output = render(summary, 120);

    expect(output).toContain("Health");
    expect(output).toContain("Active Work");
    expect(output).toContain("Issues");
    expect(output).toContain("task-a [worker-light");
    expect(output).toContain("Cost");
    expect(output).toContain("Req");
    expect(output).toContain("Tokens");
    expect(output).toContain("Top agents");
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
