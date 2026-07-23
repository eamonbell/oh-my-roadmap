import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { transition } from "@oh-my-roadmap/core/store/index";
import { ensureConfig } from "@oh-my-roadmap/core/project-init";
import { roadmapsDir } from "@oh-my-roadmap/core/paths";
import { readYamlFile, writeYamlFile } from "@oh-my-roadmap/core/files";
import { prepareWaveDispatch, recordWaveResult, prepareWaveReview } from "@oh-my-roadmap/core/wave-orchestration/index";
import { createGitRepo, type GitRepoFixture } from "../git-fixture";
import { approvedMilestone } from "../state/helpers";
import { registeredTool, registerTools, toolContext } from "./helpers";

// Coverage for R24/F1's receipt-layer wiring: the registered `omr_record_wave_review` tool must
// surface the core `checkpoint` outcome (when git checkpoints are enabled) in its human receipt
// text, and must leave the receipt byte-for-byte unchanged when checkpoints are disabled.

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

describe("omr_record_wave_review checkpoint receipt", () => {
  let repo: GitRepoFixture | undefined;

  afterEach(() => {
    if (repo) {
      repo.remove();
      repo = undefined;
    }
  });

  test("checkpoints ON with owned-file changes: receipt reports a created commit and payload carries the sha", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await seedImpl(cwd, { checkpoints: true });
    await prepareWaveDispatch(cwd);
    repo.writeFile("src/core/store.ts", "export const store = 1;\n");
    await completeAndReview(cwd);

    const tools = registerTools();
    const recordWaveReviewTool = registeredTool(tools, "omr_record_wave_review");
    expect(recordWaveReviewTool).toBeDefined();

    const result = await recordWaveReviewTool!.execute(
      "record-wave-review",
      { status: "passed", summary: "Passed." },
      new AbortController().signal,
      undefined,
      toolContext(cwd),
    );

    const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Git checkpoint ");
    expect(text).toContain("created.");

    const details = result?.details as
      | { checkpoint?: { status?: string; commit?: string } }
      | undefined;
    expect(details?.checkpoint?.status).toBe("created");
    expect(typeof details?.checkpoint?.commit).toBe("string");
    expect(details?.checkpoint?.commit?.length).toBeGreaterThan(0);
  });

  test("checkpoints ON with no owned-file changes: receipt reports no_changes", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await seedImpl(cwd, { checkpoints: true });
    await prepareWaveDispatch(cwd);
    // No owned-file edits at all.
    await completeAndReview(cwd);

    const tools = registerTools();
    const recordWaveReviewTool = registeredTool(tools, "omr_record_wave_review");

    const result = await recordWaveReviewTool!.execute(
      "record-wave-review",
      { status: "passed", summary: "Passed." },
      new AbortController().signal,
      undefined,
      toolContext(cwd),
    );

    const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Git checkpoint skipped: no changes.");

    const details = result?.details as { checkpoint?: { status?: string } } | undefined;
    expect(details?.checkpoint?.status).toBe("no_changes");
  });

  test("checkpoints ON but unusable git (detached HEAD): receipt reports skipped and the wave still completes", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await seedImpl(cwd, { checkpoints: true });
    await prepareWaveDispatch(cwd);
    repo.writeFile("src/core/store.ts", "export const store = 1;\n");
    await completeAndReview(cwd);

    // Detach HEAD so the checkpoint cannot be created.
    repo.git("checkout", "--detach");

    const tools = registerTools();
    const recordWaveReviewTool = registeredTool(tools, "omr_record_wave_review");

    const result = await recordWaveReviewTool!.execute(
      "record-wave-review",
      { status: "passed", summary: "Passed." },
      new AbortController().signal,
      undefined,
      toolContext(cwd),
    );

    const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Git checkpoint skipped.");

    const details = result?.details as
      | { checkpoint?: { status?: string }; wave_status?: string }
      | undefined;
    expect(details?.checkpoint?.status).toBe("skipped");
    expect(details?.wave_status).toBe("complete");
  });

  test("checkpoints DISABLED: passed receipt is unchanged and payload carries no checkpoint field", async () => {
    repo = createGitRepo({ initialCommit: true });
    const cwd = repo.cwd;
    await seedImpl(cwd, { checkpoints: false });
    await prepareWaveDispatch(cwd);
    repo.writeFile("src/core/store.ts", "export const store = 1;\n");
    await completeAndReview(cwd);

    const tools = registerTools();
    const recordWaveReviewTool = registeredTool(tools, "omr_record_wave_review");

    const result = await recordWaveReviewTool!.execute(
      "record-wave-review",
      { status: "passed", summary: "Passed." },
      new AbortController().signal,
      undefined,
      toolContext(cwd),
    );

    const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "";
    expect(text).not.toContain("Git checkpoint");
    // The original passed receipt text is preserved exactly (no next-action hint fired here since
    // recordWaveReview's own auto-advance next_actions win when present; assert the base sentence).
    expect(text.startsWith("Recorded wave review as passed.")).toBe(true);

    const details = result?.details as { checkpoint?: unknown } | undefined;
    expect(details?.checkpoint).toBeUndefined();
  });

  test("omr_record_wave_review's input schema does not accept a reviewToken/review_token field", () => {
    const tools = registerTools();
    const recordWaveReviewTool = registeredTool(tools, "omr_record_wave_review");
    expect(recordWaveReviewTool).toBeDefined();

    const shape = (recordWaveReviewTool?.parameters as { shape?: Record<string, unknown> } | undefined)?.shape;
    expect(shape).toBeDefined();
    expect(shape).not.toHaveProperty("reviewToken");
    expect(shape).not.toHaveProperty("review_token");
  });
});
