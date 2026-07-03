import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initRoadmap, writeActive } from "oh-my-roadmap-core/store/index";
import { searchContext, readContext } from "oh-my-roadmap-core/context";
import { decisionsPath, milestoneNotesPath, milestonePlanPath, risksPath, roadmapDocPath } from "oh-my-roadmap-core/paths";

let cwd = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-context-"));
  await initRoadmap(cwd, { roadmapId: "active-roadmap", title: "Active Roadmap" });
  await writeContextFixtures();
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

async function writeContextFixtures(): Promise<void> {
  await writeActive(cwd, {
    roadmap_id: "active-roadmap",
    milestone_id: "m01-core",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  await fs.writeFile(
    roadmapDocPath(cwd, "active-roadmap"),
    `---
roadmap_id: active-roadmap
title: Active Roadmap
status: finalized
---

# Active Roadmap

## Goal

Reduce context usage without removing implementation-critical detail.

## Acceptance Intent

Agents can retrieve exact roadmap sections by ID when needed.
`,
    "utf8",
  );

  await fs.mkdir(path.dirname(milestonePlanPath(cwd, "active-roadmap", "m01-core")), { recursive: true });
  await fs.writeFile(
    milestonePlanPath(cwd, "active-roadmap", "m01-core"),
    `---
roadmap_id: active-roadmap
milestone_id: m01-core
title: Core Milestone
status: milestone_approved
---

# Core Milestone

## Summary

Milestone: m01-core

## Required Work

### t01-parser - Parser

Task ownership and exact verification commands stay available in the full plan.
`,
    "utf8",
  );

  await fs.mkdir(path.dirname(milestoneNotesPath(cwd, "active-roadmap", "m01-core")), { recursive: true });
  await fs.writeFile(
    milestoneNotesPath(cwd, "active-roadmap", "m01-core"),
    `# Milestone Notes

---
kind: worker
roadmap_id: active-roadmap
milestone_id: m01-core
wave_id: w01
task_id: t01-parser
worker_id: alice
blocking: false
status: resolved
at: 2026-01-01T00:00:00.000Z
---

## Worker finished parser

Changed parser behavior and ran bun test successfully.
`,
    "utf8",
  );

  await fs.mkdir(path.dirname(milestoneNotesPath(cwd, "active-roadmap", "m02-review")), { recursive: true });
  await fs.writeFile(
    milestoneNotesPath(cwd, "active-roadmap", "m02-review"),
    `# Milestone Notes

---
kind: issue
roadmap_id: active-roadmap
milestone_id: m02-review
wave_id: w02
task_id: t02-api
worker_id: bob
blocking: true
status: open
at: 2026-01-02T00:00:00.000Z
---

## Blocking API issue

The API issue needs user approval before the next wave can start.
`,
    "utf8",
  );

  await fs.writeFile(
    decisionsPath(cwd, "active-roadmap"),
    `# Decision Register

## Use context tools

Selected a search-first workflow for large markdown registers.

## Keep read_state lean

Do not include milestone notes in structured state.
`,
    "utf8",
  );

  await fs.writeFile(
    risksPath(cwd, "active-roadmap"),
    `# Risk Register

## Large notes can consume context

Mitigate with snippets and capped read expansion.
`,
    "utf8",
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("roadmap context search", () => {
  test("searches notes across milestones and heading sections for decisions and risks", async () => {
    const result = await searchContext(cwd, {});

    expect(result.roadmapId).toBe("active-roadmap");
    expect(result.total).toBe(5);
    expect(result.returned).toBe(5);
    expect(result.results.map((entry) => entry.id)).toEqual([
      "notes:m02-review:1",
      "notes:m01-core:1",
      "decisions:1",
      "decisions:2",
      "risks:1",
    ]);
    expect(result.results[0]?.body).toBeUndefined();
    expect(result.results.find((entry) => entry.id === "decisions:1")?.title).toBe("Use context tools");
  });

  test("filters notes by metadata without requiring a text query", async () => {
    const result = await searchContext(cwd, {
      artifacts: ["notes"],
      milestoneIds: ["m01-core"],
      kinds: ["worker"],
      statuses: ["resolved"],
      blocking: false,
      waveId: "w01",
      taskId: "t01-parser",
      workerId: "alice",
    });

    expect(result.total).toBe(1);
    expect(result.results[0]?.id).toBe("notes:m01-core:1");
  });

  test("supports substring search, case sensitivity, regex search, and invalid regex errors", async () => {
    expect((await searchContext(cwd, { query: "PARSER" })).total).toBe(1);
    expect((await searchContext(cwd, { query: "PARSER", caseSensitive: true })).total).toBe(0);
    expect((await searchContext(cwd, { query: "API\\s+issue", useRegex: true })).results[0]?.id).toBe(
      "notes:m02-review:1",
    );

    await expect(searchContext(cwd, { query: "[", useRegex: true })).rejects.toThrow();
  });

  test("returns snippets by default and caps optional bodies", async () => {
    const result = await searchContext(cwd, {
      artifacts: ["decisions"],
      query: "search-first",
      snippetChars: 24,
      includeBodies: true,
      maxBodyChars: 12,
    });

    expect(result.total).toBe(1);
    expect(result.results[0]?.snippetTruncated).toBe(true);
    expect(result.results[0]?.body).toHaveLength(12);
    expect(result.results[0]?.bodyTruncated).toBe(true);
  });

  test("reads selected context IDs and reports missing IDs", async () => {
    const result = await readContext(cwd, {
      ids: ["decisions:1", "missing"],
      maxBodyChars: 16,
    });

    expect(result.requested).toBe(2);
    expect(result.found).toBe(1);
    expect(result.missingIds).toEqual(["missing"]);
    expect(result.results[0]?.body).toHaveLength(16);
    expect(result.results[0]?.bodyTruncated).toBe(true);
  });

  test("searches and reads roadmap and plan sections without reading whole files", async () => {
    const roadmap = await searchContext(cwd, {
      artifacts: ["roadmap"],
      query: "implementation-critical",
    });
    expect(roadmap.total).toBe(1);
    expect(roadmap.results[0]?.id).toBe("roadmap:goal");
    expect(roadmap.results[0]?.body).toBeUndefined();

    const plan = await searchContext(cwd, {
      artifacts: ["plan"],
      query: "Required Work",
    });
    expect(plan.total).toBe(1);
    expect(plan.results[0]?.id).toBe("plan:m01-core:required-work");
    expect(plan.results[0]?.milestoneId).toBe("m01-core");

    const expanded = await readContext(cwd, {
      ids: ["roadmap:goal", "plan:m01-core:required-work"],
      maxBodyChars: 200,
    });
    expect(expanded.found).toBe(2);
    expect(expanded.results.map((entry) => entry.id)).toEqual([
      "roadmap:goal",
      "plan:m01-core:required-work",
    ]);
    expect(expanded.results[1]?.body).toContain("### t01-parser - Parser");
  });
});
