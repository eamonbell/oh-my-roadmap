import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
  adhocStopEventFromPlan,
  buildMoshiSessionUpdate,
  mapRoadmapToolResult,
  type MoshiContextLike,
  notifyMoshiForRoadmapToolResult,
  resetTerminalContextCache,
  sendMoshiFrame,
} from "../packages/extension/src/extension/moshi-notifications";

// Terminal-context env vars that resolveTerminalContext() reads. Cleared before
// building frames whose projectName/terminal fields must be deterministic, so tests
// don't inherit the ambient tmux/herdr/zellij session of the machine running them.
const TERMINAL_ENV_KEYS = [
  "TMUX",
  "TMUX_PANE",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
  "HERDR_ENV",
  "HERDR_SESSION",
  "HERDR_PANE_ID",
];

function clearTerminalEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of TERMINAL_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetTerminalContextCache();
  return saved;
}

function restoreTerminalEnv(saved: Record<string, string | undefined>): void {
  for (const key of TERMINAL_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetTerminalContextCache();
}

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
  let savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv = clearTerminalEnv();
  });
  afterEach(() => {
    restoreTerminalEnv(savedEnv);
  });

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
    // approval frames carry the daemon-meaningful phase, not the internal label.
    expect(frame.phase).toBe("waitingForApproval");
    // contextRemaining = 100 - round(42.6) = 57 (remaining, not used).
    expect(frame.contextRemaining).toBe(57);
    expect(frame.modelName).toBe("claude-test");
    expect(typeof frame.requestedAt).toBe("string");
  });

  test("keeps the internal phase label for non-approval frames", () => {
    const frame = buildMoshiSessionUpdate(fakeCtx(), {
      eventName: "omr.progress.updated",
      category: "tool_running",
      phase: "omr_progress",
      title: "OMR progress updated",
      message: "step: workers_running",
    });
    expect(frame.phase).toBe("omr_progress");
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

  test("stamps zellij terminal-correlation fields and prefers session name", () => {
    process.env.ZELLIJ_SESSION_NAME = "my-zellij";
    process.env.ZELLIJ_PANE_ID = "pane-7";
    resetTerminalContextCache();

    const frame = buildMoshiSessionUpdate(fakeCtx(), {
      eventName: "e",
      category: "tool_running",
      phase: "p",
      title: "t",
      message: "m",
    });
    expect(frame.terminalKind).toBe("zellij");
    expect(frame.zellijSession).toBe("my-zellij");
    expect(frame.zellijPane).toBe("pane-7");
    // projectName prefers the terminal session over the cwd basename.
    expect(frame.projectName).toBe("my-zellij");
  });

  test("omits terminal fields when no multiplexer is present", () => {
    const frame = buildMoshiSessionUpdate(fakeCtx(), {
      eventName: "e",
      category: "tool_running",
      phase: "p",
      title: "t",
      message: "m",
    });
    expect(frame.terminalKind).toBeUndefined();
    expect(frame.tmuxSession).toBeUndefined();
    expect(frame.herdrSession).toBeUndefined();
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

  test("progress transitions are always quiet (tool_running)", () => {
    const event = mapRoadmapToolResult(
      "omr_transition",
      {},
      { details: { operation: "update_implementation_progress", after: { step: "closeout_ready", active_wave_id: "w1", active_task_ids: [] } } },
    );
    expect(event?.eventName).toBe("omr.progress.updated");
    expect(event?.category).toBe("tool_running");
  });

  test("maps roadmap creation to session_started", () => {
    const event = mapRoadmapToolResult(
      "omr_init",
      {},
      { details: { roadmap_id: "r1", title: "My roadmap", phase: "discovery" } },
    );
    expect(event?.eventName).toBe("omr.roadmap.created");
    expect(event?.category).toBe("session_started");
    expect(event?.message).toContain("r1");
  });

  test("maps quiet planning transitions to tool_running", () => {
    for (const [operation, eventName] of [
      ["record_discovery", "omr.roadmap.discovery_recorded"],
      ["approve_roadmap", "omr.roadmap.approved"],
      ["start_milestone_planning", "omr.milestone.planning_started"],
      ["create_milestone_plan", "omr.milestone.plan_created"],
      ["approve_milestone", "omr.milestone.approved"],
      ["start_implementation", "omr.implementation.started"],
      ["start_reviewing", "omr.milestone.reviewing"],
      ["start_closeout", "omr.closeout.started"],
      ["record_closeout", "omr.closeout.recorded"],
    ] as const) {
      const event = mapRoadmapToolResult(
        "omr_transition",
        {},
        { details: { operation, summary: `did ${operation}`, scope: { roadmap_id: "r1", milestone_id: "m1" } } },
      );
      expect(event?.eventName, operation).toBe(eventName);
      expect(event?.category, operation).toBe("tool_running");
    }
  });

  test("gate transitions push only on failure (from params status)", () => {
    const passed = mapRoadmapToolResult(
      "omr_transition",
      { roadmapMilestoneCheck: { status: "passed" } },
      { details: { operation: "record_roadmap_milestone_check", scope: { roadmap_id: "r1" } } },
    );
    expect(passed?.eventName).toBe("omr.gate.roadmap_passed");
    expect(passed?.category).toBe("tool_running");

    const failed = mapRoadmapToolResult(
      "omr_transition",
      { waveFlowCheck: { status: "failed" } },
      { details: { operation: "record_wave_flow_check", scope: { roadmap_id: "r1", milestone_id: "m1" } } },
    );
    expect(failed?.eventName).toBe("omr.gate.wave_flow_failed");
    expect(failed?.category).toBe("approval_required");
  });

  test("complete_milestone pushes as task_complete; closeout stays quiet", () => {
    const complete = mapRoadmapToolResult(
      "omr_transition",
      {},
      { details: { operation: "complete_milestone", summary: "done", scope: { roadmap_id: "r1", milestone_id: "m1" } } },
    );
    expect(complete?.eventName).toBe("omr.milestone.completed");
    expect(complete?.category).toBe("task_complete");

    const bypass = mapRoadmapToolResult(
      "omr_transition",
      { reason: "urgent" },
      { details: { operation: "request_bypass", summary: "bypass", scope: { roadmap_id: "r1" } } },
    );
    expect(bypass?.category).toBe("approval_required");
    expect(bypass?.message).toContain("urgent");
  });

  test("maps ad-hoc init and lifecycle transitions", () => {
    const created = mapRoadmapToolResult(
      "omr_init_adhoc",
      {},
      { details: { adhoc_id: "ah1", title: "Quick fix", status: "adhoc_draft" } },
    );
    expect(created?.eventName).toBe("omr.adhoc.created");
    expect(created?.category).toBe("session_started");

    const implementing = mapRoadmapToolResult(
      "omr_adhoc_transition",
      { operation: "start_implementing" },
      { details: { adhoc_id: "ah1", status: "implementing" } },
    );
    expect(implementing?.eventName).toBe("omr.adhoc.implementing");
    expect(implementing?.category).toBe("tool_running");

    const complete = mapRoadmapToolResult(
      "omr_adhoc_transition",
      { operation: "complete" },
      { details: { adhoc_id: "ah1", status: "complete" } },
    );
    expect(complete?.eventName).toBe("omr.adhoc.completed");
    expect(complete?.category).toBe("task_complete");
  });

  test("ad-hoc failed wave-flow gate pushes; cancel emits with null details", () => {
    const gate = mapRoadmapToolResult(
      "omr_adhoc_transition",
      { operation: "record_wave_flow_check" },
      { details: { adhoc_id: "ah1", status: "adhoc_draft", wave_flow_check: { status: "failed" } } },
    );
    expect(gate?.eventName).toBe("omr.adhoc.wave_flow_failed");
    expect(gate?.category).toBe("approval_required");

    // cancel returns null details — must still emit.
    const cancelled = mapRoadmapToolResult("omr_adhoc_transition", { operation: "cancel" }, { details: null });
    expect(cancelled?.eventName).toBe("omr.adhoc.cancelled");
    expect(cancelled?.category).toBe("task_complete");
  });

  test("returns undefined for unmapped tools and malformed details", () => {
    expect(mapRoadmapToolResult("omr_read_state", {}, { details: {} })).toBeUndefined();
    expect(mapRoadmapToolResult("omr_prepare_wave_dispatch", {}, {})).toBeUndefined();
    expect(mapRoadmapToolResult("omr_record_worker_dispatch", {}, { details: {} })).toBeUndefined();
    expect(mapRoadmapToolResult("omr_transition", {}, { details: { operation: "update_task_status" } })).toBeUndefined();
  });
});

describe("adhocStopEventFromPlan", () => {
  test("derives an ad-hoc summary instead of a bogus 'Create roadmap'", () => {
    const running = adhocStopEventFromPlan({ adhoc_id: "ah1", status: "implementing", progress: { step: "workers_running" } });
    expect(running.eventName).toBe("omr.adhoc.stopped");
    expect(running.category).toBe("tool_running");
    expect(running.title).toContain("implementing");
    expect(running.message).not.toContain("Create roadmap");
  });

  test("flags blocked/failed-gate ad-hoc plans as approval_required", () => {
    const blocked = adhocStopEventFromPlan({ adhoc_id: "ah1", status: "implementing", progress: { blocked_reason: "stuck" } });
    expect(blocked.category).toBe("approval_required");
    expect(blocked.message).toContain("stuck");

    const gateFailed = adhocStopEventFromPlan({ adhoc_id: "ah1", status: "adhoc_draft", wave_flow_check: { status: "failed" } });
    expect(gateFailed.category).toBe("approval_required");
  });

  test("marks a completed ad-hoc plan as task_complete", () => {
    const done = adhocStopEventFromPlan({ adhoc_id: "ah1", status: "complete" });
    expect(done.category).toBe("task_complete");
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
