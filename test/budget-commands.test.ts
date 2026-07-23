import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
  parseBudgetOverrideArgs,
  parseBudgetSetArgs,
  parseBudgetShowArgs,
} from "../packages/extension/src/extension/commands/budget";
import { registerRoadmapCommands } from "../packages/extension/src/extension/commands";
import {
  loadMilestoneBudgetState,
  loadRoadmapBudgetState,
  loadState,
} from "@oh-my-roadmap/core/store/index";
import {
  approvedMilestone,
  approvedRoadmap,
  createTempRoadmapCwd,
  removeTempRoadmapCwd,
} from "./state/helpers";

interface RegisteredTestCommand {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface Harness {
  commands: Map<string, RegisteredTestCommand>;
  sentMessages: Array<{ content: string; options: unknown }>;
  customMessages: Array<{ message: unknown; options: unknown }>;
}

function createHarness(): Harness {
  const commands = new Map<string, RegisteredTestCommand>();
  const sentMessages: Array<{ content: string; options: unknown }> = [];
  const customMessages: Array<{ message: unknown; options: unknown }> = [];
  const api = {
    on() { },
    registerCommand(name: string, command: RegisteredTestCommand) {
      commands.set(name, command);
    },
    sendUserMessage(content: string, options?: unknown) {
      sentMessages.push({ content, options });
    },
    sendMessage(message: unknown, options?: unknown) {
      customMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  registerRoadmapCommands(api);
  return { commands, sentMessages, customMessages };
}

function context(cwd: string, idle = true): ExtensionCommandContext {
  return {
    cwd,
    hasUI: true,
    isIdle: () => idle,
    waitForIdle: async () => { },
    ui: { notify() { } },
  } as unknown as ExtensionCommandContext;
}

function lastCommandMessage(harness: Harness): string {
  const message = harness.customMessages.at(-1)?.message as { content?: string } | undefined;
  if (!message?.content) throw new Error("Expected a command-result message.");
  return message.content;
}

let cwd = "";

beforeEach(async () => {
  cwd = await createTempRoadmapCwd();
});

afterEach(async () => {
  await removeTempRoadmapCwd(cwd);
});

describe("native budget commands", () => {
  test("registers native commands and sends custom results while idle or busy", async () => {
    const harness = createHarness();
    for (const name of ["omr:budget-show", "omr:budget-set", "omr:budget-override"]) {
      expect(harness.commands.get(name)?.description).toBeTruthy();
    }

    await harness.commands.get("omr:budget-show")?.handler("", context(cwd, true));
    await harness.commands.get("omr:budget-show")?.handler("", context(cwd, false));

    expect(harness.sentMessages).toEqual([]);
    expect(harness.customMessages).toHaveLength(2);
    expect(lastCommandMessage(harness)).toContain("No active budget ceilings or overrides.");
  });

  test("sets and shows active scope ceilings without prompting the model", async () => {
    await approvedMilestone(cwd);
    const harness = createHarness();

    await harness.commands.get("omr:budget-set")?.handler("roadmap tokens 2500", context(cwd));
    await harness.commands.get("omr:budget-set")?.handler("milestone time 1h30m", context(cwd));
    await harness.commands.get("omr:budget-set")?.handler("roadmap cost 10.50", context(cwd));
    await harness.commands.get("omr:budget-set")?.handler("roadmap cost unlimited", context(cwd));
    await harness.commands.get("omr:budget-show")?.handler("", context(cwd));
    expect(lastCommandMessage(harness)).toContain("Budget roadmap tokens");
    expect(lastCommandMessage(harness)).toContain("Budget milestone m01-core time");
    await harness.commands.get("omr:budget-show")?.handler("roadmap", context(cwd));

    const state = await loadState(cwd);
    const roadmap = await loadRoadmapBudgetState(cwd, state.roadmap!.roadmap_id);
    const milestone = await loadMilestoneBudgetState(cwd, state.roadmap!.roadmap_id, state.active!.milestone_id!);
    expect(roadmap?.ceilings.tokens).toBe(2500);
    expect(roadmap?.ceilings.cost).toBeUndefined();
    expect(milestone?.ceilings.time).toBe(5_400_000);
    expect(lastCommandMessage(harness)).toContain("Budget roadmap tokens");
    expect(lastCommandMessage(harness)).not.toContain("Budget milestone time");
    expect(harness.sentMessages).toEqual([]);
  });

  test("persists raise and one-shot overrides with default and explicit actors", async () => {
    await approvedRoadmap(cwd);
    const harness = createHarness();

    await harness.commands.get("omr:budget-set")?.handler("roadmap tokens 100", context(cwd));
    await harness.commands.get("omr:budget-override")?.handler(
      "raise roadmap tokens 150 capacity needed for release",
      context(cwd),
    );
    await harness.commands.get("omr:budget-override")?.handler(
      "one-shot roadmap --by operator finish the current task",
      context(cwd),
    );

    const roadmapId = (await loadState(cwd)).roadmap!.roadmap_id;
    const budget = await loadRoadmapBudgetState(cwd, roadmapId);
    expect(budget?.ceilings.tokens).toBe(150);
    expect(budget?.overrides).toMatchObject([
      { type: "raise_ceiling", granted_by: "user", reason: "capacity needed for release" },
      { type: "one_shot_continue", granted_by: "operator", reason: "finish the current task" },
    ]);
    expect(lastCommandMessage(harness)).toContain("one-shot continue");
    expect(harness.sentMessages).toEqual([]);
  });

  test("rejects malformed arguments before mutation and reports missing milestones", async () => {
    const harness = createHarness();

    expect(() => parseBudgetShowArgs("roadmap extra")).toThrow("Usage");
    expect(() => parseBudgetSetArgs("roadmap cost $5")).toThrow("Invalid cost");
    expect(() => parseBudgetOverrideArgs("raise roadmap tokens 100 --by operator")).toThrow("reason");
    expect(() => parseBudgetOverrideArgs("one-shot roadmap --unknown reason")).toThrow("Unknown override option");

    await approvedRoadmap(cwd);
    const roadmapId = (await loadState(cwd)).roadmap!.roadmap_id;
    await harness.commands.get("omr:budget-set")?.handler("milestone tokens 100", context(cwd));
    expect(lastCommandMessage(harness)).toContain("no active milestone");
    expect(await loadRoadmapBudgetState(cwd, roadmapId)).toBeUndefined();

    await harness.commands.get("omr:budget-set")?.handler("roadmap tokens 100", context(cwd));
    await harness.commands.get("omr:budget-set")?.handler("roadmap tokens 101", context(cwd));
    expect(lastCommandMessage(harness)).toContain("audited raise override");
    expect((await loadRoadmapBudgetState(cwd, roadmapId))?.ceilings.tokens).toBe(100);

    await harness.commands.get("omr:budget-set")?.handler("roadmap tokens 100 extra", context(cwd));
    expect(lastCommandMessage(harness)).toContain("Usage");
    expect((await loadRoadmapBudgetState(cwd, roadmapId))?.ceilings.tokens).toBe(100);
    expect(harness.sentMessages).toEqual([]);
  });
});
