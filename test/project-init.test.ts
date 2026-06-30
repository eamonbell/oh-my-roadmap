import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initProject } from "../src/core/project-init";
import { parseMarkdownDocument, parseYaml } from "../src/core/frontmatter";

let cwd = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-engineer-init-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

async function readFile(relativePath: string): Promise<string> {
  return await fs.readFile(path.join(cwd, relativePath), "utf8");
}

async function writeFile(relativePath: string, text: string): Promise<void> {
  const filePath = path.join(cwd, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function pathExists(relativePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, relativePath));
    return true;
  } catch {
    return false;
  }
}

describe("project init scaffold", () => {
  test("creates default config and local worker and reviewer agents", async () => {
    const result = await initProject(cwd);

    expect(result.createdConfig).toBe(true);
    expect(parseYaml<Record<string, unknown>>(await readFile(".roadmaps/config.yml"))).toEqual({
      agents: { worker: {}, reviewer: {} },
    });

    const worker = parseMarkdownDocument(await readFile(".omp/agents/worker.md"));
    expect(worker.data).toMatchObject({
      name: "worker",
      description: "Use for scoped roadmap-engineer implementation tasks assigned by an implementation orchestrator.",
    });
    expect(worker.data.model).toBeUndefined();
    expect(worker.data["thinking-level"]).toBeUndefined();
    expect(worker.body).toContain("# Worker");

    const reviewer = parseMarkdownDocument(await readFile(".omp/agents/reviewer.md"));
    expect(reviewer.data).toMatchObject({
      name: "reviewer",
      description: "Use for roadmap-engineer per-wave and closeout reviews.",
    });
    expect(reviewer.data.model).toBeUndefined();
    expect(reviewer.data["thinking-level"]).toBeUndefined();
    expect(reviewer.body).toContain("# Reviewer");
    expect(await pathExists(".roadmaps/config.yml")).toBe(true);
  });

  test("preserves existing config and overwrites rendered agents on rerun", async () => {
    await writeFile(
      ".roadmaps/config.yml",
      "agents:\n  worker:\n    model: pi/task\n    thinking: medium\n  reviewer: {}\n",
    );
    await writeFile(".omp/agents/worker.md", "stale worker\n");
    await writeFile(".omp/agents/reviewer.md", "stale reviewer\n");

    const result = await initProject(cwd);

    expect(result.createdConfig).toBe(false);
    expect(await readFile(".roadmaps/config.yml")).toBe(
      "agents:\n  worker:\n    model: pi/task\n    thinking: medium\n  reviewer: {}\n",
    );

    const worker = parseMarkdownDocument(await readFile(".omp/agents/worker.md"));
    expect(worker.data.model).toBe("pi/task");
    expect(worker.data["thinking-level"]).toBe("medium");
    expect(worker.body).toContain("Execute only your assigned task");

    const reviewer = parseMarkdownDocument(await readFile(".omp/agents/reviewer.md"));
    expect(reviewer.data.model).toBeUndefined();
    expect(reviewer.data["thinking-level"]).toBeUndefined();
    expect(reviewer.body).toContain("Review implementation against the approved plan");
  });

  test("renders configured worker and reviewer model and thinking", async () => {
    await writeFile(
      ".roadmaps/config.yml",
      [
        "agents:",
        "  worker:",
        "    model: pi/task",
        "    thinking: low",
        "  reviewer:",
        "    model: anthropic/claude-sonnet",
        "    thinking: high",
        "",
      ].join("\n"),
    );

    await initProject(cwd);

    const worker = parseMarkdownDocument(await readFile(".omp/agents/worker.md"));
    expect(worker.data.model).toBe("pi/task");
    expect(worker.data["thinking-level"]).toBe("low");

    const reviewer = parseMarkdownDocument(await readFile(".omp/agents/reviewer.md"));
    expect(reviewer.data.model).toBe("anthropic/claude-sonnet");
    expect(reviewer.data["thinking-level"]).toBe("high");
  });

  test("ignores legacy .roadmap config", async () => {
    await writeFile(
      ".roadmap/config.yml",
      "agents:\n  worker:\n    model: legacy/model\n    thinking: high\n  reviewer: {}\n",
    );

    const result = await initProject(cwd);

    expect(result.createdConfig).toBe(true);
    expect(parseYaml<Record<string, unknown>>(await readFile(".roadmaps/config.yml"))).toEqual({
      agents: { worker: {}, reviewer: {} },
    });

    const worker = parseMarkdownDocument(await readFile(".omp/agents/worker.md"));
    expect(worker.data.model).toBeUndefined();
    expect(worker.data["thinking-level"]).toBeUndefined();
  });

  test("rejects invalid config before overwriting agent files", async () => {
    await writeFile(".omp/agents/worker.md", "existing worker\n");
    await writeFile(".omp/agents/reviewer.md", "existing reviewer\n");

    const invalidConfigs = [
      {
        name: "invalid thinking",
        text: "agents:\n  worker:\n    thinking: auto\n  reviewer: {}\n",
        message: "agents.worker.thinking",
      },
      {
        name: "non-string model",
        text: "agents:\n  worker:\n    model: 123\n  reviewer: {}\n",
        message: "agents.worker.model",
      },
      {
        name: "malformed role",
        text: "agents:\n  worker: yes\n  reviewer: {}\n",
        message: "agents.worker must be an object",
      },
      {
        name: "unknown top-level key",
        text: "agents:\n  worker: {}\n  reviewer: {}\nextra: true\n",
        message: "config contains unsupported key: extra",
      },
      {
        name: "unknown role key",
        text: "agents:\n  worker: {}\n  reviewer: {}\n  planner: {}\n",
        message: "agents contains unsupported key: planner",
      },
      {
        name: "unknown role field",
        text: "agents:\n  worker:\n    temperature: 1\n  reviewer: {}\n",
        message: "agents.worker contains unsupported key: temperature",
      },
    ];

    for (const invalid of invalidConfigs) {
      await writeFile(".roadmaps/config.yml", invalid.text);
      await expect(initProject(cwd), invalid.name).rejects.toThrow(invalid.message);
      expect(await readFile(".omp/agents/worker.md")).toBe("existing worker\n");
      expect(await readFile(".omp/agents/reviewer.md")).toBe("existing reviewer\n");
    }
  });
});
