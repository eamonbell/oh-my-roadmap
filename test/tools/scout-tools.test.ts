import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { roadmapScoutFindingsPath } from "@oh-my-roadmap/core/paths";
import { initRoadmap } from "@oh-my-roadmap/core/store/index";
import type { ScoutFinding } from "@oh-my-roadmap/core/types";
import { registeredTool, registerTools, toolContext } from "./helpers";

interface ListResult {
  roadmapId?: string;
  total: number;
  returned: number;
  findings: ScoutFinding[];
}

async function tempCwd(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-scout-tools-"));
}

describe("roadmap scout finding tools", () => {
  test("registers scout tools with the expected approvals", () => {
    const tools = registerTools();
    expect(registeredTool(tools, "omr_record_scout_finding")?.approval).toBe("write");
    expect(registeredTool(tools, "omr_list_scout_findings")?.approval).toBe("read");
  });

  test("omr_record_scout_finding appends a roadmap-scoped JSONL record", async () => {
    const recordTool = registeredTool(registerTools(), "omr_record_scout_finding");
    const cwd = await tempCwd();
    try {
      await initRoadmap(cwd, { roadmapId: "scout-roadmap", title: "Scout Roadmap" });

      const result = await recordTool?.execute(
        "record",
        {
          subsystem: "auth",
          milestoneIds: ["m01-core"],
          sourcePaths: ["src/auth.ts"],
          summary: "Auth subsystem overview.",
          findings: ["Uses signed JWT sessions."],
        },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );

      const finding = result?.details as ScoutFinding;
      expect(finding.subsystem).toBe("auth");
      expect(finding.roadmap_id).toBe("scout-roadmap");
      expect(finding.id).toMatch(/^scout_/);
      const text = (result?.content?.[0] as { text?: string } | undefined)?.text ?? "";
      expect(text).toBe(`Recorded scout finding ${finding.id} for auth.`);

      const raw = await fs.readFile(roadmapScoutFindingsPath(cwd, "scout-roadmap"), "utf8");
      const lines = raw.split("\n").filter((line) => line.trim() !== "");
      expect(lines).toHaveLength(1);
      const persisted = JSON.parse(lines[0]!) as ScoutFinding;
      expect(persisted.summary).toBe("Auth subsystem overview.");
      expect(persisted.source_paths).toEqual(["src/auth.ts"]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("omr_list_scout_findings filters by subsystem, milestone, source path, stale, and limit", async () => {
    const tools = registerTools();
    const recordTool = registeredTool(tools, "omr_record_scout_finding");
    const listTool = registeredTool(tools, "omr_list_scout_findings");
    const cwd = await tempCwd();
    try {
      await initRoadmap(cwd, { roadmapId: "scout-roadmap", title: "Scout Roadmap" });

      const record = (params: Record<string, unknown>) =>
        recordTool?.execute("record", params, new AbortController().signal, undefined, toolContext(cwd));
      const list = async (params: Record<string, unknown>): Promise<ListResult> =>
        (
          await listTool?.execute("list", params, new AbortController().signal, undefined, toolContext(cwd))
        )?.details as ListResult;

      await record({ subsystem: "auth", milestoneIds: ["m01-core"], sourcePaths: ["src/auth.ts"], summary: "Auth A." });
      await record({ subsystem: "auth", milestoneIds: ["m02-ui"], sourcePaths: ["src/login.ts"], summary: "Auth B." });
      await record({ subsystem: "billing", milestoneIds: ["m02-ui"], sourcePaths: ["src/billing.ts"], summary: "Billing." });
      await record({ subsystem: "auth", summary: "Stale auth note.", stale: true });

      // Default list omits stale findings.
      const all = await list({});
      expect(all.total).toBe(3);
      expect(all.findings.every((finding) => finding.stale !== true)).toBe(true);

      // Stale findings surface when requested.
      const withStale = await list({ includeStale: true });
      expect(withStale.total).toBe(4);

      // Subsystem filter (stale excluded by default).
      expect((await list({ subsystem: "auth" })).total).toBe(2);
      expect((await list({ subsystem: "billing" })).total).toBe(1);

      // Milestone and source-path filters.
      expect((await list({ milestoneId: "m02-ui" })).total).toBe(2);
      expect((await list({ sourcePath: "src/auth.ts" })).total).toBe(1);

      // Limit caps the returned findings after filtering.
      const limited = await list({ limit: 1 });
      expect(limited.total).toBe(3);
      expect(limited.returned).toBe(1);
      expect(limited.findings).toHaveLength(1);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("omr_list_scout_findings returns an empty result when no store exists", async () => {
    const listTool = registeredTool(registerTools(), "omr_list_scout_findings");
    const cwd = await tempCwd();
    try {
      await initRoadmap(cwd, { roadmapId: "scout-roadmap", title: "Scout Roadmap" });
      const result = await listTool?.execute(
        "list",
        {},
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(result?.details).toMatchObject({ total: 0, returned: 0, findings: [] });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
