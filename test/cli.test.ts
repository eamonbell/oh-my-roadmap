import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initScoped, globalAgentsDir } from "oh-my-roadmap-core/project-init";
import { parseMarkdownDocument, parseYaml } from "oh-my-roadmap-core/frontmatter";
import {
  EXTENSION_PACKAGE,
  installExtension,
  resolvePluginRoot,
  writePluginDependency,
} from "oh-my-roadmap-core/cli/install";
import {
  applyUpdates,
  checkForUpdates,
  compareVersions,
  shouldCheck,
} from "oh-my-roadmap-core/cli/update";

let cwd = "";
let home = "";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omr-cli-cwd-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "omr-cli-home-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readText(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("scoped init", () => {
  test("project init writes prompted models and local agents", async () => {
    const result = await initScoped({
      scope: "project",
      cwd,
      agents: {
        "worker-light": {},
        worker: { model: "pi/task", thinking: "medium" },
        "worker-heavy": {},
        reviewer: {},
        "wave-flow-checker": {},
        "roadmap-milestone-checker": {},
      },
      homeDir: home,
    });

    expect(result.configPath).toBe(path.join(cwd, ".omr", "config.yml"));
    const config = parseYaml<Record<string, any>>(await readText(path.join(cwd, ".omr", "config.yml")));
    expect(config.agents.worker).toEqual({ model: "pi/task", thinking: "medium" });

    const worker = parseMarkdownDocument(await readText(path.join(cwd, ".omp", "agents", "worker.md")));
    expect(worker.data.model).toBe("pi/task");
    expect(worker.data["thinking-level"]).toBe("medium");
  });

  test("global init writes global config + agents and scaffolds a model-free project config", async () => {
    const result = await initScoped({
      scope: "global",
      cwd,
      agents: {
        "worker-light": {},
        worker: { model: "global/worker" },
        "worker-heavy": {},
        reviewer: { model: "global/reviewer", thinking: "high" },
        "wave-flow-checker": {},
        "roadmap-milestone-checker": {},
      },
      homeDir: home,
    });

    // Global config carries the models.
    expect(result.configPath).toBe(path.join(home, ".omp", "oh-my-roadmap", "config.yml"));
    const globalConfig = parseYaml<Record<string, any>>(await readText(result.configPath));
    expect(globalConfig.agents.worker.model).toBe("global/worker");

    // Global agents land where OMP discovers user agents.
    const reviewer = parseMarkdownDocument(
      await readText(path.join(globalAgentsDir(home), "reviewer.md")),
    );
    expect(reviewer.data.model).toBe("global/reviewer");
    expect(reviewer.data["thinking-level"]).toBe("high");

    // A model-free project config is scaffolded in cwd.
    expect(await exists(path.join(cwd, ".omr", "config.yml"))).toBe(true);
    const projectConfig = parseYaml<Record<string, any>>(await readText(path.join(cwd, ".omr", "config.yml")));
    expect(projectConfig.agents.worker).toEqual({});
  });
});

describe("plugin install", () => {
  test("resolvePluginRoot maps scope to OMP plugin roots", () => {
    expect(resolvePluginRoot("project", { cwd })).toBe(path.join(cwd, ".omp", "plugins"));
    expect(resolvePluginRoot("global", { cwd, homeDir: home })).toBe(
      path.join(home, ".omp", "agent", "plugins"),
    );
  });

  test("writePluginDependency creates and merges the plugin package.json", async () => {
    const root = path.join(cwd, ".omp", "plugins");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "omp-plugins", private: true, dependencies: { other: "^1.0.0" } }),
    );

    await writePluginDependency(root, "^0.9.0");

    const pkg = await readJson(path.join(root, "package.json"));
    expect(pkg.dependencies).toEqual({ other: "^1.0.0", [EXTENSION_PACKAGE]: "^0.9.0" });
  });

  test("installExtension writes the dependency and invokes the runner", async () => {
    const invoked: string[] = [];
    const result = await installExtension({
      scope: "project",
      cwd,
      spec: "latest",
      runner: async (root) => {
        invoked.push(root);
      },
    });

    expect(result.root).toBe(path.join(cwd, ".omp", "plugins"));
    expect(invoked).toEqual([result.root]);
    const pkg = await readJson(path.join(result.root, "package.json"));
    expect(pkg.dependencies[EXTENSION_PACKAGE]).toBe("latest");
  });
});

describe("update checks", () => {
  test("compareVersions orders semver-ish strings", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.9.0")).toBe(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(0);
  });

  test("shouldCheck honors the throttle interval", () => {
    const interval = 1000;
    expect(shouldCheck(0, 500, interval)).toBe(false);
    expect(shouldCheck(0, 1500, interval)).toBe(true);
  });

  test("checkForUpdates flags packages with newer versions", async () => {
    const latest: Record<string, string> = {
      "@oh-my-roadmap/cli": "0.10.0",
      "oh-my-roadmap": "0.9.0",
    };
    const check = await checkForUpdates({ cli: "0.9.0", extension: "0.9.0" }, async (name) => latest[name]!);

    expect(check.hasUpdate).toBe(true);
    const cli = check.packages.find((p) => p.name === "@oh-my-roadmap/cli");
    const ext = check.packages.find((p) => p.name === "oh-my-roadmap");
    expect(cli?.hasUpdate).toBe(true);
    expect(ext?.hasUpdate).toBe(false);
  });

  test("applyUpdates only runs for packages with updates", async () => {
    const check = await checkForUpdates({ cli: "0.9.0", extension: "0.9.0" }, async (name) =>
      name === "@oh-my-roadmap/cli" ? "1.0.0" : "0.9.0",
    );
    const ran: string[] = [];
    const updated = await applyUpdates(check, async (name) => {
      ran.push(name);
    });

    expect(updated).toEqual(["@oh-my-roadmap/cli"]);
    expect(ran).toEqual(["@oh-my-roadmap/cli"]);
  });
});
