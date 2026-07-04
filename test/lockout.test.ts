import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { shouldBlockToolCall } from "@oh-my-roadmap/core/gate";
import { loadDisabled, setProjectDisabled } from "@oh-my-roadmap/core/project-init";
import {
  clearActivePauseMarkers,
  loadActive,
  markActivePaused,
  markActiveResumed,
  writeActive,
} from "@oh-my-roadmap/core/store/index";

let cwd = "";
let home = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omr-lock-cwd-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "omr-lock-home-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

describe("lockout config", () => {
  test("setProjectDisabled toggles the flag read by loadDisabled", async () => {
    expect(await loadDisabled(cwd, home)).toBe(false);
    await setProjectDisabled(cwd, true);
    expect(await loadDisabled(cwd, home)).toBe(true);
    await setProjectDisabled(cwd, false);
    expect(await loadDisabled(cwd, home)).toBe(false);
  });
});

describe("lockout gate", () => {
  test("blocks omr tools and omr agent spawns when disabled", async () => {
    await setProjectDisabled(cwd, true);

    const omrTool = await shouldBlockToolCall(cwd, "omr_read_state", {}, home);
    expect(omrTool.block).toBe(true);
    expect(omrTool.reason).toContain("paused");

    const omrAgent = await shouldBlockToolCall(cwd, "task", { agent: "worker" }, home);
    expect(omrAgent.block).toBe(true);

    // Non-omr agents and unrelated tools stay allowed even while paused.
    const otherAgent = await shouldBlockToolCall(cwd, "task", { agent: "explore" }, home);
    expect(otherAgent.block).toBe(false);
    const bash = await shouldBlockToolCall(cwd, "bash", { command: "ls" }, home);
    expect(bash.block).toBe(false);
  });

  test("allows omr tools and agents when enabled", async () => {
    await setProjectDisabled(cwd, false);
    expect((await shouldBlockToolCall(cwd, "omr_read_state", {}, home)).block).toBe(false);
    expect((await shouldBlockToolCall(cwd, "task", { agent: "worker-heavy" }, home)).block).toBe(false);
  });
});

describe("active pause markers", () => {
  async function seedActive(): Promise<void> {
    await writeActive(cwd, { roadmap_id: "r1", updated_at: "2026-01-01T00:00:00.000Z" });
  }

  test("mark/clear pause + resume markers on the active pointer", async () => {
    await seedActive();

    expect(await markActivePaused(cwd, "2026-07-02T10:00:00.000Z")).toBe(true);
    expect((await loadActive(cwd))?.paused_at).toBe("2026-07-02T10:00:00.000Z");

    expect(await markActiveResumed(cwd, "2026-07-02T11:00:00.000Z")).toBe(true);
    const resumed = await loadActive(cwd);
    expect(resumed?.paused_at).toBe("2026-07-02T10:00:00.000Z");
    expect(resumed?.resumed_at).toBe("2026-07-02T11:00:00.000Z");

    await clearActivePauseMarkers(cwd);
    const cleared = await loadActive(cwd);
    expect(cleared?.paused_at).toBeUndefined();
    expect(cleared?.resumed_at).toBeUndefined();
    expect(cleared?.roadmap_id).toBe("r1");
  });

  test("markers are a no-op when no roadmap is active", async () => {
    expect(await markActivePaused(cwd, "2026-07-02T10:00:00.000Z")).toBe(false);
    expect(await markActiveResumed(cwd, "2026-07-02T11:00:00.000Z")).toBe(false);
    expect(await loadActive(cwd)).toBeUndefined();
  });
});
