import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerRoadmapUsageTracking } from "../packages/extension/src/extension/usage-tracking";
import { loadBudgetSummary } from "@oh-my-roadmap/core/budget-report";
import { roadmapDocPath, roadmapUsagePath, milestonePlanPath } from "@oh-my-roadmap/core/paths";
import { renderReport } from "@oh-my-roadmap/core/report/index";
import {
  createChangeRequest,
  initRoadmap,
  loadState,
  transition,
  updateRoadmap,
  type CreateMilestonePlanInput,
  writeMilestoneBudgetState,
  writeRoadmapBudgetState,
} from "@oh-my-roadmap/core/store/index";
import { recordMainUsage, recordTaskUsage } from "@oh-my-roadmap/core/usage";
import { validateRoadmapState } from "@oh-my-roadmap/core/validation";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { parseUsageArgs, renderUsageReport, showRoadmapUsage } from "../packages/extension/src/extension/commands/usage";

let cwd = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-usage-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

function milestoneInput(): CreateMilestonePlanInput {
  return {
    milestoneId: "m01-core",
    title: "Core milestone",
    verificationCommands: ["bun test"],
    acceptanceCriteria: ["Usage is tracked"],
    tasks: [
      {
        id: "t01",
        title: "Implement usage",
        objective: "Track usage.",
        implementation_notes: ["Add usage summaries."],
        done_criteria: ["Usage is visible."],
        verification_commands: ["bun test"],
        worker: "worker",
        status: "assigned",
        depends_on: [],
        owned_files: ["src/core/usage.ts"],
        owned_modules: [],
        shared_interfaces: ["RoadmapUsageSummary"],
        relevant_existing_code: [],
        shared_interface_contracts: [],
      },
    ],
    waves: [
      {
        id: "w01",
        goal: "Track usage.",
        exit_criteria: ["Usage tests pass."],
        review_checkpoint: "Review usage summary.",
        status: "pending",
        tasks: ["t01"],
      },
    ],
  };
}

async function approvedRoadmap(): Promise<void> {
  await initRoadmap(cwd, { roadmapId: "usage-roadmap", title: "Usage Roadmap" });
  await transition(cwd, {
    operation: "record_discovery",
    discovery: { findings: ["Inspected usage tracking surfaces."] },
  });
  await updateRoadmap(cwd, {
    goal: "Track roadmap usage.",
    successCriteria: ["Usage totals are visible in status."],
    constraints: ["Do not rewrite generated markdown artifacts."],
    nonGoals: ["Do not calculate provider prices locally."],
    context: ["Usage comes from OMP events."],
    evidence: ["TaskToolDetails carries usage."],
    risks: ["Some providers may omit USD cost."],
    milestones: [
      {
        id: "m01-core",
        title: "Core milestone",
        status: "planned",
        goal: "Add usage aggregation.",
        scope: ["Persist usage summaries."],
        non_goals: ["Do not create a per-run ledger."],
        evidence: ["src/core/usage.ts owns aggregation."],
        dependencies: [],
        risks: ["Malformed usage files should fail visibly."],
        acceptance_intent: ["Status includes usage totals."],
        verification_intent: ["Run bun test."],
      },
    ],
  });
  await transition(cwd, {
    operation: "record_roadmap_milestone_check",
    roadmapMilestoneCheck: {
      status: "passed",
      checkedBy: "roadmap-milestone-checker",
      summary: "Roadmap milestone check passed.",
      findings: [],
    },
  });
  await transition(cwd, { operation: "approve_roadmap", approver: "user" });
}

async function recordPassedWaveFlowCheck(): Promise<void> {
  await transition(cwd, {
    operation: "record_wave_flow_check",
    waveFlowCheck: {
      status: "passed",
      checkedBy: "wave-flow-checker",
      summary: "Wave flow check passed.",
      findings: [],
    },
  });
}

async function approvedMilestone(): Promise<void> {
  await approvedRoadmap();
  await transition(cwd, { operation: "start_milestone_planning" });
  await transition(cwd, { operation: "create_milestone_plan", milestone: milestoneInput() });
  await recordPassedWaveFlowCheck();
  await transition(cwd, { operation: "approve_milestone", approver: "user" });
}

describe("roadmap usage summaries", () => {
  test("normalizes missing usage and records main assistant usage without touching generated markdown", async () => {
    await approvedRoadmap();
    const beforeRoadmap = await fs.readFile(roadmapDocPath(cwd, "usage-roadmap"), "utf8");

    let state = await loadState(cwd);
    expect(state.usage?.total.requests).toBe(0);

    const message = {
      role: "assistant",
      responseId: "resp-main-1",
      provider: "openai",
      model: "gpt-test",
      timestamp: 1,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 10,
        reasoningTokens: 3,
        totalTokens: 135,
        cost: { total: 0.0015 },
      },
    };
    await recordMainUsage(cwd, message);
    await recordMainUsage(cwd, message);
    await recordMainUsage(cwd, { role: "assistant", responseId: "resp-no-usage" });

    state = await loadState(cwd);
    expect(state.usage?.total).toMatchObject({
      estimated_usd: 0.0015,
      usd_unavailable: false,
      requests: 1,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 5,
      cache_write_tokens: 10,
      reasoning_tokens: 3,
    });
    expect(state.usage?.by_agent.roadmap_planning?.requests).toBe(1);
    expect(await fs.readFile(roadmapDocPath(cwd, "usage-roadmap"), "utf8")).toBe(beforeRoadmap);

    const report = await renderReport(cwd);
    expect(report).toContain("Usage roadmap: $0.0015");
    expect(report).toContain("roadmap_planning");
  });

  test("records direct, nested, failed, and unknown-cost subagent usage in milestone totals", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    const beforePlan = await fs.readFile(milestonePlanPath(cwd, "usage-roadmap", "m01-core"), "utf8");

    const taskResult = {
      details: {
        results: [
          {
            id: "worker-run",
            agent: "worker",
            requests: 2,
            usage: {
              input: 10,
              output: 4,
              cacheRead: 1,
              cacheWrite: 2,
              reasoningTokens: 1,
              cost: { total: 0.2 },
            },
            extractedToolData: {
              task: [
                {
                  results: [
                    {
                      id: "nested-review",
                      agent: "reviewer",
                      requests: 1,
                      usage: {
                        input: 3,
                        output: 2,
                        cacheRead: 0,
                        cacheWrite: 0,
                        reasoningTokens: 0,
                        cost: { total: 0.03 },
                      },
                    },
                  ],
                },
              ],
            },
          },
          {
            id: "failed-run",
            agent: "worker",
            requests: 1,
            error: "failed after using tokens",
            usage: {
              input: 5,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              reasoningTokens: 0,
            },
          },
        ],
      },
    };

    await recordTaskUsage(cwd, "task-call-1", taskResult);
    await recordTaskUsage(cwd, "task-call-1", taskResult);

    const usage = (await loadState(cwd)).usage;
    const milestone = usage?.milestones["m01-core"];
    expect(milestone?.total).toMatchObject({
      estimated_usd: 0.23,
      usd_unavailable: true,
      requests: 4,
      input_tokens: 18,
      output_tokens: 6,
      cache_read_tokens: 1,
      cache_write_tokens: 2,
      reasoning_tokens: 1,
    });
    expect(milestone?.by_agent.worker?.requests).toBe(3);
    expect(milestone?.by_agent.worker?.usd_unavailable).toBe(true);
    expect(milestone?.by_agent.reviewer?.estimated_usd).toBe(0.03);
    expect(await fs.readFile(milestonePlanPath(cwd, "usage-roadmap", "m01-core"), "utf8")).toBe(beforePlan);
  });

  test("rolls change-request usage into parent milestone and roadmap totals", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await transition(cwd, { operation: "start_reviewing" });
    await createChangeRequest(cwd, {
      changeRequestId: "c01-fix",
      title: "Fix usage display",
      request: "Adjust usage display.",
      verificationCommands: ["bun test"],
      acceptanceCriteria: ["Change usage is tracked"],
      tasks: milestoneInput().tasks,
      waves: milestoneInput().waves,
    });

    await recordMainUsage(cwd, {
      role: "assistant",
      responseId: "resp-change-1",
      usage: {
        input: 7,
        output: 8,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 2,
        cost: { total: 0.04 },
      },
    });

    const usage = (await loadState(cwd)).usage;
    expect(usage?.total.estimated_usd).toBe(0.04);
    expect(usage?.milestones["m01-core"]?.total.estimated_usd).toBe(0.04);
    expect(usage?.milestones["m01-core"]?.change_requests["c01-fix"]?.total.estimated_usd).toBe(0.04);
    expect(usage?.by_agent.change_planning?.requests).toBe(1);
  });

  test("surfaces malformed usage files through state reads", async () => {
    await approvedRoadmap();
    await fs.writeFile(roadmapUsagePath(cwd, "usage-roadmap"), "[]\n", "utf8");

    await expect(loadState(cwd)).rejects.toThrow("Roadmap usage summary must be an object");
    const validation = await validateRoadmapState(cwd);
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]?.code).toBe("state.unreadable");
  });
});

describe("omr:rm-usage command", () => {
  function captureApi(): { api: ExtensionAPI; messages: string[] } {
    const messages: string[] = [];
    const api = {
      sendMessage(msg: { content: string }) {
        messages.push(msg.content);
      },
    } as unknown as ExtensionAPI;
    return { api, messages };
  }

  test("parses format and export-path arguments", () => {
    expect(parseUsageArgs("")).toEqual({ format: "markdown" });
    expect(parseUsageArgs("json")).toEqual({ format: "json" });
    expect(parseUsageArgs("json out/usage.json")).toEqual({ format: "json", exportPath: "out/usage.json" });
    expect(parseUsageArgs("usage.md")).toEqual({ format: "markdown", exportPath: "usage.md" });
    // A path token that equals a format word is still an export path once a format is consumed.
    expect(parseUsageArgs("json md")).toEqual({ format: "json", exportPath: "md" });
    expect(parseUsageArgs("markdown report")).toEqual({ format: "markdown", exportPath: "report" });
  });

  test("renders a markdown summary with roadmap and milestone totals", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await recordMainUsage(cwd, {
      role: "assistant",
      responseId: "resp-usage-md",
      usage: {
        input: 40,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        cost: { total: 0.05 },
      },
    });

    const state = await loadState(cwd);
    const markdown = renderUsageReport(state.usage!, { format: "markdown", milestoneId: "m01-core" });
    expect(markdown).toContain("# Roadmap usage: usage-roadmap");
    expect(markdown).toContain("- Usage roadmap: $0.0500");
    expect(markdown).toContain("- Usage milestone m01-core: $0.0500");

    const json = renderUsageReport(state.usage!, { format: "json" });
    expect(JSON.parse(json).roadmap_id).toBe("usage-roadmap");
  });

  test("preserves exact markdown output when no budget ceilings or overrides exist", async () => {
    await approvedMilestone();
    const state = await loadState(cwd);
    const options = { format: "markdown" as const, milestoneId: "m01-core" };
    const baseline = renderUsageReport(state.usage!, options);
    const emptyBudget = await loadBudgetSummary(cwd, {
      state,
      now: "2026-07-22T12:00:00.000Z",
    });

    expect(renderUsageReport(state.usage!, { ...options, budgetSummary: emptyBudget })).toBe(baseline);
  });

  test("appends configured roadmap and milestone budget lines after existing usage lines", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });
    await recordMainUsage(cwd, {
      role: "assistant",
      responseId: "resp-usage-budget",
      usage: {
        input: 80,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        cost: { total: 0.8 },
      },
    });
    await writeRoadmapBudgetState(cwd, "usage-roadmap", {
      ceilings: { tokens: 100, cost: 1 },
      overrides: [],
      time_tracking: { accumulated_ms: 0 },
    });
    await writeMilestoneBudgetState(cwd, "usage-roadmap", "m01-core", {
      ceilings: { tokens: 50 },
      overrides: [],
      time_tracking: { accumulated_ms: 0 },
    });

    const { api, messages } = captureApi();
    await showRoadmapUsage(api, { cwd } as ExtensionCommandContext, "");
    const content = messages[0]!;
    expect(content).toContain("- Budget roadmap tokens: spent 80 tokens; ceiling 100 tokens; remaining 20 tokens; 80% used; level warn");
    expect(content).toContain("- Budget roadmap cost: spent $0.8000; ceiling $1.0000; remaining $0.2000; 80% used; level warn");
    expect(content).toContain("- Budget milestone m01-core tokens: spent 80 tokens; ceiling 50 tokens; remaining -30 tokens; 160% used; level hard, over budget");
    expect(content.indexOf("Usage milestone m01-core")).toBeLessThan(content.indexOf("Budget roadmap tokens"));
  });

  test("prints the summary through the command handler", async () => {
    await approvedRoadmap();
    await recordMainUsage(cwd, {
      role: "assistant",
      responseId: "resp-usage-cmd",
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        cost: { total: 0.01 },
      },
    });

    const { api, messages } = captureApi();
    await showRoadmapUsage(api, { cwd } as ExtensionCommandContext, "");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("# Roadmap usage: usage-roadmap");
    expect(messages[0]).toContain("Usage roadmap: $0.0100");
  });

  test("exports the summary to a file when a path is provided", async () => {
    await approvedRoadmap();
    await recordMainUsage(cwd, {
      role: "assistant",
      responseId: "resp-usage-export",
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        cost: { total: 0.01 },
      },
    });

    const { api, messages } = captureApi();
    await showRoadmapUsage(api, { cwd } as ExtensionCommandContext, "json usage-export.json");
    const target = path.join(cwd, "usage-export.json");
    const written = await fs.readFile(target, "utf8");
    expect(JSON.parse(written).roadmap_id).toBe("usage-roadmap");
    expect(messages[0]).toContain("Exported json roadmap usage to");
  });

  test("reports when there is no active roadmap", async () => {
    const { api, messages } = captureApi();
    await showRoadmapUsage(api, { cwd } as ExtensionCommandContext, "");
    expect(messages[0]).toBe("No roadmap usage recorded yet.");
  });
});

describe("roadmap usage event tracking", () => {
  test("records mocked message_end and task tool events", async () => {
    await approvedMilestone();
    await transition(cwd, { operation: "start_implementation" });

    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void> | void>>();
    const api = {
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    } as unknown as ExtensionAPI;
    registerRoadmapUsageTracking(api);

    for (const handler of handlers.get("message_end") ?? []) {
      await handler({
        type: "message_end",
        message: {
          role: "assistant",
          responseId: "event-main",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            reasoningTokens: 0,
            cost: { total: 0.01 },
          },
        },
      }, { cwd } as ExtensionContext);
    }
    for (const handler of handlers.get("tool_execution_end") ?? []) {
      await handler({
        type: "tool_execution_end",
        toolCallId: "event-task",
        toolName: "task",
        isError: false,
        result: {
          details: {
            results: [
              {
                id: "event-worker",
                agent: "worker",
                requests: 1,
                usage: {
                  input: 3,
                  output: 4,
                  cacheRead: 0,
                  cacheWrite: 0,
                  reasoningTokens: 0,
                  cost: { total: 0.02 },
                },
              },
            ],
          },
        },
      }, { cwd } as ExtensionContext);
    }

    const usage = (await loadState(cwd)).usage;
    expect(usage?.by_agent.implementation_orchestrator?.estimated_usd).toBe(0.01);
    expect(usage?.by_agent.worker?.estimated_usd).toBe(0.02);
    expect(usage?.milestones["m01-core"]?.total.requests).toBe(2);
  });
});
