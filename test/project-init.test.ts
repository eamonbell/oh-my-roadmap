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

function expectNoAskToolDirective(body: string): void {
  expect(body).not.toContain("built-in `ask`");
  expect(body).not.toContain("ask tool");
  expect(body).not.toContain("use the built-in `ask`");
}

function expectWorkerDirectives(body: string): void {
  expect(body).toContain("full access to the tools");
  expect(body).toContain("Maintain hyperfocus on the assigned task");
  expect(body).toContain("Prefer narrow lookups before reading files");
  expect(body).toContain("Do not create documentation files unless the assignment explicitly asks for them");
  expect(body).toContain("append a blocking note");
  expect(body).toContain("yield/report blocked status to the orchestrator");
  expectNoAskToolDirective(body);
}

describe("project init scaffold", () => {
  test("creates default config and local generated agents", async () => {
    const result = await initProject(cwd);

    expect(result.createdConfig).toBe(true);
    expect(parseYaml<Record<string, unknown>>(await readFile(".roadmaps/config.yml"))).toEqual({
      agents: {
        "worker-light": {},
        worker: {},
        "worker-heavy": {},
        reviewer: {},
        "wave-flow-checker": {},
      },
    });

    const workerLight = parseMarkdownDocument(await readFile(".omp/agents/worker-light.md"));
    expect(workerLight.data).toMatchObject({
      name: "worker-light",
      description: "Use for scoped roadmap-engineer implementation tasks assigned by an implementation orchestrator.",
    });
    expect(workerLight.body).toContain("# Worker");
    expectWorkerDirectives(workerLight.body);

    const worker = parseMarkdownDocument(await readFile(".omp/agents/worker.md"));
    expect(worker.data).toMatchObject({
      name: "worker",
      description: "Use for scoped roadmap-engineer implementation tasks assigned by an implementation orchestrator.",
    });
    expect(worker.data.model).toBeUndefined();
    expect(worker.data["thinking-level"]).toBeUndefined();
    expect(worker.body).toContain("# Worker");
    expectWorkerDirectives(worker.body);

    const workerHeavy = parseMarkdownDocument(await readFile(".omp/agents/worker-heavy.md"));
    expect(workerHeavy.data.name).toBe("worker-heavy");
    expect(workerHeavy.body).toContain("Execute only your assigned task");
    expectWorkerDirectives(workerHeavy.body);

    const reviewer = parseMarkdownDocument(await readFile(".omp/agents/reviewer.md"));
    expect(reviewer.data).toMatchObject({
      name: "reviewer",
      description: "Use for roadmap-engineer per-wave and closeout reviews.",
    });
    expect(reviewer.data.model).toBeUndefined();
    expect(reviewer.data["thinking-level"]).toBeUndefined();
    expect(reviewer.body).toContain("# Reviewer");
    expect(reviewer.body).toContain("append a blocking review note");
    expect(reviewer.body).toContain("Do not request user input directly");
    expectNoAskToolDirective(reviewer.body);

    const checker = parseMarkdownDocument(await readFile(".omp/agents/wave-flow-checker.md"));
    expect(checker.data.name).toBe("wave-flow-checker");
    expect(checker.body).toContain("# Wave Flow Checker");
    expect(checker.body).toContain("Do not request user input directly");
    expect(checker.body).toContain("report `failed` with concrete findings");
    expectNoAskToolDirective(checker.body);
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
    expect(parseYaml<Record<string, unknown>>(await readFile(".roadmaps/config.yml"))).toEqual({
      agents: {
        "worker-light": {},
        worker: { model: "pi/task", thinking: "medium" },
        "worker-heavy": {},
        reviewer: {},
        "wave-flow-checker": {},
      },
    });

    const worker = parseMarkdownDocument(await readFile(".omp/agents/worker.md"));
    expect(worker.data.model).toBe("pi/task");
    expect(worker.data["thinking-level"]).toBe("medium");
    expect(worker.body).toContain("Execute only your assigned task");
    expectWorkerDirectives(worker.body);

    const reviewer = parseMarkdownDocument(await readFile(".omp/agents/reviewer.md"));
    expect(reviewer.data.model).toBeUndefined();
    expect(reviewer.data["thinking-level"]).toBeUndefined();
    expect(reviewer.body).toContain("Review implementation against the approved plan");
    expect(reviewer.body).toContain("append a blocking review note");
    expectNoAskToolDirective(reviewer.body);

    const checker = parseMarkdownDocument(await readFile(".omp/agents/wave-flow-checker.md"));
    expect(checker.body).toContain("flow contradictions");
    expectNoAskToolDirective(checker.body);
  });

  test("renders configured model and thinking for all generated agents", async () => {
    await writeFile(
      ".roadmaps/config.yml",
      [
        "agents:",
        "  worker-light:",
        "    model: pi/light",
        "    thinking: minimal",
        "  worker:",
        "    model: pi/task",
        "    thinking: low",
        "  worker-heavy:",
        "    model: pi/heavy",
        "    thinking: xhigh",
        "  reviewer:",
        "    model: anthropic/claude-sonnet",
        "    thinking: high",
        "  wave-flow-checker:",
        "    model: pi/checker",
        "    thinking: medium",
        "",
      ].join("\n"),
    );

    await initProject(cwd);

    const workerLight = parseMarkdownDocument(await readFile(".omp/agents/worker-light.md"));
    expect(workerLight.data.model).toBe("pi/light");
    expect(workerLight.data["thinking-level"]).toBe("minimal");

    const worker = parseMarkdownDocument(await readFile(".omp/agents/worker.md"));
    expect(worker.data.model).toBe("pi/task");
    expect(worker.data["thinking-level"]).toBe("low");

    const workerHeavy = parseMarkdownDocument(await readFile(".omp/agents/worker-heavy.md"));
    expect(workerHeavy.data.model).toBe("pi/heavy");
    expect(workerHeavy.data["thinking-level"]).toBe("xhigh");

    const reviewer = parseMarkdownDocument(await readFile(".omp/agents/reviewer.md"));
    expect(reviewer.data.model).toBe("anthropic/claude-sonnet");
    expect(reviewer.data["thinking-level"]).toBe("high");

    const checker = parseMarkdownDocument(await readFile(".omp/agents/wave-flow-checker.md"));
    expect(checker.data.model).toBe("pi/checker");
    expect(checker.data["thinking-level"]).toBe("medium");
  });

  test("ignores legacy .roadmap config", async () => {
    await writeFile(
      ".roadmap/config.yml",
      "agents:\n  worker:\n    model: legacy/model\n    thinking: high\n  reviewer: {}\n",
    );

    const result = await initProject(cwd);

    expect(result.createdConfig).toBe(true);
    expect(parseYaml<Record<string, unknown>>(await readFile(".roadmaps/config.yml"))).toEqual({
      agents: {
        "worker-light": {},
        worker: {},
        "worker-heavy": {},
        reviewer: {},
        "wave-flow-checker": {},
      },
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
