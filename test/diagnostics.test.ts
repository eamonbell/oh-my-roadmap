import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { configureDiagnosticLogger, logDiagnostic, withDiagnosticTiming } from "oh-my-roadmap-core/diagnostics";

let homeDir = "";
let originalLevel: string | undefined;

async function logEntries(): Promise<Record<string, unknown>[]> {
  const dir = path.join(homeDir, ".oh-my-roadmap", "logs");
  const files = await fs.readdir(dir);
  const text = await fs.readFile(path.join(dir, files[0] ?? ""), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-diagnostics-"));
  originalLevel = process.env.OH_MY_ROADMAP_LOG_LEVEL;
  delete process.env.OH_MY_ROADMAP_LOG_LEVEL;
  configureDiagnosticLogger({ homeDir });
});

afterEach(async () => {
  if (originalLevel === undefined) delete process.env.OH_MY_ROADMAP_LOG_LEVEL;
  else process.env.OH_MY_ROADMAP_LOG_LEVEL = originalLevel;
  configureDiagnosticLogger({});
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe("diagnostic logger", () => {
  test("writes metadata-only NDJSON entries under the configured home directory", async () => {
    await logDiagnostic({
      level: "info",
      component: "command",
      operation: "omr:rm-status",
      cwd: "/workspace/project",
      durationMs: 12,
      success: true,
      metadata: {
        tool_name: "omr_read_state",
        prompt: { nested: "ignored" },
        result: ["ignored"],
      },
    });

    const entries = await logEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      schema_version: 1,
      level: "info",
      component: "command",
      operation: "omr:rm-status",
      cwd: "/workspace/project",
      duration_ms: 12,
      success: true,
      metadata: { tool_name: "omr_read_state" },
    });
    expect(JSON.stringify(entries[0])).not.toContain("nested");
    expect(JSON.stringify(entries[0])).not.toContain("ignored");
  });

  test("filters entries below the active log level", async () => {
    process.env.OH_MY_ROADMAP_LOG_LEVEL = "warn";

    await logDiagnostic({ level: "debug", component: "core", operation: "debuggable" });
    await logDiagnostic({ level: "info", component: "core", operation: "informative" });
    await logDiagnostic({ level: "warn", component: "core", operation: "slow" });

    const entries = await logEntries();
    expect(entries.map((entry) => entry.operation)).toEqual(["slow"]);
  });

  test("supports turning logging off", async () => {
    process.env.OH_MY_ROADMAP_LOG_LEVEL = "off";

    await logDiagnostic({ level: "error", component: "core", operation: "failure" });

    await expect(fs.readdir(path.join(homeDir, ".oh-my-roadmap", "logs"))).rejects.toThrow();
  });

  test("includes error stacks only at debug level", async () => {
    const error = new Error("debug stack");

    process.env.OH_MY_ROADMAP_LOG_LEVEL = "debug";
    await logDiagnostic({ level: "error", component: "core", operation: "debug-error", error });

    process.env.OH_MY_ROADMAP_LOG_LEVEL = "error";
    await logDiagnostic({ level: "error", component: "core", operation: "error-only", error });

    const entries = await logEntries();
    expect(entries[0]).toMatchObject({
      error: { name: "Error", message: "debug stack" },
    });
    expect((entries[0]?.error as { stack?: string }).stack).toContain("debug stack");
    expect(entries[1]).toMatchObject({
      error: { name: "Error", message: "debug stack" },
    });
    expect((entries[1]?.error as { stack?: string }).stack).toBeUndefined();
  });

  test("does not throw when file writes fail and calls the fallback warning logger", async () => {
    const blockedHome = path.join(homeDir, "blocked-home");
    await fs.writeFile(blockedHome, "not a directory", "utf8");
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    configureDiagnosticLogger({
      homeDir: blockedHome,
      fallbackLogger: {
        warn(message, context) {
          warnings.push({ message, ...(context ? { context } : {}) });
        },
      },
    });

    await expect(logDiagnostic({
      level: "error",
      component: "core",
      operation: "write-failure",
    })).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe("oh-my-roadmap diagnostic logging failed");
  });

  test("records duration and success for timed operations", async () => {
    const result = await withDiagnosticTiming({
      component: "core",
      operation: "timed",
      cwd: "/workspace/project",
    }, async () => "ok");

    expect(result).toBe("ok");
    const entries = await logEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "info",
      operation: "timed",
      success: true,
      cwd: "/workspace/project",
    });
    expect(typeof entries[0]?.duration_ms).toBe("number");
  });
});
