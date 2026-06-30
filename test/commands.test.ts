import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { registerRoadmapCommands } from "../src/extension/commands";

interface RegisteredTestCommand {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

describe("roadmap commands", () => {
  test("roadmap:new sends an immediate agent prompt with user arguments", async () => {
    const commands = new Map<string, RegisteredTestCommand>();
    const sentMessages: Array<{ content: string; options: unknown }> = [];
    const api = {
      registerCommand(name: string, command: RegisteredTestCommand) {
        commands.set(name, command);
      },
      sendUserMessage(content: string, options?: unknown) {
        sentMessages.push({ content, options });
      },
    } as unknown as ExtensionAPI;

    registerRoadmapCommands(api);

    const command = commands.get("roadmap:new");
    expect(command).toBeDefined();

    await command?.handler(
      "Add billing workflows",
      { cwd: await Bun.fileURLToPath(new URL(".", import.meta.url)) } as unknown as ExtensionCommandContext,
    );

    expect(sentMessages).toHaveLength(1);
    const sent = sentMessages[0];
    if (!sent) throw new Error("Expected a sent message");
    expect(sent.options).toBeUndefined();
    expect(sent.content).toContain("You are operating the roadmap-engineer OMP extension command /roadmap:new.");
    expect(sent.content).toContain("User arguments:\nAdd billing workflows");
    expect(sent.content).toContain("No active roadmap. Run /roadmap:new to start a gated roadmap workflow.");
    expect(sent.content).toContain("multiple meaningful deliverables or workstreams");
    expect(sent.content).toContain("do not create a separate milestone for one small edit");
    expect(sent.content).toContain("roadmap-milestone-checker");
    expect(sent.content).toContain("record_roadmap_milestone_check");
    expect(sent.content).toContain(
      "Only call roadmap_engineer_validate and ask for roadmap approval after the recorded roadmap-milestone check has passed",
    );
  });

  test("roadmap:reopen sends command-specific reopen instructions", async () => {
    const commands = new Map<string, RegisteredTestCommand>();
    const sentMessages: Array<{ content: string; options: unknown }> = [];
    const api = {
      registerCommand(name: string, command: RegisteredTestCommand) {
        commands.set(name, command);
      },
      sendUserMessage(content: string, options?: unknown) {
        sentMessages.push({ content, options });
      },
    } as unknown as ExtensionAPI;

    registerRoadmapCommands(api);

    const command = commands.get("roadmap:reopen");
    expect(command).toBeDefined();

    await command?.handler(
      "Add migration milestone",
      { cwd: await Bun.fileURLToPath(new URL(".", import.meta.url)) } as unknown as ExtensionCommandContext,
    );

    expect(sentMessages).toHaveLength(1);
    const sent = sentMessages[0];
    if (!sent) throw new Error("Expected a sent message");
    expect(sent.content).toContain("You are operating the roadmap-engineer OMP extension command /roadmap:reopen.");
    expect(sent.content).toContain("operation reopen_roadmap");
    expect(sent.content).toContain("required reopen reason");
    expect(sent.content).toContain("roadmap_engineer_update_roadmap");
    expect(sent.content).toContain("roadmap_engineer_validate");
    expect(sent.content).toContain("explicit roadmap reapproval");
    expect(sent.content).toContain("roadmap-milestone-checker");
    expect(sent.content).toContain("record_roadmap_milestone_check");
    expect(sent.content).toContain(
      "Only call roadmap_engineer_validate and ask for roadmap approval after the recorded roadmap-milestone check has passed",
    );
  });

  test("milestone:plan prompts for detailed test coverage decisions", async () => {
    const commands = new Map<string, RegisteredTestCommand>();
    const sentMessages: Array<{ content: string; options: unknown }> = [];
    const api = {
      registerCommand(name: string, command: RegisteredTestCommand) {
        commands.set(name, command);
      },
      sendUserMessage(content: string, options?: unknown) {
        sentMessages.push({ content, options });
      },
    } as unknown as ExtensionAPI;

    registerRoadmapCommands(api);

    const command = commands.get("milestone:plan");
    expect(command).toBeDefined();

    await command?.handler(
      "",
      { cwd: await Bun.fileURLToPath(new URL(".", import.meta.url)) } as unknown as ExtensionCommandContext,
    );

    expect(sentMessages).toHaveLength(1);
    const sent = sentMessages[0];
    if (!sent) throw new Error("Expected a sent message");
    expect(sent.content).toContain("what test coverage they want");
    expect(sent.content).toContain("which areas should create tests");
    expect(sent.content).toContain("what coverage is intentionally deferred or not required");
    expect(sent.content).toContain("compact orientation");
    expect(sent.content).toContain("roadmap sections, plan sections");
    expect(sent.content).toContain("do not call reopen_roadmap");
    expect(sent.content).toContain("start_milestone_planning to advance from the completed milestone");
    expect(sent.content).toContain("Do not pad the milestone plan with filler tasks");
    expect(sent.content).toContain("every task must directly implement the approved roadmap milestone scope");
  });

  test("milestone:implement keeps user questions in the orchestrator role", async () => {
    const commands = new Map<string, RegisteredTestCommand>();
    const sentMessages: Array<{ content: string; options: unknown }> = [];
    const api = {
      registerCommand(name: string, command: RegisteredTestCommand) {
        commands.set(name, command);
      },
      sendUserMessage(content: string, options?: unknown) {
        sentMessages.push({ content, options });
      },
    } as unknown as ExtensionAPI;

    registerRoadmapCommands(api);

    const command = commands.get("milestone:implement");
    expect(command).toBeDefined();

    await command?.handler(
      "",
      { cwd: await Bun.fileURLToPath(new URL(".", import.meta.url)) } as unknown as ExtensionCommandContext,
    );

    expect(sentMessages).toHaveLength(1);
    const sent = sentMessages[0];
    if (!sent) throw new Error("Expected a sent message");
    expect(sent.content).toContain("Use the built-in `ask` tool from the orchestrator/main-agent role");
    expect(sent.content).toContain("roadmap_engineer_prepare_wave_dispatch");
    expect(sent.content).toContain("roadmap_engineer_record_wave_result");
    expect(sent.content).toContain("roadmap_engineer_prepare_wave_review");
    expect(sent.content).toContain("roadmap_engineer_record_wave_review");
    expect(sent.content).toContain("built-in task/subagent mechanism");
    expect(sent.content).toContain("If workers or reviewers report blockers");
    expect(sent.content).toContain("ask the user from the orchestrator/main-agent role");
    expect(sent.content).toContain("Do not write or modify code yourself");
    expect(sent.content).toContain("Never perform wave reviews yourself");
  });

  test("roadmap:details renders local details without prompting the model", async () => {
    const commands = new Map<string, RegisteredTestCommand>();
    const sentMessages: Array<{ content: string; options: unknown }> = [];
    const customMessages: Array<{ content: string | unknown[]; options: unknown }> = [];
    const customOptions: unknown[] = [];
    const renderedLines: string[] = [];
    let closeCount = 0;
    let capturedComponent: { render(width: number): readonly string[]; handleInput?(data: string): void } | undefined;
    const api = {
      registerCommand(name: string, command: RegisteredTestCommand) {
        commands.set(name, command);
      },
      sendUserMessage(content: string, options?: unknown) {
        sentMessages.push({ content, options });
      },
      sendMessage(content: string | unknown[], options?: unknown) {
        customMessages.push({ content, options });
      },
    } as unknown as ExtensionAPI;

    registerRoadmapCommands(api);

    const command = commands.get("roadmap:details");
    expect(command).toBeDefined();

    await command?.handler(
      "",
      {
        cwd: await Bun.fileURLToPath(new URL(".", import.meta.url)),
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
          notify() {},
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
});
