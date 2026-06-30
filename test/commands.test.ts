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
  });
});
