import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initProject, setProjectStyle } from "@oh-my-roadmap/core/project-init";
import { detectLanguages, renderStyleGuide, styleGuideForFiles } from "@oh-my-roadmap/core/style";
import { parseYaml } from "@oh-my-roadmap/core/frontmatter";

let cwd = "";
let home = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omr-style-cwd-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "omr-style-home-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

async function writeGlobalStyle(text: string): Promise<void> {
  const filePath = path.join(home, ".omp", "oh-my-roadmap", "config.yml");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

describe("language detection", () => {
  test("maps file extensions to language ids", () => {
    expect(detectLanguages(["a/b.ts", "c.tsx", "d.go", "e.py", "f.unknownext"])).toEqual([
      "go",
      "python",
      "typescript",
    ]);
  });
});

describe("setProjectStyle", () => {
  test("upserts per-language guidance into the project config", async () => {
    await setProjectStyle(cwd, "go", { summary: "tabs", guidelines: ["gofmt"] });
    await setProjectStyle(cwd, "typescript", { guidelines: ["single quotes"] });
    // Re-recording replaces the language's guidance.
    await setProjectStyle(cwd, "go", { guidelines: ["tabs, short names"] });

    const config = parseYaml<Record<string, any>>(await fs.readFile(path.join(cwd, ".omr", "config.yml"), "utf8"));
    expect(config.style).toEqual({
      go: { guidelines: ["tabs, short names"] },
      typescript: { guidelines: ["single quotes"] },
    });
  });
});

describe("styleGuideForFiles", () => {
  test("returns merged guidance for the files' languages", async () => {
    await writeGlobalStyle(
      [
        "agents:",
        "  worker: {}",
        "  reviewer: {}",
        "style:",
        "  go:",
        "    guidelines: [gofmt]",
        "  typescript:",
        "    guidelines: [global-ts]",
        "",
      ].join("\n"),
    );
    // Project overrides typescript, leaves go to the global config.
    await setProjectStyle(cwd, "typescript", { summary: "tabs", guidelines: ["project-ts"] });

    const entries = await styleGuideForFiles(cwd, ["src/main.ts", "cmd/app.go", "notes.md"], home);
    const byLang = Object.fromEntries(entries.map((e) => [e.language, e.guide]));
    expect(byLang.typescript).toEqual({ summary: "tabs", guidelines: ["project-ts"] });
    expect(byLang.go).toEqual({ guidelines: ["gofmt"] });
    expect(byLang.markdown).toBeUndefined();
  });

  test("returns empty when no guidance is recorded", async () => {
    expect(await styleGuideForFiles(cwd, ["a.ts"], home)).toEqual([]);
    expect(renderStyleGuide([])).toContain("No recorded code-style guidance");
  });
});

describe("aux agent generation", () => {
  test("initProject generates a style-scout agent", async () => {
    await initProject(cwd);
    const scout = await fs.readFile(path.join(cwd, ".omp", "agents", "style-scout.md"), "utf8");
    expect(scout).toContain("name: style-scout");
    expect(scout).toContain("# Style Scout");
  });
});
