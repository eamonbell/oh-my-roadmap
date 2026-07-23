import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { transition, loadMilestoneRuntime } from "@oh-my-roadmap/core/store/index";
import { ensureConfig } from "@oh-my-roadmap/core/project-init";
import { roadmapsDir } from "@oh-my-roadmap/core/paths";
import { readYamlFile, writeYamlFile } from "@oh-my-roadmap/core/files";
import {
  prepareWaveDispatch,
  recordWorkerDispatch,
} from "@oh-my-roadmap/core/wave-orchestration/index";
import type { WaveGitState } from "@oh-my-roadmap/core/types";
import { createGitRepo, type GitRepoFixture } from "../git-fixture";
import {
  approvedMilestone,
  createTempRoadmapCwd,
  removeTempRoadmapCwd,
} from "./helpers";

// Enable the project-scope git_checkpoints flag by writing the default config then flipping it.
async function enableGitCheckpoints(cwd: string): Promise<void> {
  await ensureConfig(cwd);
  const configPath = path.join(roadmapsDir(cwd), "config.yml");
  const raw = await readYamlFile<Record<string, unknown>>(configPath);
  raw.orchestration = { transport_resume_attempts: 3, git_checkpoints: true };
  await writeYamlFile(configPath, raw);
}

async function w01Git(cwd: string): Promise<WaveGitState | undefined> {
  const runtime = await loadMilestoneRuntime(cwd, "complex-refactor", "m01-core");
  return runtime.waves.find((wave) => wave.id === "w01")?.git;
}

describe("wave dispatch git start boundary capture", () => {
  let repo: GitRepoFixture | undefined;
  let plainCwd = "";

  afterEach(async () => {
    if (repo) {
      repo.remove();
      repo = undefined;
    }
    await removeTempRoadmapCwd(plainCwd);
    plainCwd = "";
  });

  test("fresh dispatch in a git repo captures wave.git.start exactly once", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await approvedMilestone(cwd);
    await transition(cwd, { operation: "start_implementation" });

    const headBefore = repo.head();
    const result = await prepareWaveDispatch(cwd);

    // wave_git surfaces availability + the (default off) checkpoints flag, no warnings.
    expect(result.wave_git).toEqual({ available: true, checkpoints_enabled: false, warnings: [] });

    // The start boundary is persisted onto the active wave's runtime git.start.
    const git = await w01Git(cwd);
    expect(git?.start?.start_head).toBe(headBefore);
    expect(git?.start?.predirty).toEqual([]);
    expect(typeof git?.start?.captured_at).toBe("string");
    expect(git?.checkpoint).toBeUndefined();
  });

  test("wave_git.checkpoints_enabled reflects the project config", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await approvedMilestone(cwd);
    await enableGitCheckpoints(cwd);
    await transition(cwd, { operation: "start_implementation" });

    const result = await prepareWaveDispatch(cwd);
    expect(result.wave_git?.available).toBe(true);
    expect(result.wave_git?.checkpoints_enabled).toBe(true);
  });

  test("active-runs short-circuit does not re-capture the start boundary even if HEAD moved", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await approvedMilestone(cwd);
    await transition(cwd, { operation: "start_implementation" });

    const headBefore = repo.head();
    await prepareWaveDispatch(cwd);
    // Take a lease so the next dispatch hits the active-runs short-circuit.
    await recordWorkerDispatch(cwd, { taskId: "t01-state", agentId: "agent-a", jobId: "job-a" });

    // Move HEAD after the boundary was captured.
    repo.writeFile("moved.txt", "moved\n");
    repo.commitAll("advance HEAD");
    const headAfter = repo.head();
    expect(headAfter).not.toBe(headBefore);

    const redispatch = await prepareWaveDispatch(cwd);
    expect(redispatch.assignments).toEqual([]);
    expect(redispatch.active_runs).toHaveLength(1);
    // wave_git is still reported (current availability) on the short-circuit path.
    expect(redispatch.wave_git?.available).toBe(true);

    // The captured start_head is unchanged — capture happens exactly once, on the fresh path.
    const git = await w01Git(cwd);
    expect(git?.start?.start_head).toBe(headBefore);
  });

  test("dispatch in a non-git cwd still succeeds and persists no wave.git", async () => {
    plainCwd = await createTempRoadmapCwd();
    await approvedMilestone(plainCwd);
    await transition(plainCwd, { operation: "start_implementation" });

    const result = await prepareWaveDispatch(plainCwd);
    expect(result.progress_step).toBe("dispatching");
    expect(result.assignments).toHaveLength(1);
    expect(result.wave_git?.available).toBe(false);
    expect(result.wave_git?.warnings.length).toBe(1);
    expect(result.wave_git?.warnings[0]).toContain("Git boundary unavailable");

    const runtime = await loadMilestoneRuntime(plainCwd, "complex-refactor", "m01-core");
    expect(runtime.waves.find((wave) => wave.id === "w01")?.git).toBeUndefined();
  });
});
