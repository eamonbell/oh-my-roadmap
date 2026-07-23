import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registeredTool, registerTools, toolContext } from "./helpers";

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

describe("omr_task_briefing", () => {
  test("registers as a read-only tool", () => {
    const tools = registerTools();
    const tool = registeredTool(tools, "omr_task_briefing");
    expect(tool?.approval).toBe("read");
  });

  test("assembles sizes, excerpts, import edges, skips out-of-repo paths, and caps by response_format", async () => {
    const tools = registerTools();
    const tool = registeredTool(tools, "omr_task_briefing");
    if (!tool) throw new Error("omr_task_briefing not registered");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omr-task-briefing-"));
    try {
      await fs.mkdir(path.join(cwd, "src"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, "src", "a.ts"),
        `import { helper } from './b';\nexport function main() { return helper(); }\n`,
      );
      const bigContent = `export function helper() { return 1; }\n` + "// padding line\n".repeat(2000);
      await fs.writeFile(path.join(cwd, "src", "b.ts"), bigContent);

      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "omr-outside-"));
      const outsidePath = path.join(outsideDir, "outside.ts");
      await fs.writeFile(outsidePath, "export const x = 1;\n");

      const conciseResult = await tool.execute(
        "call-1",
        {
          owned_paths: ["src/a.ts"],
          dependency_paths: ["src/b.ts", "../outside.ts", outsidePath],
          response_format: "concise",
        },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      const concise = expectRecord(conciseResult.details, "task briefing details");

      const files = concise.files as Array<Record<string, unknown>>;
      expect(Array.isArray(files)).toBe(true);
      const aEntry = files.find((f) => f.path === "src/a.ts");
      const bEntry = files.find((f) => f.path === "src/b.ts");
      expect(aEntry).toBeTruthy();
      expect(bEntry).toBeTruthy();
      expect(typeof aEntry?.size_bytes).toBe("number");
      expect((aEntry?.size_bytes as number) > 0).toBe(true);
      expect(typeof bEntry?.excerpt).toBe("string");
      expect(bEntry?.excerpt_truncated).toBe(true);
      expect((bEntry?.excerpt as string).length < bigContent.length).toBe(true);

      const edges = concise.import_edges as Array<Record<string, unknown>>;
      expect(edges.some((edge) => edge.from === "src/a.ts" && edge.to === "src/b.ts")).toBe(true);

      const skipped = concise.skipped as Array<Record<string, unknown>>;
      expect(skipped.some((entry) => entry.path === "../outside.ts")).toBe(true);
      expect(skipped.some((entry) => entry.path === outsidePath)).toBe(true);
      expect(files.some((f) => f.path === "outside.ts")).toBe(false);

      expect(typeof concise.lsp_note).toBe("string");
      expect((concise.lsp_note as string).includes("xd://lsp")).toBe(true);

      const detailedResult = await tool.execute(
        "call-2",
        {
          owned_paths: ["src/a.ts"],
          dependency_paths: ["src/b.ts"],
          response_format: "detailed",
        },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      const detailed = expectRecord(detailedResult.details, "detailed task briefing details");
      const detailedFiles = detailed.files as Array<Record<string, unknown>>;
      const detailedB = detailedFiles.find((f) => f.path === "src/b.ts");
      expect(typeof detailedB?.excerpt).toBe("string");
      expect((detailedB?.excerpt as string).length > (bEntry?.excerpt as string).length).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
