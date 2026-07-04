import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initProject, loadMergedConfig } from "@oh-my-roadmap/core/project-init";
import { parseMarkdownDocument, parseYaml } from "@oh-my-roadmap/core/frontmatter";

let cwd = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oh-my-roadmap-init-"));
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
  // R13: style guide is reachable before editing.
  expect(body).toContain(
    "Before editing files, call `omr_style_guide` with the files you will edit",
  );
  // Workers must not run builds or tests — that is the reviewer's job.
  expect(body).toContain(
    "Do not run builds, compilers, test suites, or the assigned verification commands",
  );
  expectNoAskToolDirective(body);
}

describe("project init scaffold", () => {
  test("creates default config and local generated agents", async () => {
    const result = await initProject(cwd);

    expect(result.createdConfig).toBe(true);
    expect(parseYaml<Record<string, unknown>>(await readFile(".omr/config.yml"))).toEqual({
      agents: {
        "worker-light": {},
        worker: {},
        "worker-heavy": {},
        reviewer: {},
        "wave-flow-checker": {},
        "roadmap-milestone-checker": {},
        "style-scout": {},
      },
      orchestration: { transport_resume_attempts: 3 },
    });

    const workerLight = parseMarkdownDocument(await readFile(".omp/agents/worker-light.md"));
    expect(workerLight.data).toMatchObject({
      name: "worker-light",
      description: "Use for scoped oh-my-roadmap implementation tasks assigned by an implementation orchestrator.",
    });
    expect(workerLight.body).toContain("# Worker");
    expectWorkerDirectives(workerLight.body);

    const worker = parseMarkdownDocument(await readFile(".omp/agents/worker.md"));
    expect(worker.data).toMatchObject({
      name: "worker",
      description: "Use for scoped oh-my-roadmap implementation tasks assigned by an implementation orchestrator.",
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
      description: "Use for oh-my-roadmap per-wave and closeout reviews.",
    });
    expect(reviewer.data.model).toBeUndefined();
    expect(reviewer.data["thinking-level"]).toBeUndefined();
    expect(reviewer.body).toContain("# Reviewer");
    expect(reviewer.body).toContain("append a blocking review note");
    expect(reviewer.body).toContain("Do not request user input directly");
    // R13: reviewer reaches omr_style_guide before throwaway verification code or code-level repros.
    expect(reviewer.body).toContain(
      "Before creating throwaway verification code or code-level repros, call `omr_style_guide`",
    );
    // Reviewer owns build/test execution for the wave; workers do not run them.
    expect(reviewer.body).toContain(
      "You own running the wave's build, tests, and verification commands",
    );
    expectNoAskToolDirective(reviewer.body);

    const checker = parseMarkdownDocument(await readFile(".omp/agents/wave-flow-checker.md"));
    expect(checker.data.name).toBe("wave-flow-checker");
    expect(checker.body).toContain("# Wave Flow Checker");
    expect(checker.body).toContain("Do not request user input directly");
    expect(checker.body).toContain("report `failed` with concrete findings");
    expectNoAskToolDirective(checker.body);

    const roadmapChecker = parseMarkdownDocument(await readFile(".omp/agents/roadmap-milestone-checker.md"));
    expect(roadmapChecker.data.name).toBe("roadmap-milestone-checker");
    expect(roadmapChecker.body).toContain("# Roadmap Milestone Checker");
    expect(roadmapChecker.body).toContain("Do not request user input directly");
    expect(roadmapChecker.body).toContain("Report either passed");
    expectNoAskToolDirective(roadmapChecker.body);
    expect(await pathExists(".omr/config.yml")).toBe(true);
  });

  test("preserves existing config and overwrites rendered agents on rerun", async () => {
    await writeFile(
      ".omr/config.yml",
      "agents:\n  worker:\n    model: pi/task\n    thinking: medium\n  reviewer: {}\n",
    );
    await writeFile(".omp/agents/worker.md", "stale worker\n");
    await writeFile(".omp/agents/reviewer.md", "stale reviewer\n");

    const result = await initProject(cwd);

    expect(result.createdConfig).toBe(false);
    expect(parseYaml<Record<string, unknown>>(await readFile(".omr/config.yml"))).toEqual({
      agents: {
        "worker-light": {},
        worker: { model: "pi/task", thinking: "medium" },
        "worker-heavy": {},
        reviewer: {},
        "wave-flow-checker": {},
        "roadmap-milestone-checker": {},
        "style-scout": {},
      },
      orchestration: { transport_resume_attempts: 3 },
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

    const roadmapChecker = parseMarkdownDocument(await readFile(".omp/agents/roadmap-milestone-checker.md"));
    expect(roadmapChecker.body).toContain("Start with omr_read_state scope roadmap_checker_package");
    expectNoAskToolDirective(roadmapChecker.body);
  });

  test("preserves a configured transport_resume_attempts on rerun", async () => {
    await writeFile(
      ".omr/config.yml",
      "agents:\n  worker: {}\n  reviewer: {}\norchestration:\n  transport_resume_attempts: 5\n",
    );

    await initProject(cwd);

    expect(parseYaml<Record<string, any>>(await readFile(".omr/config.yml")).orchestration).toEqual({
      transport_resume_attempts: 5,
    });
  });

  test("renders configured model and thinking for all generated agents", async () => {
    await writeFile(
      ".omr/config.yml",
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
        "  roadmap-milestone-checker:",
        "    model: pi/roadmap-checker",
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

    const roadmapChecker = parseMarkdownDocument(await readFile(".omp/agents/roadmap-milestone-checker.md"));
    expect(roadmapChecker.data.model).toBe("pi/roadmap-checker");
    expect(roadmapChecker.data["thinking-level"]).toBe("medium");
  });

  test("ignores legacy .roadmap config", async () => {
    await writeFile(
      ".roadmap/config.yml",
      "agents:\n  worker:\n    model: legacy/model\n    thinking: high\n  reviewer: {}\n",
    );

    const result = await initProject(cwd);

    expect(result.createdConfig).toBe(true);
    expect(parseYaml<Record<string, unknown>>(await readFile(".omr/config.yml"))).toEqual({
      agents: {
        "worker-light": {},
        worker: {},
        "worker-heavy": {},
        reviewer: {},
        "wave-flow-checker": {},
        "roadmap-milestone-checker": {},
        "style-scout": {},
      },
      orchestration: { transport_resume_attempts: 3 },
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
      {
        name: "non-positive resume attempts",
        text: "agents:\n  worker: {}\n  reviewer: {}\norchestration:\n  transport_resume_attempts: 0\n",
        message: "orchestration.transport_resume_attempts must be a positive integer",
      },
      {
        name: "unknown orchestration key",
        text: "agents:\n  worker: {}\n  reviewer: {}\norchestration:\n  foo: 1\n",
        message: "orchestration contains unsupported key: foo",
      },
    ];

    for (const invalid of invalidConfigs) {
      await writeFile(".omr/config.yml", invalid.text);
      await expect(initProject(cwd), invalid.name).rejects.toThrow(invalid.message);
      expect(await readFile(".omp/agents/worker.md")).toBe("existing worker\n");
      expect(await readFile(".omp/agents/reviewer.md")).toBe("existing reviewer\n");
    }
  });

  test("preserves disabled flag and style guidance on rerun", async () => {
    await writeFile(
      ".omr/config.yml",
      [
        "agents:",
        "  worker: {}",
        "  reviewer: {}",
        "disabled: true",
        "style:",
        "  typescript:",
        "    summary: Tabs, single quotes.",
        "    guidelines:",
        '      - "Naming: camelCase for functions"',
        '      - "Errors: throw Error subclasses"',
        "",
      ].join("\n"),
    );

    await initProject(cwd);

    const config = parseYaml<Record<string, any>>(await readFile(".omr/config.yml"));
    expect(config.disabled).toBe(true);
    expect(config.style).toEqual({
      typescript: {
        summary: "Tabs, single quotes.",
        guidelines: ["Naming: camelCase for functions", "Errors: throw Error subclasses"],
      },
    });
  });

  test("rejects invalid disabled and style values", async () => {
    const invalidConfigs = [
      {
        name: "non-boolean disabled",
        text: "agents:\n  worker: {}\n  reviewer: {}\ndisabled: nope\n",
        message: "disabled must be a boolean",
      },
      {
        name: "non-string style summary",
        text: "agents:\n  worker: {}\n  reviewer: {}\nstyle:\n  go:\n    summary: 1\n",
        message: "style.go.summary must be a string",
      },
      {
        name: "unknown style key",
        text: "agents:\n  worker: {}\n  reviewer: {}\nstyle:\n  go:\n    extra: 1\n",
        message: "style.go contains unsupported key: extra",
      },
    ];

    for (const invalid of invalidConfigs) {
      await writeFile(".omr/config.yml", invalid.text);
      await expect(initProject(cwd), invalid.name).rejects.toThrow(invalid.message);
    }
  });

  test("does not scaffold moshi into a new config", async () => {
    await initProject(cwd);
    const config = parseYaml<Record<string, unknown>>(await readFile(".omr/config.yml"));
    expect(config).not.toHaveProperty("moshi");
  });

  test("preserves configured moshi on rerun", async () => {
    await writeFile(
      ".omr/config.yml",
      [
        "agents:",
        "  worker: {}",
        "  reviewer: {}",
        "moshi:",
        "  enabled: true",
        "  socket_path: /tmp/moshi.sock",
        "",
      ].join("\n"),
    );

    await initProject(cwd);

    const config = parseYaml<Record<string, any>>(await readFile(".omr/config.yml"));
    expect(config.moshi).toEqual({ enabled: true, socket_path: "/tmp/moshi.sock" });
  });

  test("rejects invalid moshi values", async () => {
    const invalidConfigs = [
      {
        name: "non-object moshi",
        text: "agents:\n  worker: {}\n  reviewer: {}\nmoshi: true\n",
        message: "moshi must be an object",
      },
      {
        name: "non-boolean enabled",
        text: "agents:\n  worker: {}\n  reviewer: {}\nmoshi:\n  enabled: yes\n",
        message: "moshi.enabled must be a boolean",
      },
      {
        name: "empty socket_path",
        text: 'agents:\n  worker: {}\n  reviewer: {}\nmoshi:\n  socket_path: ""\n',
        message: "moshi.socket_path must be a non-empty string",
      },
      {
        name: "unknown moshi key",
        text: "agents:\n  worker: {}\n  reviewer: {}\nmoshi:\n  extra: true\n",
        message: "moshi contains unsupported key: extra",
      },
    ];

    for (const invalid of invalidConfigs) {
      await writeFile(".omr/config.yml", invalid.text);
      await expect(initProject(cwd), invalid.name).rejects.toThrow(invalid.message);
    }
  });
});

describe("merged global + project config", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oh-my-roadmap-home-"));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  async function writeGlobal(text: string): Promise<void> {
    const filePath = path.join(home, ".omp", "oh-my-roadmap", "config.yml");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text, "utf8");
  }

  test("project values override global per role, style, and disabled", async () => {
    await writeGlobal(
      [
        "agents:",
        "  worker:",
        "    model: global/worker",
        "    thinking: high",
        "  reviewer:",
        "    model: global/reviewer",
        "disabled: false",
        "style:",
        "  go:",
        "    guidelines: [tabs]",
        "  typescript:",
        "    guidelines: [global-ts]",
        "",
      ].join("\n"),
    );
    await writeFile(
      ".omr/config.yml",
      [
        "agents:",
        "  worker:",
        "    model: project/worker",
        "  reviewer: {}",
        "disabled: true",
        "style:",
        "  typescript:",
        "    guidelines: [project-ts]",
        "",
      ].join("\n"),
    );

    const merged = await loadMergedConfig(cwd, home);

    // Project model wins; global reviewer model survives where project is empty.
    expect(merged.agents.worker.model).toBe("project/worker");
    expect(merged.agents.reviewer.model).toBe("global/reviewer");
    // Project disabled wins.
    expect(merged.disabled).toBe(true);
    // Style merges per-language, project winning on collisions.
    expect(merged.style).toEqual({
      go: { guidelines: ["tabs"] },
      typescript: { guidelines: ["project-ts"] },
    });
  });

  test("falls back to global when project config is absent", async () => {
    await writeGlobal("agents:\n  worker:\n    model: global/only\n  reviewer: {}\ndisabled: true\n");

    const merged = await loadMergedConfig(cwd, home);

    expect(merged.agents.worker.model).toBe("global/only");
    expect(merged.disabled).toBe(true);
  });

  test("falls back to project when no global config exists", async () => {
    await writeFile(".omr/config.yml", "agents:\n  worker:\n    model: project/only\n  reviewer: {}\n");

    const merged = await loadMergedConfig(cwd, home);

    expect(merged.agents.worker.model).toBe("project/only");
    expect(merged.disabled).toBeUndefined();
  });

  test("shallow-merges moshi so project overrides only socket_path", async () => {
    await writeGlobal(
      "agents:\n  worker: {}\n  reviewer: {}\nmoshi:\n  enabled: true\n  socket_path: /tmp/global.sock\n",
    );
    await writeFile(
      ".omr/config.yml",
      "agents:\n  worker: {}\n  reviewer: {}\nmoshi:\n  socket_path: /tmp/project.sock\n",
    );

    const merged = await loadMergedConfig(cwd, home);

    // Global enables Moshi; project overrides only the socket path.
    expect(merged.moshi).toEqual({ enabled: true, socket_path: "/tmp/project.sock" });
  });

  test("project can disable a profile-global moshi opt-in", async () => {
    await writeGlobal(
      "agents:\n  worker: {}\n  reviewer: {}\nmoshi:\n  enabled: true\n  socket_path: /tmp/global.sock\n",
    );
    await writeFile(".omr/config.yml", "agents:\n  worker: {}\n  reviewer: {}\nmoshi:\n  enabled: false\n");

    const merged = await loadMergedConfig(cwd, home);

    expect(merged.moshi?.enabled).toBe(false);
    // The global socket_path survives where the project does not override it.
    expect(merged.moshi?.socket_path).toBe("/tmp/global.sock");
  });
});
