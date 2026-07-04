import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
  buildMoshiSessionUpdate,
  mapRoadmapToolResult,
  type MoshiContextLike,
  notifyMoshiForRoadmapToolResult,
  sendMoshiFrame,
} from "../packages/extension/src/extension/moshi-notifications";

interface FakeServer {
  received: string[];
  socketPath: string;
  close: () => Promise<void>;
}

async function startServer(dir: string): Promise<FakeServer> {
  const socketPath = path.join(dir, "moshi.sock");
  const received: string[] = [];
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("\n")) {
        received.push(buf);
        // Ack by closing; the client resolves on `end`.
        socket.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    received,
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function fakeCtx(overrides: Partial<MoshiContextLike> = {}): MoshiContextLike {
  return {
    cwd: "/tmp/omr-project",
    sessionManager: { getSessionFile: () => "/sessions/session-abc.jsonl" },
    getContextUsage: () => ({ percent: 42.6 }),
    model: { id: "claude-test" },
    ...overrides,
  };
}

describe("buildMoshiSessionUpdate", () => {
  test("produces a documented session.update frame", () => {
    const frame = buildMoshiSessionUpdate(fakeCtx(), {
      eventName: "omr.worker.blocked",
      category: "approval_required",
      phase: "omr_needs_input",
      title: "OMR worker needs attention",
      message: "task: t-1",
    });

    expect(frame.type).toBe("session.update");
    expect(frame.source).toBe("omp");
    expect(frame.sessionId).toBe("/sessions/session-abc.jsonl");
    expect(frame.projectName).toBe("omr-project");
    expect(frame.category).toBe("approval_required");
    expect(frame.contextPercent).toBe(43);
    expect(frame.modelName).toBe("claude-test");
    expect(typeof frame.requestedAt).toBe("string");
  });

  test("falls back to session id then cwd for sessionId", () => {
    const viaId = buildMoshiSessionUpdate(
      fakeCtx({ sessionManager: { getSessionId: () => "sid-1" } }),
      { eventName: "e", category: "tool_running", phase: "p", title: "t", message: "m" },
    );
    expect(viaId.sessionId).toBe("sid-1");

    const viaCwd = buildMoshiSessionUpdate(
      fakeCtx({ sessionManager: {}, cwd: "/tmp/only-cwd" }),
      { eventName: "e", category: "tool_running", phase: "p", title: "t", message: "m" },
    );
    expect(viaCwd.sessionId).toBe("/tmp/only-cwd");
  });
});

describe("sendMoshiFrame", () => {
  let dir = "";
  let server: FakeServer | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "moshi-"));
  });
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("writes exactly one newline-delimited notify-only frame", async () => {
    server = await startServer(dir);
    const frame = buildMoshiSessionUpdate(fakeCtx(), {
      eventName: "omr.wave.review_blocked",
      category: "approval_required",
      phase: "omr_needs_input",
      title: "OMR wave review blocked",
      message: "wave: w-1",
    });

    await sendMoshiFrame(server.socketPath, frame, 1000);

    expect(server.received.length).toBe(1);
    const lines = server.received[0]!.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.type).toBe("session.update");
    expect(parsed.source).toBe("omp");
    expect(parsed.category).toBe("approval_required");
    expect(parsed.eventName).toBe("omr.wave.review_blocked");
    expect(parsed.sessionId).toBe("/sessions/session-abc.jsonl");
    expect(parsed.cwd).toBe("/tmp/omr-project");
    expect(parsed.projectName).toBe("omr-project");
    // Notify-only: never advertise host-routable decision fields.
    expect(parsed).not.toHaveProperty("actionId");
    expect(parsed).not.toHaveProperty("pendingActionId");
    expect(parsed).not.toHaveProperty("expiresAt");
    expect(parsed).not.toHaveProperty("hostId");
  });

  test("does not throw on a refused/missing socket", async () => {
    const frame = buildMoshiSessionUpdate(fakeCtx(), {
      eventName: "e",
      category: "tool_running",
      phase: "p",
      title: "t",
      message: "m",
    });
    await expect(
      sendMoshiFrame(path.join(dir, "does-not-exist.sock"), frame, 200),
    ).resolves.toBeUndefined();
  });
});

describe("mapRoadmapToolResult", () => {
  test("maps prepare_wave_dispatch to tool_running dispatch_prepared", () => {
    const event = mapRoadmapToolResult(
      "omr_prepare_wave_dispatch",
      {},
      { details: { roadmap_id: "r1", milestone_id: "m1", wave_id: "w1", assignments: [{}, {}], active_runs: [{}] } },
    );
    expect(event?.eventName).toBe("omr.wave.dispatch_prepared");
    expect(event?.category).toBe("tool_running");
    expect(event?.message).toContain("wave: w1");
  });

  test("maps record_worker_dispatch with replaces_agent_id to respawned", () => {
    const event = mapRoadmapToolResult(
      "omr_record_worker_dispatch",
      {},
      { details: { task_id: "t1", wave_id: "w1", run: { worker: "worker", agent_id: "a2", job_id: "j2", replaces_agent_id: "a1" } } },
    );
    expect(event?.eventName).toBe("omr.worker.respawned");
    expect(event?.category).toBe("tool_running");
    expect(event?.message).toContain("replaces: a1");
  });

  test("maps a done wave result to worker.yielded (tool_finished)", () => {
    const event = mapRoadmapToolResult(
      "omr_record_wave_result",
      {},
      { details: { task_id: "t1", wave_id: "w1", status: "done", progress_step: "wave_review", summary: "did it" } },
    );
    expect(event?.eventName).toBe("omr.worker.yielded");
    expect(event?.category).toBe("tool_finished");
  });

  test("maps a blocked wave result to worker.blocked (approval_required)", () => {
    const event = mapRoadmapToolResult(
      "omr_record_wave_result",
      {},
      { details: { task_id: "t1", wave_id: "w1", status: "blocked", blocker: { id: "b1", title: "stuck" } } },
    );
    expect(event?.eventName).toBe("omr.worker.blocked");
    expect(event?.category).toBe("approval_required");
    expect(event?.message).toContain("b1");
  });

  test("maps a complete wave review to review_passed (task_complete)", () => {
    const event = mapRoadmapToolResult(
      "omr_record_wave_review",
      {},
      { details: { wave_id: "w1", wave_status: "complete", progress_step: "ready_for_next_wave", blockers: [] } },
    );
    expect(event?.eventName).toBe("omr.wave.review_passed");
    expect(event?.category).toBe("task_complete");
  });

  test("maps a blocked wave review to review_blocked (approval_required)", () => {
    const event = mapRoadmapToolResult(
      "omr_record_wave_review",
      {},
      { details: { wave_id: "w1", wave_status: "blocked", blockers: [{ id: "b1", title: "regression" }] } },
    );
    expect(event?.eventName).toBe("omr.wave.review_blocked");
    expect(event?.category).toBe("approval_required");
    expect(event?.message).toContain("b1");
  });

  test("progress transition to a completion step uses task_complete", () => {
    const event = mapRoadmapToolResult(
      "omr_transition",
      {},
      { details: { operation: "update_implementation_progress", after: { step: "closeout_ready", active_wave_id: "w1", active_task_ids: [] } } },
    );
    expect(event?.eventName).toBe("omr.progress.updated");
    expect(event?.category).toBe("task_complete");
  });

  test("returns undefined for unmapped tools and malformed details", () => {
    expect(mapRoadmapToolResult("omr_read_state", {}, { details: {} })).toBeUndefined();
    expect(mapRoadmapToolResult("omr_prepare_wave_dispatch", {}, {})).toBeUndefined();
    expect(mapRoadmapToolResult("omr_record_worker_dispatch", {}, { details: {} })).toBeUndefined();
  });
});

describe("notifyMoshiForRoadmapToolResult", () => {
  let cwd = "";
  let dir = "";
  let server: FakeServer | undefined;
  let priorSocketEnv: string | undefined;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "moshi-cwd-"));
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "moshi-srv-"));
    priorSocketEnv = process.env.MOSHI_SOCKET_PATH;
  });
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (priorSocketEnv === undefined) delete process.env.MOSHI_SOCKET_PATH;
    else process.env.MOSHI_SOCKET_PATH = priorSocketEnv;
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(text: string): Promise<void> {
    const configPath = path.join(cwd, ".omr", "config.yml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, text, "utf8");
  }

  function ctxFor(): ExtensionContext {
    return { cwd, sessionManager: { getSessionFile: () => null, getSessionId: () => null } } as unknown as ExtensionContext;
  }

  test("does not connect when moshi is disabled", async () => {
    server = await startServer(dir);
    process.env.MOSHI_SOCKET_PATH = server.socketPath;
    await writeConfig("agents:\n  worker: {}\n  reviewer: {}\nmoshi:\n  enabled: false\n");

    await notifyMoshiForRoadmapToolResult(ctxFor(), "omr_prepare_wave_dispatch", {}, {
      details: { wave_id: "w1", assignments: [], active_runs: [] },
    });

    expect(server.received.length).toBe(0);
  });

  test("does not connect when moshi config is absent", async () => {
    server = await startServer(dir);
    process.env.MOSHI_SOCKET_PATH = server.socketPath;
    await writeConfig("agents:\n  worker: {}\n  reviewer: {}\n");

    await notifyMoshiForRoadmapToolResult(ctxFor(), "omr_prepare_wave_dispatch", {}, {
      details: { wave_id: "w1", assignments: [], active_runs: [] },
    });

    expect(server.received.length).toBe(0);
  });

  test("dedupes identical events within the window and allows different ones", async () => {
    server = await startServer(dir);
    process.env.MOSHI_SOCKET_PATH = server.socketPath;
    await writeConfig("agents:\n  worker: {}\n  reviewer: {}\nmoshi:\n  enabled: true\n");

    const ctx = ctxFor();
    const dispatch = (waveId: string) =>
      notifyMoshiForRoadmapToolResult(ctx, "omr_prepare_wave_dispatch", {}, {
        details: { wave_id: waveId, assignments: [], active_runs: [] },
      });

    await dispatch("w1");
    await dispatch("w1"); // identical → suppressed
    expect(server.received.length).toBe(1);

    await dispatch("w2"); // different message → delivered
    expect(server.received.length).toBe(2);
  });
});
