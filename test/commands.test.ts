import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionWidgetContent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { registerRoadmapCommands } from "../src/extension/commands";
import { initRoadmap, openBlocker } from "../src/core/store/index";

interface RegisteredTestCommand {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface SentUserMessage {
  content: string;
  options: unknown;
}

interface SentCustomMessage {
  message: unknown;
  options: unknown;
}

const PROMPT_COMMANDS = [
  "roadmap:new",
  "roadmap:resume",
  "roadmap:status",
  "roadmap:amend",
  "roadmap:reopen",
  "roadmap:repair",
  "milestone:plan",
  "milestone:implement",
  "milestone:status",
  "milestone:close",
  "bypass:request",
  "bypass:clear",
  "change:request",
  "change:status",
  "change:close",
  "blocker:list",
  "blocker:status",
  "blocker:resolve",
  "blocker:defer",
] as const;

function createHarness(): {
  commands: Map<string, RegisteredTestCommand>;
  sentMessages: SentUserMessage[];
  customMessages: SentCustomMessage[];
  api: ExtensionAPI;
} {
  const commands = new Map<string, RegisteredTestCommand>();
  const sentMessages: SentUserMessage[] = [];
  const customMessages: SentCustomMessage[] = [];
  const api = {
    on() {},
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

  return { commands, sentMessages, customMessages, api };
}

function testContext(cwd: string, idle = true, ui: Record<string, unknown> = {}, hasUI = true): ExtensionCommandContext {
  return {
    cwd,
    hasUI,
    isIdle: () => idle,
    waitForIdle: async () => {},
    ui: {
      notify(message: string) {
        throw new Error(`Unexpected toast notification: ${message}`);
      },
      ...ui,
    },
  } as unknown as ExtensionCommandContext;
}

async function testCwd(): Promise<string> {
  return await Bun.fileURLToPath(new URL(".", import.meta.url));
}

function expectFindingsReportInstruction(content: string, commandName: string): void {
  expect(content).toContain("Before finishing this slash-command turn:");
  expect(content).toContain("roadmap_engineer_submit_findings_report exactly once");
  expect(content).toContain(`Use title: "/${commandName} result".`);
  expect(content).toContain("outcome, next commands/actions, and any blocker/error state");
}

describe("roadmap commands", () => {
  test("roadmap:new queues an agent command prompt with user arguments", async () => {
    const { commands, sentMessages, customMessages } = createHarness();
    const command = commands.get("roadmap:new");
    expect(command).toBeDefined();

    await command?.handler(
      "Add billing workflows",
      testContext(await testCwd()),
    );

    expect(sentMessages).toHaveLength(1);
    expect(customMessages).toHaveLength(0);
    const sent = sentMessages[0];
    if (!sent) throw new Error("Expected a sent message");
    expect(sent.options).toBeUndefined();
    const content = sent.content;
    expect(content).toContain("You are operating the roadmap-engineer OMP extension command /roadmap:new.");
    expect(content).toContain("User arguments:\nAdd billing workflows");
    expect(content).toContain("No active roadmap. Run /roadmap:new to start a gated roadmap workflow.");
    expect(content).toContain("multiple meaningful deliverables or workstreams");
    expect(content).toContain("do not create a separate milestone for one small edit");
    expect(content).toContain("roadmap-milestone-checker");
    expect(content).toContain("record_roadmap_milestone_check");
    expect(content).toContain(
      "Only call roadmap_engineer_validate and ask for roadmap approval after the recorded roadmap-milestone check has passed",
    );
    expectFindingsReportInstruction(content, "roadmap:new");
  });

  test("roadmap:reopen sends command-specific reopen instructions", async () => {
    const { commands, sentMessages, customMessages } = createHarness();
    const command = commands.get("roadmap:reopen");
    expect(command).toBeDefined();

    await command?.handler(
      "Add migration milestone",
      testContext(await testCwd()),
    );

    expect(sentMessages).toHaveLength(1);
    expect(customMessages).toHaveLength(0);
    const sent = sentMessages[0];
    if (!sent) throw new Error("Expected a sent message");
    expect(sent.options).toBeUndefined();
    const content = sent.content;
    expect(content).toContain("You are operating the roadmap-engineer OMP extension command /roadmap:reopen.");
    expect(content).toContain("operation reopen_roadmap");
    expect(content).toContain("required reopen reason");
    expect(content).toContain("roadmap_engineer_update_roadmap");
    expect(content).toContain("roadmap_engineer_validate");
    expect(content).toContain("explicit roadmap reapproval");
    expect(content).toContain("roadmap-milestone-checker");
    expect(content).toContain("record_roadmap_milestone_check");
    expect(content).toContain(
      "Only call roadmap_engineer_validate and ask for roadmap approval after the recorded roadmap-milestone check has passed",
    );
    expectFindingsReportInstruction(content, "roadmap:reopen");
  });

  test("roadmap:repair sends command-specific repair instructions", async () => {
    const { commands, sentMessages, customMessages } = createHarness();
    const command = commands.get("roadmap:repair");
    expect(command).toBeDefined();

    await command?.handler(
      "State hash drift after manual recovery",
      testContext(await testCwd()),
    );

    expect(sentMessages).toHaveLength(1);
    expect(customMessages).toHaveLength(0);
    const sent = sentMessages[0];
    if (!sent) throw new Error("Expected a sent message");
    expect(sent.options).toBeUndefined();
    const content = sent.content;
    expect(content).toContain("You are operating the roadmap-engineer OMP extension command /roadmap:repair.");
    expect(content).toContain("roadmap_engineer_validate");
    expect(content).toContain("roadmap_content_hash");
    expect(content).toContain("roadmap.md");
    expect(content).toContain("roadmap_milestone_check");
    expect(content).toContain("rerun roadmap-milestone-checker");
    expect(content).toContain("roadmap_engineer_repair_roadmap");
    expect(content).toContain("Do not call reopen_roadmap");
    expectFindingsReportInstruction(content, "roadmap:repair");
  });

  test("milestone:plan prompts for detailed test coverage decisions", async () => {
    const { commands, sentMessages, customMessages } = createHarness();
    const command = commands.get("milestone:plan");
    expect(command).toBeDefined();

    await command?.handler(
      "",
      testContext(await testCwd()),
    );

    expect(sentMessages).toHaveLength(1);
    expect(customMessages).toHaveLength(0);
    const sent = sentMessages[0];
    if (!sent) throw new Error("Expected a sent message");
    expect(sent.options).toBeUndefined();
    const content = sent.content;
    expect(content).toContain("what test coverage they want");
    expect(content).toContain("which areas should create tests");
    expect(content).toContain("what coverage is intentionally deferred or not required");
    expect(content).toContain("compact orientation");
    expect(content).toContain("roadmap sections, plan sections");
    expect(content).toContain("do not call reopen_roadmap");
    expect(content).toContain("start_milestone_planning to advance from the completed milestone");
    expect(content).toContain("Do not pad the milestone plan with filler tasks");
    expect(content).toContain("every task must directly implement the approved roadmap milestone scope");
    expectFindingsReportInstruction(content, "milestone:plan");
  });

  test("milestone:implement keeps user questions in the orchestrator role", async () => {
    const { commands, sentMessages, customMessages } = createHarness();
    const command = commands.get("milestone:implement");
    expect(command).toBeDefined();

    await command?.handler(
      "",
      testContext(await testCwd()),
    );

    expect(sentMessages).toHaveLength(1);
    expect(customMessages).toHaveLength(0);
    const sent = sentMessages[0];
    if (!sent) throw new Error("Expected a sent message");
    expect(sent.options).toBeUndefined();
    const content = sent.content;
    expect(content).toContain("Use the built-in `ask` tool from the orchestrator/main-agent role");
    expect(content).toContain("roadmap_engineer_prepare_wave_dispatch");
    expect(content).toContain("roadmap_engineer_record_worker_dispatch");
    expect(content).toContain("roadmap_engineer_record_worker_transport_failed");
    expect(content).toContain("roadmap_engineer_record_worker_abandoned");
    expect(content).toContain("roadmap_engineer_record_wave_result");
    expect(content).toContain("roadmap_engineer_prepare_wave_review");
    expect(content).toContain("roadmap_engineer_record_wave_review");
    expect(content).toContain("built-in task/subagent mechanism");
    expect(content).toContain("If workers or reviewers report real blockers");
    expect(content).toContain("Never redispatch a task until the prior worker run is completed");
    expect(content).toContain("If neither background jobs nor IRC peers list that run");
    expect(content).toContain("do not poll, probe, or wait");
    expect(content).toContain("wait up to 2 minutes");
    expect(content).toContain("ask the user from the orchestrator/main-agent role");
    expect(content).toContain("Do not write or modify code yourself");
    expect(content).toContain("Never perform wave reviews yourself");
    // IRC-first recovery/rework
    expect(content).toContain("prefer waking the existing worker over spawning a replacement");
    expect(content).toContain("op:list");
    expect(content).toContain("op:send");
    expect(content).toContain('never broadcast with to:"all"');
    // Transport error must never become a blocker
    expect(content).toContain("Never call roadmap_engineer_record_wave_result with failed or blocked for a transport error");
    // Review rework classification
    expect(content).toContain("worker-fixable");
    expect(content).toContain("needs-user-decision");
    expect(content).toContain("history://<agentId>");
    // Findings report submitted once at the end of the run, not per wave
    expect(content).toContain("Submit roadmap_engineer_submit_findings_report exactly once at the terminal point");
    expect(content).toContain("Do not submit a findings report after an individual wave");
    // Runtime agent cannot open the extension repo's docs
    expect(content).not.toContain("docs/irc.md");
    expectFindingsReportInstruction(content, "milestone:implement");
  });

  test("blocker commands queue prompt-backed routing instructions", async () => {
    const { commands, sentMessages, customMessages } = createHarness();
    const cwd = await testCwd();
    for (const name of ["blocker:list", "blocker:status", "blocker:resolve", "blocker:defer"]) {
      expect(commands.get(name)).toBeDefined();
    }

    await commands.get("blocker:list")?.handler("", testContext(cwd));
    await commands.get("blocker:status")?.handler("", testContext(cwd));
    await commands.get("blocker:resolve")?.handler(
      "blk_123 Fixed by reverting unowned edits",
      testContext(cwd),
    );
    await commands.get("blocker:defer")?.handler(
      "blk_456 Accepted follow-up risk",
      testContext(cwd),
    );

    expect(sentMessages).toHaveLength(4);
    expect(customMessages).toHaveLength(0);
    for (const message of sentMessages) {
      expect(message.options).toBeUndefined();
    }

    const [listPrompt, statusPrompt, resolvePrompt, deferPrompt] = sentMessages.map(
      (message) => message.content,
    );
    if (!listPrompt || !statusPrompt || !resolvePrompt || !deferPrompt) {
      throw new Error("Expected blocker command prompts");
    }

    for (const [prompt, name] of [
      [listPrompt, "blocker:list"],
      [statusPrompt, "blocker:status"],
    ] as const) {
      expect(prompt).toContain("roadmap_engineer_list_blockers");
      expect(prompt).toContain("/blocker:resolve <id> <resolution>");
      expect(prompt).toContain("/blocker:defer <id> <reason>");
      expect(prompt).toContain("/roadmap:resume");
      expectFindingsReportInstruction(prompt, name);
    }

    expect(resolvePrompt).toContain("Parse user arguments as <blocker-id> <resolution>");
    expect(resolvePrompt).toContain("roadmap_engineer_resolve_blocker");
    expect(resolvePrompt).toContain("roadmap_engineer_validate");
    expect(resolvePrompt).toContain("tell the user to run /roadmap:resume");
    expect(resolvePrompt).toContain("blk_123 Fixed by reverting unowned edits");
    expectFindingsReportInstruction(resolvePrompt, "blocker:resolve");

    expect(deferPrompt).toContain("Parse user arguments as <blocker-id> <reason>");
    expect(deferPrompt).toContain("roadmap_engineer_defer_blocker");
    expect(deferPrompt).toContain("roadmap_engineer_validate");
    expect(deferPrompt).toContain("tell the user to run /roadmap:resume");
    expect(deferPrompt).toContain("blk_456 Accepted follow-up risk");
    expectFindingsReportInstruction(deferPrompt, "blocker:defer");
  });

  test("all prompt-backed commands queue agent command prompts while idle", async () => {
    const { commands, sentMessages, customMessages } = createHarness();
    const cwd = await testCwd();

    for (const name of PROMPT_COMMANDS) {
      const command = commands.get(name);
      expect(command).toBeDefined();
      await command?.handler("test args", testContext(cwd));
    }

    expect(sentMessages).toHaveLength(PROMPT_COMMANDS.length);
    expect(customMessages).toHaveLength(0);
    for (const message of sentMessages) {
      expect(message.options).toBeUndefined();
    }
    for (const [index, name] of PROMPT_COMMANDS.entries()) {
      const content = sentMessages[index]?.content;
      expect(content).toContain(`You are operating the roadmap-engineer OMP extension command /${name}.`);
      expect(content).toContain("User arguments:\ntest args");
      if (!content) throw new Error(`Expected prompt content for ${name}`);
      expectFindingsReportInstruction(content, name);
    }
  });

  test("prompt-backed commands queue follow-ups while busy", async () => {
    const { commands, sentMessages, customMessages } = createHarness();

    await commands.get("roadmap:status")?.handler("", testContext(await testCwd(), false));

    expect(sentMessages).toHaveLength(1);
    expect(customMessages).toHaveLength(0);
    expect(sentMessages[0]?.options).toEqual({ deliverAs: "followUp" });
    expect(sentMessages[0]?.content).toContain("You are operating the roadmap-engineer OMP extension command /roadmap:status.");
    expectFindingsReportInstruction(sentMessages[0]?.content ?? "", "roadmap:status");
  });

  test("roadmap:init reports local success as a visible transcript message", async () => {
    const { commands, sentMessages, customMessages } = createHarness();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-command-init-"));
    try {
      await commands.get("roadmap:init")?.handler("", testContext(cwd));

      expect(sentMessages).toHaveLength(0);
      expect(customMessages).toHaveLength(1);
      expect(customMessages[0]?.message).toMatchObject({
        customType: "roadmap-engineer.command-result",
        display: true,
        attribution: "agent",
      });
      expect(JSON.stringify(customMessages[0]?.message)).toContain("Initialized roadmap-engineer project files");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("findings:clear clears the active findings report tile without prompting the model", async () => {
    const { commands, sentMessages, customMessages } = createHarness();
    const widgetCalls: Array<{ key: string; content: ExtensionWidgetContent | undefined }> = [];
    const widgetOptions: unknown[] = [];
    const setWidget = (key: string, content: ExtensionWidgetContent | undefined, options?: unknown) => {
      widgetCalls.push({ key, content });
      widgetOptions.push(options);
    };

    const command = commands.get("findings:clear");
    expect(command).toBeDefined();
    await command?.handler("", testContext(await testCwd(), true, { setWidget }));

    expect(commands.has("findings:clear")).toBe(true);
    expect(sentMessages).toHaveLength(0);
    expect(customMessages).toHaveLength(1);
    expect(customMessages[0]?.message).toMatchObject({
      customType: "roadmap-engineer.command-result",
      display: true,
      attribution: "agent",
    });
    expect(JSON.stringify(customMessages[0]?.message)).toContain("Findings report tile cleared.");
    expect(widgetCalls).toEqual([{ key: "findings-report-tile", content: undefined }]);
    expect(widgetOptions).toEqual([undefined]);
  });

  test("findings:clear reports unavailable UI without clearing a widget", async () => {
    const { commands, sentMessages, customMessages } = createHarness();
    const setWidget = () => {
      throw new Error("setWidget should not be called when UI is unavailable");
    };

    const command = commands.get("findings:clear");
    expect(command).toBeDefined();
    await command?.handler("", testContext(await testCwd(), true, { setWidget }, false));

    expect(sentMessages).toHaveLength(0);
    expect(customMessages).toHaveLength(1);
    expect(customMessages[0]?.message).toMatchObject({
      customType: "roadmap-engineer.command-result",
      display: true,
      attribution: "agent",
    });
    expect(JSON.stringify(customMessages[0]?.message)).toContain("Findings report tile not cleared: UI unavailable.");
  });

  test("roadmap:details renders local details without prompting the model", async () => {
    const { commands, sentMessages, customMessages } = createHarness();
    const customOptions: unknown[] = [];
    const renderedLines: string[] = [];
    let closeCount = 0;
    let capturedComponent: { render(width: number): readonly string[]; handleInput?(data: string): void } | undefined;

    const command = commands.get("roadmap:details");
    expect(command).toBeDefined();

    await command?.handler(
      "",
      {
        ...testContext(await testCwd()),
        ui: {
          custom: async (factory: (...args: unknown[]) => unknown, options?: unknown) => {
            customOptions.push(options);
            capturedComponent = factory(
              { requestRender() {} },
              {},
              {},
              () => {
                closeCount += 1;
              },
            ) as { render(width: number): readonly string[]; handleInput?(data: string): void };
            return new Promise(() => {});
          },
          notify(message: string) {
            throw new Error(`Unexpected toast notification: ${message}`);
          },
        },
      } as unknown as ExtensionCommandContext,
    );

    expect(commands.has("roadmap:details")).toBe(true);
    expect(customOptions).toEqual([{ overlay: true }]);
    expect(capturedComponent).toBeDefined();
    renderedLines.push(...capturedComponent!.render(80));
    expect(renderedLines.join("\n")).toContain("No active roadmap");
    expect(renderedLines.join("\n")).toContain("gated roadmap workflow");
    capturedComponent!.handleInput?.("\x1b");
    expect(closeCount).toBe(1);
    expect(sentMessages).toHaveLength(0);
    expect(customMessages).toHaveLength(0);
  });

  test("roadmap:details prompt controls queue through command prompt delivery", async () => {
    const { commands, sentMessages, customMessages } = createHarness();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-command-details-"));
    try {
      await initRoadmap(cwd, { roadmapId: "details-roadmap", title: "Details Roadmap" });
      await openBlocker(cwd, {
        roadmapId: "details-roadmap",
        title: "Needs decision",
        description: "The user needs to resolve or defer this blocker.",
      });

      let closeCount = 0;
      let capturedComponent: { handleInput?(data: string): void } | undefined;
      await commands.get("roadmap:details")?.handler(
        "",
        {
          ...testContext(cwd),
          ui: {
            custom: async (factory: (...args: unknown[]) => unknown) => {
              capturedComponent = factory(
                { requestRender() {} },
                {},
                {},
                () => {
                  closeCount += 1;
                },
              ) as { handleInput?(data: string): void };
              return new Promise(() => {});
            },
            notify(message: string) {
              throw new Error(`Unexpected toast notification: ${message}`);
            },
          },
        } as unknown as ExtensionCommandContext,
      );

      expect(capturedComponent).toBeDefined();
      capturedComponent!.handleInput?.("b");
      await Bun.sleep(25);

      expect(sentMessages).toHaveLength(1);
      expect(customMessages).toHaveLength(0);
      expect(sentMessages[0]?.options).toBeUndefined();
      expect(sentMessages[0]?.content).toContain("roadmap_engineer_resolve_blocker");
      expect(sentMessages[0]?.content).toContain("roadmap_engineer_defer_blocker");
      expect(sentMessages[0]?.content).not.toContain("roadmap_engineer_submit_findings_report");
      expect(closeCount).toBe(1);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
