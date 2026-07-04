import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  activeProfileFromEnv,
  ompAgentsDir,
  ompOmrConfigDir,
  ompPluginRoot,
  resolveOmpRoot,
  resolveScopeAndProfile,
  validateProfileName,
} from "@oh-my-roadmap/core/omp-paths";
import {
  applyScoped,
  globalAgentsDir,
  homeConfigDir,
  initScoped,
  ROLE_NAMES,
} from "@oh-my-roadmap/core/project-init";
import { installExtension, resolvePluginRoot } from "@oh-my-roadmap/core/cli/install";
import { readInstalledExtensionVersion, updateExtension } from "@oh-my-roadmap/core/cli/update";

// The resolvers read OMP_PROFILE / PI_PROFILE / PI_CONFIG_DIR from the env; snapshot
// and clear them so tests are hermetic and don't leak into other suites.
const PROFILE_ENV = ["OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of PROFILE_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROFILE_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function emptyAgents() {
  return Object.fromEntries(ROLE_NAMES.map((role) => [role, {}])) as Record<
    (typeof ROLE_NAMES)[number],
    Record<string, never>
  >;
}

describe("validateProfileName", () => {
  test("accepts OMP-legal names", () => {
    expect(validateProfileName("work")).toBe("work");
    expect(validateProfileName("a")).toBe("a");
    expect(validateProfileName("a.b-c_d")).toBe("a.b-c_d");
    expect(validateProfileName("  trimmed  ")).toBe("trimmed");
  });

  test("rejects illegal names", () => {
    for (const bad of ["", "default", ".", "..", "work.", "CON", "com1", "Bad Name", "Work", "-lead"]) {
      expect(() => validateProfileName(bad)).toThrow();
    }
  });
});

describe("activeProfileFromEnv", () => {
  test("returns undefined when neither var is set", () => {
    expect(activeProfileFromEnv()).toBeUndefined();
  });

  test("OMP_PROFILE takes precedence over PI_PROFILE", () => {
    process.env.PI_PROFILE = "second";
    process.env.OMP_PROFILE = "first";
    expect(activeProfileFromEnv()).toBe("first");
  });

  test("falls back to PI_PROFILE", () => {
    process.env.PI_PROFILE = "second";
    expect(activeProfileFromEnv()).toBe("second");
  });

  test("throws on a malformed env value", () => {
    process.env.OMP_PROFILE = "Bad Name";
    expect(() => activeProfileFromEnv()).toThrow();
  });
});

describe("root resolution", () => {
  const home = "/home/u";

  test("default root vs profile root", () => {
    expect(resolveOmpRoot({ homeDir: home })).toBe(path.join(home, ".omp"));
    expect(resolveOmpRoot({ homeDir: home, profile: "work" })).toBe(
      path.join(home, ".omp", "profiles", "work"),
    );
  });

  test("plugin/agents/config hang off the root", () => {
    expect(ompPluginRoot({ homeDir: home })).toBe(path.join(home, ".omp", "plugins"));
    expect(ompAgentsDir({ homeDir: home })).toBe(path.join(home, ".omp", "agent", "agents"));
    expect(ompOmrConfigDir({ homeDir: home })).toBe(path.join(home, ".omp", "oh-my-roadmap"));
    expect(ompPluginRoot({ homeDir: home, profile: "work" })).toBe(
      path.join(home, ".omp", "profiles", "work", "plugins"),
    );
  });

  test("PI_CONFIG_DIR overrides the base config dir name", () => {
    process.env.PI_CONFIG_DIR = ".pi";
    expect(resolveOmpRoot({ homeDir: home })).toBe(path.join(home, ".pi"));
  });

  test("globalAgentsDir + homeConfigDir honor the ambient profile", () => {
    process.env.OMP_PROFILE = "work";
    expect(globalAgentsDir(home)).toBe(path.join(home, ".omp", "profiles", "work", "agent", "agents"));
    expect(homeConfigDir(home)).toBe(path.join(home, ".omp", "profiles", "work", "oh-my-roadmap"));
    // An explicit profile overrides the ambient one.
    expect(homeConfigDir(home, "other")).toBe(
      path.join(home, ".omp", "profiles", "other", "oh-my-roadmap"),
    );
  });
});

describe("resolveScopeAndProfile", () => {
  test("defaults to project", () => {
    expect(resolveScopeAndProfile({})).toEqual({ scope: "project", profile: undefined });
  });

  test("--profile implies global and validates", () => {
    expect(resolveScopeAndProfile({ profile: "work" })).toEqual({ scope: "global", profile: "work" });
    expect(() => resolveScopeAndProfile({ profile: "Bad Name" })).toThrow();
  });

  test("--global keeps profile undefined unless given", () => {
    expect(resolveScopeAndProfile({ global: true })).toEqual({ scope: "global", profile: undefined });
    expect(resolveScopeAndProfile({ global: true, profile: "work" })).toEqual({
      scope: "global",
      profile: "work",
    });
  });

  test("rejects conflicting/incoherent flags", () => {
    expect(() => resolveScopeAndProfile({ global: true, project: true })).toThrow();
    expect(() => resolveScopeAndProfile({ project: true, profile: "work" })).toThrow();
  });
});

describe("scoped apply + install with profiles", () => {
  let cwd = "";
  let home = "";

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-paths-cwd-"));
    home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-paths-home-"));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  test("global apply regenerates agents under the profile root", async () => {
    await initScoped({ scope: "global", cwd, agents: emptyAgents(), homeDir: home, profile: "work" });
    const agentsDir = globalAgentsDir(home, "work");
    // Remove a generated agent, then re-apply and confirm it comes back.
    await fs.rm(path.join(agentsDir, "reviewer.md"));
    const result = await applyScoped({ scope: "global", cwd, homeDir: home, profile: "work" });
    expect(result.configPath).toBe(path.join(home, ".omp", "profiles", "work", "oh-my-roadmap", "config.yml"));
    await fs.access(path.join(agentsDir, "reviewer.md"));
  });

  test("global apply without a config errors helpfully", async () => {
    await expect(
      applyScoped({ scope: "global", cwd, homeDir: home, profile: "ghost" }),
    ).rejects.toThrow(/No global config found[\s\S]*omr init --global --profile ghost/);
  });

  test("installExtension writes into the profile plugin root", async () => {
    const invoked: string[] = [];
    const result = await installExtension({
      scope: "global",
      cwd,
      homeDir: home,
      profile: "work",
      runner: async (root) => {
        invoked.push(root);
      },
    });
    const expected = resolvePluginRoot("global", { cwd, homeDir: home, profile: "work" });
    expect(result.root).toBe(expected);
    expect(expected).toBe(path.join(home, ".omp", "profiles", "work", "plugins"));
    expect(invoked).toEqual([expected]);
  });
});

describe("updateExtension", () => {
  let cwd = "";

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-paths-upd-"));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  test("errors when the extension is not installed in the target root", async () => {
    await expect(updateExtension({ scope: "project", cwd })).rejects.toThrow(/not installed/);
  });

  test("re-installs when the extension is already present", async () => {
    // Seed the plugin root with the dependency (runner is a no-op).
    await installExtension({ scope: "project", cwd, runner: async () => {} });
    const root = resolvePluginRoot("project", { cwd });
    expect(await readInstalledExtensionVersion(root)).toBe("latest");

    const invoked: string[] = [];
    await updateExtension({
      scope: "project",
      cwd,
      spec: "1.2.3",
      installer: async (opts) => {
        invoked.push(`${opts.scope}:${opts.spec}`);
        return { scope: opts.scope, root, packageJsonPath: "", spec: opts.spec ?? "" };
      },
    });
    expect(invoked).toEqual(["project:1.2.3"]);
  });
});
