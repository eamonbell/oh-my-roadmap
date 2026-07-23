import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { transition, loadMilestoneRuntime } from "@oh-my-roadmap/core/store/index";
import { ensureConfig } from "@oh-my-roadmap/core/project-init";
import { roadmapsDir } from "@oh-my-roadmap/core/paths";
import { readYamlFile, writeYamlFile } from "@oh-my-roadmap/core/files";
import {
  prepareWaveDispatch,
  prepareWaveReview,
  recordWaveResult,
  recordWaveReview,
  commitWaveCheckpoint,
} from "@oh-my-roadmap/core/wave-orchestration/index";
import type { CommitWaveCheckpointInput } from "@oh-my-roadmap/core/wave-orchestration/index";
import { createGitRepo, type GitRepoFixture } from "../git-fixture";
import { approvedMilestone } from "./helpers";

async function enableGitCheckpoints(cwd: string): Promise<void> {
  await ensureConfig(cwd);
  const configPath = path.join(roadmapsDir(cwd), "config.yml");
  const raw = await readYamlFile<Record<string, unknown>>(configPath);
  raw.orchestration = { transport_resume_attempts: 3, git_checkpoints: true };
  await writeYamlFile(configPath, raw);
}

async function seedImpl(cwd: string, opts: { checkpoints: boolean }): Promise<void> {
  await approvedMilestone(cwd);
  if (opts.checkpoints) await enableGitCheckpoints(cwd);
  await transition(cwd, { operation: "start_implementation" });
}

async function completeAndReview(cwd: string): Promise<void> {
  await recordWaveResult(cwd, { taskId: "t01-state", status: "completed", summary: "State task done." });
  await prepareWaveReview(cwd);
}

async function w01(cwd: string) {
  const runtime = await loadMilestoneRuntime(cwd, "complex-refactor", "m01-core");
  return runtime.waves.find((wave) => wave.id === "w01");
}

// Files whose diff-from-parent the checkpoint commit introduced (changed paths only).
function committedPaths(repo: GitRepoFixture): string[] {
  return repo
    .git("show", "--name-only", "--format=", "HEAD")
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("wave checkpoint lifecycle", () => {
  let repo: GitRepoFixture | undefined;

  afterEach(() => {
    if (repo) {
      repo.remove();
      repo = undefined;
    }
  });

  test("checkpoints OFF: passed review completes the wave without a commit", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await seedImpl(cwd, { checkpoints: false });
    await prepareWaveDispatch(cwd);
    repo.writeFile("src/core/store.ts", "export const store = 1;\n");
    await completeAndReview(cwd);

    const headBefore = repo.head();
    const result = await recordWaveReview(cwd, { status: "passed", summary: "Passed." });

    expect(result.wave_status).toBe("complete");
    expect(result.checkpoint).toBeUndefined();
    // No commit was created.
    expect(repo.head()).toBe(headBefore);
    expect((await w01(cwd))?.git?.checkpoint).toBeUndefined();
  });

  test("checkpoints ON: passed review with owned changes creates exactly one owned-only commit", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await seedImpl(cwd, { checkpoints: true });
    await prepareWaveDispatch(cwd);
    // Worker edits the owned file, plus an UNOWNED change that must stay in the worktree.
    repo.writeFile("src/core/store.ts", "export const store = 1;\n");
    repo.writeFile("unowned.txt", "not owned by this wave\n");
    await completeAndReview(cwd);

    const headBefore = repo.head();
    const result = await recordWaveReview(cwd, { status: "passed", summary: "Passed." });

    expect(result.checkpoint?.status).toBe("created");
    expect(typeof result.checkpoint?.commit).toBe("string");
    expect(result.checkpoint?.warnings).toEqual([]);

    // Exactly one new commit.
    const newHead = repo.head();
    expect(newHead).not.toBe(headBefore);
    expect(result.checkpoint?.commit).toBe(newHead);
    expect(repo.git("rev-list", "--count", `${headBefore}..${newHead}`).stdout.trim()).toBe("1");

    // Subject + trailers.
    const body = repo.git("log", "-1", "--format=%B", "HEAD").stdout;
    expect(body).toContain("omr(w01): Implement state storage.");
    expect(body).toContain("OMR-Workflow: roadmap");
    expect(body).toContain("OMR-Roadmap: complex-refactor");
    expect(body).toContain("OMR-Milestone: m01-core");
    expect(body).toContain("OMR-Wave: w01");
    expect(body).toContain('OMR-Tasks: ["t01-state"]');

    // The commit contains ONLY the owned path; the unowned change is left uncommitted.
    expect(committedPaths(repo)).toEqual(["src/core/store.ts"]);
    expect(repo.git("status", "--porcelain").stdout).toContain("unowned.txt");

    // Wave completes and R6 auto-advance moves the active wave onto the next pending wave.
    expect(result.wave_status).toBe("complete");
    expect(result.progress_step).toBe("not_started");
    const runtime = await loadMilestoneRuntime(cwd, "complex-refactor", "m01-core");
    expect(runtime.progress.active_wave_id).toBe("w02");
    // Checkpoint persisted onto wave runtime, start preserved.
    const gitState = runtime.waves.find((wave) => wave.id === "w01")?.git;
    expect(gitState?.checkpoint?.status).toBe("created");
    expect(gitState?.checkpoint?.commit).toBe(newHead);
    expect(gitState?.start?.start_head).toBe(headBefore);
  });

  test("prepareWaveReview surfaces owned-path diffs as wave_changes (independent of the flag)", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    // checkpoints OFF — diffs are available whenever the cwd is a usable repo.
    await seedImpl(cwd, { checkpoints: false });
    await prepareWaveDispatch(cwd);
    repo.writeFile("src/core/store.ts", "export const store = 1;\n");
    await recordWaveResult(cwd, { taskId: "t01-state", status: "completed", summary: "done" });

    const review = await prepareWaveReview(cwd);
    expect(review.wave_changes?.available).toBe(true);
    const changed = review.wave_changes?.files.map((file) => file.path);
    expect(changed).toEqual(["src/core/store.ts"]);
    expect(review.wave_changes?.files[0]?.status).toBe("added");
  });

  test("checkpoints ON but detached HEAD: skipped with a warning, wave still completes", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await seedImpl(cwd, { checkpoints: true });
    await prepareWaveDispatch(cwd);
    repo.writeFile("src/core/store.ts", "export const store = 1;\n");
    await completeAndReview(cwd);

    // Detach HEAD before recording the review.
    repo.git("checkout", "--detach");
    const headBefore = repo.head();

    const result = await recordWaveReview(cwd, { status: "passed", summary: "Passed." });

    expect(result.checkpoint?.status).toBe("skipped");
    expect(result.checkpoint?.warnings.length).toBe(1);
    expect(result.checkpoint?.warnings[0]).toContain("detached HEAD");
    expect(result.wave_status).toBe("complete");
    // No commit created on the detached HEAD.
    expect(repo.head()).toBe(headBefore);
    expect((await w01(cwd))?.git?.checkpoint?.status).toBe("skipped");
  });

  test("failing pre-commit hook: recordWaveReview(passed) throws and leaves the wave reviewing", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await seedImpl(cwd, { checkpoints: true });
    repo.installPreCommitHook("#!/bin/sh\nexit 1\n");
    await prepareWaveDispatch(cwd);
    repo.writeFile("src/core/store.ts", "export const store = 1;\n");
    await completeAndReview(cwd);

    const headBefore = repo.head();
    await expect(recordWaveReview(cwd, { status: "passed", summary: "Passed." })).rejects.toThrow();

    // The wave is NOT complete — still reviewing — and no commit was made.
    const runtime = await loadMilestoneRuntime(cwd, "complex-refactor", "m01-core");
    expect(runtime.waves.find((wave) => wave.id === "w01")?.status).toBe("reviewing");
    expect(runtime.progress.step).toBe("wave_review");
    expect(repo.head()).toBe(headBefore);
  });

  test("idempotent retry: re-committing the same wave makes no second commit", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await seedImpl(cwd, { checkpoints: true });
    await prepareWaveDispatch(cwd);
    repo.writeFile("src/core/store.ts", "export const store = 1;\n");
    await completeAndReview(cwd);

    const result = await recordWaveReview(cwd, { status: "passed", summary: "Passed." });
    expect(result.checkpoint?.status).toBe("created");
    const head1 = repo.head();
    expect(result.checkpoint?.commit).toBe(head1);

    // Replaying the exact checkpoint input (the crash-retry path) must not create a second commit:
    // commitWaveCheckpoint detects its own OMR-Wave identity trailer on HEAD and returns the sha.
    const input: CommitWaveCheckpointInput = {
      waveId: "w01",
      waveGoal: "Implement state storage.",
      taskIds: ["t01-state"],
      ownedPathspecs: ["src/core/store.ts"],
      workflow: "roadmap",
      roadmapId: "complex-refactor",
      milestoneId: "m01-core",
    };
    const retry = await commitWaveCheckpoint(cwd, input);
    expect(retry.status).toBe("created");
    expect(retry.commit).toBe(head1);
    expect(repo.head()).toBe(head1);
  });

  test("collision warning: an owned path dirty before dispatch is flagged when committed", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await seedImpl(cwd, { checkpoints: true });
    // Owned file is already dirty (untracked) BEFORE dispatch → captured in predirty.
    repo.writeFile("src/core/store.ts", "pre-existing work\n");
    await prepareWaveDispatch(cwd);
    // Predirty was recorded for the owned path.
    expect((await w01(cwd))?.git?.start?.predirty).toContain("src/core/store.ts");

    // Worker continues editing the same file.
    repo.writeFile("src/core/store.ts", "pre-existing work\nplus worker edit\n");
    await completeAndReview(cwd);

    const result = await recordWaveReview(cwd, { status: "passed", summary: "Passed." });
    expect(result.checkpoint?.status).toBe("created");
    expect(result.checkpoint?.warnings.some((w) => w.includes("pre-existing"))).toBe(true);
  });

  test("no_changes: passed review with no owned-file changes records no_changes and no commit", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await seedImpl(cwd, { checkpoints: true });
    await prepareWaveDispatch(cwd);
    // No owned-file edits at all.
    await completeAndReview(cwd);

    const headBefore = repo.head();
    const result = await recordWaveReview(cwd, { status: "passed", summary: "Passed." });

    expect(result.checkpoint?.status).toBe("no_changes");
    expect(result.checkpoint?.commit).toBeUndefined();
    expect(result.checkpoint?.warnings).toEqual([]);
    expect(result.wave_status).toBe("complete");
    expect(repo.head()).toBe(headBefore);
    expect((await w01(cwd))?.git?.checkpoint?.status).toBe("no_changes");
  });
});
