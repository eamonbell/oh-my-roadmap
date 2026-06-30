import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initProject } from "../src/core/project-init";
import { roadmapDocPath } from "../src/core/paths";
import { initRoadmap, transition, updateRoadmap } from "../src/core/store";
import { validateRoadmapState } from "../src/core/validation";

let cwd = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-engineer-qa-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

async function pathExists(relativePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, relativePath));
    return true;
  } catch {
    return false;
  }
}

describe("run-1 roadmap regression", () => {
  test("requires generated concrete roadmap milestones for the run-1 scenario", async () => {
    const prompt = await fs.readFile(
      path.join(import.meta.dir, "..", "qa-runs", "run-1", "prompt.txt"),
      "utf8",
    );

    await initProject(cwd);
    expect(await pathExists(".roadmap")).toBe(false);
    expect(await pathExists(".roadmaps/config.yml")).toBe(true);

    await initRoadmap(cwd, {
      roadmapId: "workflow-step-id-context",
      title: "Workflow Step-ID Context and Simplified Results",
      summary: prompt,
    });
    await transition(cwd, {
      operation: "record_discovery",
      discovery: {
        findings: [
          "Reviewed workflow context and result-envelope behavior from the run-1 prompt.",
        ],
      },
    });

    await expect(
      transition(cwd, { operation: "approve_roadmap", approver: "user" }),
    ).rejects.toThrow("finalized roadmap");
    expect((await validateRoadmapState(cwd)).errors.map((error) => error.code)).toContain(
      "roadmap.milestones.missing",
    );

    const state = await updateRoadmap(cwd, {
      goal: "Change workflow context sharing from named string values to step ID references.",
      successCriteria: [
        "Workflow context inputs reference specific prior steps by ID.",
        "Step result envelopes expose only the approved simplified fields.",
      ],
      constraints: ["Do not include prior step values directly in generated step prompts."],
      nonGoals: ["Do not create milestone task plans during roadmap creation."],
      context: [prompt],
      evidence: ["qa-runs/run-1/prompt.txt describes the real project request."],
      risks: ["Existing workflow update paths may need step ID remapping."],
      milestones: [
        {
          id: "m01-schema-contract",
          title: "Schema and API contract",
          status: "planned",
          goal: "Define the step reference and simplified result envelope contracts.",
          scope: [
            "Replace string context inputs with named step ID references.",
            "Define the simplified StepResultEnvelope fields.",
          ],
          non_goals: ["Do not implement runtime prompt changes in this roadmap milestone outline."],
          evidence: ["The run-1 prompt requires StepID, Status, Data, StopReason, and ErrorMessage only."],
          dependencies: [],
          risks: ["Client payloads may need breaking changes."],
          acceptance_intent: ["The approved contract is explicit enough for milestone planning."],
          verification_intent: ["Milestone planning will identify focused schema and API tests."],
        },
        {
          id: "m02-runtime-prompts",
          title: "Runtime prompt behavior",
          status: "planned",
          goal: "Ensure step prompts show context names and step IDs without embedding values.",
          scope: ["Update prompt generation and context resolution behavior."],
          non_goals: ["Do not remove context retrieval tools."],
          evidence: ["The run-1 prompt says not to include context input values in workflow step prompts."],
          dependencies: ["m01-schema-contract"],
          risks: ["Prompt golden fixtures may need extensive updates."],
          acceptance_intent: ["Prompt output includes references, not prior step values."],
          verification_intent: ["Milestone planning will include golden prompt verification."],
        },
      ],
    });

    const roadmapText = await fs.readFile(roadmapDocPath(cwd, state.roadmap_id), "utf8");
    expect(roadmapText).not.toContain("Roadmap intent, milestones, risks, and success criteria are drafted here.");
    expect(roadmapText).toContain("### m01-schema-contract - Schema and API contract");
    expect(roadmapText).toContain("### m02-runtime-prompts - Runtime prompt behavior");

    await transition(cwd, { operation: "approve_roadmap", approver: "user" });
    expect((await validateRoadmapState(cwd)).valid).toBe(true);
  });
});
