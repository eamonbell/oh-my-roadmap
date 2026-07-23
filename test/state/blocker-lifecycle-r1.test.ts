import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  appendNote,
  deferBlocker,
  loadRoadmapBlockers,
  openBlocker,
  resolveBlocker,
  transition,
} from "@oh-my-roadmap/core/store/index";
import {
  openCanonicalBlockingIssues,
  reworkScopeFromState,
  validateImplementationGate,
  validateRoadmapState,
} from "@oh-my-roadmap/core/validation";
import type { LoadedState, WorkerRun } from "@oh-my-roadmap/core/types";
import {
  approvedMilestone as approvedMilestoneForCwd,
  createTempRoadmapCwd,
  removeTempRoadmapCwd,
} from "./helpers";

const ROADMAP_ID = "complex-refactor";

let cwd = "";

beforeEach(async () => {
  cwd = await createTempRoadmapCwd();
});

afterEach(async () => {
  await removeTempRoadmapCwd(cwd);
  cwd = "";
});

async function implementingMilestone(): Promise<void> {
  await approvedMilestoneForCwd(cwd);
  await transition(cwd, { operation: "start_implementation" });
}

describe("blocker lifecycle R1 integrity", () => {
  test("blocking note mints a canonical blocker only for needs-user (or unspecified) findings", async () => {
    await implementingMilestone();

    // needs_user -> mints a canonical blocker.
    await appendNote(cwd, {
      kind: "review",
      title: "Needs user decision",
      body: "Rollout owner must sign off.",
      blocking: true,
      blockingKind: "needs_user",
      status: "open",
    });
    expect(await loadRoadmapBlockers(cwd, ROADMAP_ID)).toHaveLength(1);

    // unspecified kind -> legacy back-compat, still mints.
    await appendNote(cwd, {
      kind: "review",
      title: "Legacy unspecified blocker",
      body: "No kind supplied; must mint as before.",
      blocking: true,
      status: "open",
    });
    expect(await loadRoadmapBlockers(cwd, ROADMAP_ID)).toHaveLength(2);

    // worker_fixable -> advisory: note is recorded but NO canonical blocker is minted.
    const advisoryPath = await appendNote(cwd, {
      kind: "review",
      title: "Worker fixable finding",
      body: "Worker can fix this in place; route to rework queue.",
      blocking: true,
      blockingKind: "worker_fixable",
      status: "open",
    });
    expect(await loadRoadmapBlockers(cwd, ROADMAP_ID)).toHaveLength(2);

    // The advisory note is still written to disk with its worker_fixable marker and no blocker id.
    const noteText = await fs.readFile(advisoryPath, "utf8");
    expect(noteText).toContain("## Worker fixable finding");
    expect(noteText).toContain("blocking_kind: worker_fixable");
    // The note file only carries blocker_id entries for the two minted (needs-user) notes.
    expect(noteText.match(/blocker_id:/g) ?? []).toHaveLength(2);
  });

  test("resolveBlocker and deferBlocker default the actor to 'orchestrator', never 'user'", async () => {
    await implementingMilestone();

    const opened = await openBlocker(cwd, {
      title: "Default-actor blocker",
      description: "No explicit createdBy supplied.",
    });
    expect(opened.created_by).toBe("orchestrator");

    const resolved = await resolveBlocker(cwd, {
      blockerId: opened.id,
      resolution: "Fixed without an explicit actor.",
    });
    expect(resolved.resolved_by).toBe("orchestrator");
    expect(resolved.resolved_by).not.toBe("user");

    const toDefer = await openBlocker(cwd, {
      title: "Deferred blocker",
      description: "Deferred without an explicit actor.",
    });
    const deferred = await deferBlocker(cwd, {
      blockerId: toDefer.id,
      deferReason: "Waiting on an external owner.",
    });
    expect(deferred.deferred_by).toBe("orchestrator");
    expect(deferred.deferred_by).not.toBe("user");
  });

  test("a deferred blocker can be resolved (deferred -> resolved), preserving defer history", async () => {
    await implementingMilestone();

    const opened = await openBlocker(cwd, {
      title: "Fix-after-defer blocker",
      description: "Deferred, then fixed by a worker.",
    });
    const deferred = await deferBlocker(cwd, {
      blockerId: opened.id,
      deferReason: "Blocked on upstream; revisit later.",
    });
    expect(deferred.status).toBe("deferred");

    const resolved = await resolveBlocker(cwd, {
      blockerId: opened.id,
      resolvedBy: "worker",
      resolution: "Upstream landed; worker applied the fix.",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolved_by).toBe("worker");
    // Defer fields remain intact as history.
    expect(resolved.deferred_by).toBe("orchestrator");
    expect(resolved.defer_reason).toBe("Blocked on upstream; revisit later.");

    // The resolved blocker no longer trips state validation.
    const validation = await validateRoadmapState(cwd);
    expect(validation.errors.map((error) => error.code)).not.toContain("blockers.blocking.open");
  });

  test("a blocker whose id is a running rework worker's rework_of is exempt from the open-blocker gate", async () => {
    await implementingMilestone();

    // A blocker scoped to a DIFFERENT task/wave than the rework worker below, so the only
    // possible exemption is the rework_of blocker-id match (imperfect scope-matching).
    const blocker = await openBlocker(cwd, {
      title: "Blocker under active rework",
      description: "A rework worker was dispatched to fix exactly this blocker.",
      taskId: "t02-report",
      waveId: "w02",
    });

    // Baseline: without any rework worker the real write-gate is closed on this open blocker.
    const closed = await validateImplementationGate(cwd);
    expect(closed.valid).toBe(false);
    expect(closed.errors.map((error) => error.code)).toContain("blockers.blocking.open");

    // Drive the exact functions the gate uses (reworkScopeFromState + openCanonicalBlockingIssues)
    // with a running rework worker whose rework_of names this blocker. Its task/wave (t01/w01)
    // deliberately do not match the blocker's scope (t02/w02), so exemption comes solely from
    // the rework_of blocker-id match. (Constructed in memory to exercise the exemption
    // independently of the runtime persistence round-trip for rework_of.)
    const reworkRun: WorkerRun = {
      task_id: "t01-state",
      wave_id: "w01",
      worker: "worker",
      agent_id: "rework-agent",
      job_id: "rework-job",
      owned_files: ["src/core/store.ts"],
      owned_modules: [],
      status: "running",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      transport_failures: 0,
      rework_of: blocker.id,
    };
    const reworkState = {
      milestone: { progress: { worker_runs: [reworkRun] } },
    } as unknown as LoadedState;

    const scope = reworkScopeFromState(reworkState);
    expect(scope.blockerIds.has(blocker.id)).toBe(true);
    // isUnderActiveRework must NOT already cover it (t02/w02 differ from the run's t01/w01),
    // proving the exemption is the new blocker-id path, not the pre-existing scope path.
    expect(scope.taskIds.has("t02-report")).toBe(false);
    expect(scope.waveIds.has("w02")).toBe(false);

    // Under the rework scope the open blocker is exempt; with no scope it still blocks.
    expect(openCanonicalBlockingIssues([blocker])).toHaveLength(1);
    expect(openCanonicalBlockingIssues([blocker], scope)).toHaveLength(0);
  });
});
