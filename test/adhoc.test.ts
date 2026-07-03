import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AdhocPlan } from "oh-my-roadmap-core/types";
import {
  loadAdhocActive,
  loadAdhocPlan,
  writeAdhocActive,
  writeAdhocPlan,
  writeAdhocRuntime,
} from "oh-my-roadmap-core/store/index";
import { adhocTransition, createAdhocPlan } from "oh-my-roadmap-core/store/index";
import { prepareWaveDispatch, recordWaveResult } from "oh-my-roadmap-core/wave-orchestration/index";
import { buildAdhocDetailSummary } from "oh-my-roadmap-core/roadmap-detail-summary/index";
import { validateImplementationGate, validateRoadmapState } from "oh-my-roadmap-core/validation";
import { ScrollView } from "@oh-my-pi/pi-tui";
import { renderRoadmapDetailsFrame } from "../packages/extension/src/extension/report-ui/index";

let cwd = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omr-adhoc-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

function samplePlan(overrides: Partial<AdhocPlan> = {}): AdhocPlan {
  return {
    adhoc_id: "a01-example",
    title: "Example ad-hoc",
    status: "adhoc_draft",
    created_at: "2026-07-02T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
    request: "Do a small bounded change.",
    approvals: [],
    open_questions: [],
    verification_commands: ["bun test"],
    acceptance_criteria: ["Behavior X works"],
    cleanup_policy: "approval-gated",
    user_interview: [],
    relevant_existing_code: [],
    relevant_documentation: [],
    decisions: [],
    dependency_analysis: [],
    tasks: [
      {
        id: "t1",
        title: "Task one",
        objective: "Do the thing",
        implementation_notes: ["Edit src/a.ts"],
        done_criteria: ["done"],
        verification_commands: ["bun test"],
        worker: "worker",
        status: "assigned",
        depends_on: [],
        owned_files: ["src/a.ts"],
        owned_modules: [],
        shared_interfaces: [],
      },
    ],
    waves: [
      { id: "w1", goal: "Ship task one", exit_criteria: ["t1 done"], review_checkpoint: "review w1", status: "pending", tasks: ["t1"] },
    ],
    progress: { step: "not_started", active_task_ids: [], worker_runs: [], updated_at: "2026-07-02T00:00:00.000Z" },
    wave_flow_check: { status: "pending", checked_by: "", checked_at: "", summary: "", findings: [] },
    ...overrides,
  };
}

describe("ad-hoc storage", () => {
  test("round-trips a plan through plan.md", async () => {
    const plan = samplePlan();
    await writeAdhocPlan(cwd, plan);

    const loaded = await loadAdhocPlan(cwd, plan.adhoc_id);
    expect(loaded.adhoc_id).toBe("a01-example");
    expect(loaded.status).toBe("adhoc_draft");
    expect(loaded.request).toBe("Do a small bounded change.");
    expect(loaded.tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(loaded.waves.map((w) => w.id)).toEqual(["w1"]);
  });

  test("runtime.yml overrides task/wave status on load", async () => {
    const plan = samplePlan();
    await writeAdhocPlan(cwd, plan);
    // Mark work in-flight via runtime, leaving plan.md definition untouched.
    await writeAdhocRuntime(cwd, {
      ...plan,
      tasks: [{ ...plan.tasks[0]!, status: "done" }],
      waves: [{ ...plan.waves[0]!, status: "complete" }],
    });

    const loaded = await loadAdhocPlan(cwd, plan.adhoc_id);
    expect(loaded.tasks[0]!.status).toBe("done");
    expect(loaded.waves[0]!.status).toBe("complete");
  });

  test("active pointer round-trips", async () => {
    await writeAdhocActive(cwd, { adhoc_id: "a01-example", updated_at: "2026-07-02T00:00:00.000Z" });
    const pointer = await loadAdhocActive(cwd);
    expect(pointer?.adhoc_id).toBe("a01-example");
  });
});

async function activate(plan: AdhocPlan): Promise<void> {
  // Definition lives in plan.md; wave-flow-check + statuses live in runtime.yml.
  await writeAdhocPlan(cwd, plan);
  await writeAdhocRuntime(cwd, plan);
  await writeAdhocActive(cwd, { adhoc_id: plan.adhoc_id, updated_at: plan.updated_at });
}

describe("ad-hoc write-gate", () => {
  const approved = (status: AdhocPlan["status"]): AdhocPlan =>
    samplePlan({
      status,
      approvals: [{ by: "user", at: "2026-07-02T00:00:00.000Z", summary: "ok" }],
      wave_flow_check: { status: "passed", checked_by: "wave-flow-checker", checked_at: "2026-07-02T00:00:00.000Z", summary: "ok", findings: [] },
    });

  test("blocks writes for a draft (unapproved) plan", async () => {
    await activate(samplePlan());
    const gate = await validateImplementationGate(cwd);
    expect(gate.valid).toBe(false);
    expect(gate.errors.map((e) => e.code)).toContain("gate.adhoc.unapproved");
    expect(gate.errors.map((e) => e.code)).toContain("gate.adhoc.phase.closed");
  });

  test("allows writes for an approved plan that is implementing", async () => {
    await activate(approved("implementing"));
    const gate = await validateImplementationGate(cwd);
    expect(gate.valid).toBe(true);
  });

  test("blocks writes for an approved plan still in closeout-only status", async () => {
    await activate(approved("closeout"));
    const gate = await validateImplementationGate(cwd);
    expect(gate.valid).toBe(false);
    expect(gate.errors.map((e) => e.code)).toContain("gate.adhoc.phase.closed");
  });
});

describe("ad-hoc validation", () => {
  test("flags a plan with no tasks", async () => {
    await activate(samplePlan({ tasks: [], waves: [] }));
    const result = await validateRoadmapState(cwd);
    expect(result.errors.map((e) => e.code)).toContain("adhoc.tasks.missing");
  });
});

describe("ad-hoc lifecycle", () => {
  const input = () => ({
    adhocId: "a01-lifecycle",
    title: "Lifecycle",
    request: "bounded change",
    verificationCommands: ["bun test"],
    acceptanceCriteria: ["works"],
    tasks: samplePlan().tasks,
    waves: samplePlan().waves,
  });

  test("create → approve → implement → review → close, then clears the pointer", async () => {
    await createAdhocPlan(cwd, input());
    expect((await loadAdhocActive(cwd))?.adhoc_id).toBe("a01-lifecycle");
    // Draft blocks writes.
    expect((await validateImplementationGate(cwd)).valid).toBe(false);

    // A second create is refused while one is active.
    await expect(createAdhocPlan(cwd, { ...input(), adhocId: "a02" })).rejects.toThrow("already active");

    await adhocTransition(cwd, { operation: "record_wave_flow_check", waveFlowCheck: { status: "passed", summary: "flow ok" } });
    // Approval requires a passed wave-flow check (now satisfied).
    const approved = await adhocTransition(cwd, { operation: "approve", approver: "user" });
    expect(approved?.status).toBe("adhoc_approved");
    expect(approved?.approvals.length).toBe(1);

    await adhocTransition(cwd, { operation: "start_implementing" });
    expect((await loadAdhocPlan(cwd, "a01-lifecycle")).status).toBe("implementing");
    // Approved + implementing opens the write-gate.
    expect((await validateImplementationGate(cwd)).valid).toBe(true);

    await adhocTransition(cwd, { operation: "start_reviewing" });
    await adhocTransition(cwd, {
      operation: "record_closeout",
      closeout: {
        status: "recorded",
        acceptance_results: [{ item: "works", status: "passed" }],
        verification_results: [{ item: "bun test", status: "passed" }],
        worker_notes_reviewed: true,
        review_summary: "clean",
        unresolved_risks: [],
      },
    });
    const done = await adhocTransition(cwd, { operation: "complete" });
    expect(done?.status).toBe("complete");
    // Completing clears the active pointer.
    expect(await loadAdhocActive(cwd)).toBeUndefined();
  });

  test("approve is refused without a passed wave-flow check", async () => {
    await createAdhocPlan(cwd, { ...input(), adhocId: "a03" });
    await expect(adhocTransition(cwd, { operation: "approve" })).rejects.toThrow("wave-flow check");
  });
});

describe("ad-hoc details overlay", () => {
  test("empty when no ad-hoc plan is active", async () => {
    const summary = await buildAdhocDetailSummary(cwd);
    expect(summary.kind).toBe("empty");
  });

  test("builds an active summary that renders through the shared details view", async () => {
    await createAdhocPlan(cwd, {
      adhocId: "a01-details",
      title: "Details plan",
      request: "bounded change",
      verificationCommands: ["bun test"],
      acceptanceCriteria: ["works"],
      tasks: samplePlan().tasks,
      waves: samplePlan().waves,
    });

    const summary = await buildAdhocDetailSummary(cwd);
    expect(summary.kind).toBe("active");

    const lines = renderRoadmapDetailsFrame({
      summary,
      width: 120,
      height: 40,
      scrollView: new ScrollView([], { height: 1, scrollbar: "auto" }),
      activeTabIndex: 1,
      focus: "rail",
      message: "",
    });
    const plain = lines.join("\n").replace(/\[[0-9;]*m/g, "");
    expect(plain).toContain("a01-details");
    expect(plain).toContain("Details plan");
    expect(plain).toContain("t1");
  });
});

describe("ad-hoc wave orchestration", () => {
  test("drives a wave through the shared dispatch + result tools", async () => {
    await createAdhocPlan(cwd, {
      adhocId: "a01-wave",
      title: "Wave",
      request: "bounded change",
      verificationCommands: ["bun test"],
      acceptanceCriteria: ["works"],
      tasks: samplePlan().tasks,
      waves: samplePlan().waves,
    });
    await adhocTransition(cwd, { operation: "record_wave_flow_check", waveFlowCheck: { status: "passed", summary: "ok" } });
    await adhocTransition(cwd, { operation: "approve" });
    await adhocTransition(cwd, { operation: "start_implementing" });

    // The same wave tools used for milestones resolve the active ad-hoc plan.
    const dispatch = await prepareWaveDispatch(cwd, {});
    expect(dispatch.assignments.map((a) => a.task_id)).toContain("t1");
    // Worker prompt uses the ad-hoc scope label, not Roadmap/Milestone.
    expect(dispatch.assignments[0]!.prompt).toContain("Ad-hoc plan: a01-wave");

    const result = await recordWaveResult(cwd, { taskId: "t1", status: "completed" });
    expect(result.status).toBe("done");

    // Status persisted to the ad-hoc runtime.
    const plan = await loadAdhocPlan(cwd, "a01-wave");
    expect(plan.tasks.find((t) => t.id === "t1")?.status).toBe("done");
  });
});
