import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fileExists, readText, readYamlFile, writeText, writeYamlFile } from "./files";
import { parseMarkdownDocument, serializeMarkdownDocument } from "./frontmatter";
import { withStoreWriteLock } from "./lock";
import { roadmapsDir } from "./paths";

const CONFIG_FILE = "config.yml";
const OMP_AGENTS_DIR = path.join(".omp", "agents");
const ROLE_NAMES = ["worker-light", "worker", "worker-heavy", "reviewer", "wave-flow-checker"] as const;
const THINKING_LEVELS = new Set(["inherit", "off", "minimal", "low", "medium", "high", "xhigh"]);

type AgentRole = (typeof ROLE_NAMES)[number];

interface AgentConfig {
  model?: string;
  thinking?: string;
}

interface RoadmapProjectConfig {
  agents: Record<AgentRole, AgentConfig>;
}

export interface ProjectInitResult {
  configPath: string;
  agentPaths: Record<AgentRole, string>;
  createdConfig: boolean;
}

function configPath(cwd: string): string {
  return path.join(roadmapsDir(cwd), CONFIG_FILE);
}

function agentsDir(cwd: string): string {
  return path.join(cwd, OMP_AGENTS_DIR);
}

function agentPath(cwd: string, role: AgentRole): string {
  return path.join(agentsDir(cwd), `${role}.md`);
}

function skillPath(role: AgentRole): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "skills", role, "SKILL.md");
}

function objectKeys(value: object): string[] {
  return Object.keys(value).sort((a, b) => a.localeCompare(b));
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = objectKeys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function parseRoleConfig(value: unknown, role: AgentRole): AgentConfig {
  const roleConfig = requirePlainObject(value, `agents.${role}`);
  rejectUnknownKeys(roleConfig, ["model", "thinking"], `agents.${role}`);

  const config: AgentConfig = {};
  if (roleConfig.model !== undefined) {
    if (typeof roleConfig.model !== "string" || roleConfig.model.trim() === "") {
      throw new Error(`agents.${role}.model must be a non-empty string`);
    }
    config.model = roleConfig.model.trim();
  }

  if (roleConfig.thinking !== undefined) {
    if (typeof roleConfig.thinking !== "string" || !THINKING_LEVELS.has(roleConfig.thinking)) {
      throw new Error(
        `agents.${role}.thinking must be one of: ${Array.from(THINKING_LEVELS).join(", ")}`,
      );
    }
    config.thinking = roleConfig.thinking;
  }

  return config;
}

function parseConfig(raw: unknown): RoadmapProjectConfig {
  const root = requirePlainObject(raw, "config");
  rejectUnknownKeys(root, ["agents"], "config");

  const agents = requirePlainObject(root.agents, "agents");
  rejectUnknownKeys(agents, ROLE_NAMES, "agents");

  return {
    agents: Object.fromEntries(
      ROLE_NAMES.map((role) => [role, parseRoleConfig(agents[role], role)]),
    ) as Record<AgentRole, AgentConfig>,
  };
}

async function loadConfig(cwd: string): Promise<RoadmapProjectConfig> {
  return parseConfig(await readYamlFile(configPath(cwd)));
}

function defaultConfig(): RoadmapProjectConfig {
  return {
    agents: Object.fromEntries(ROLE_NAMES.map((role) => [role, {}])) as Record<AgentRole, AgentConfig>,
  };
}

async function ensureConfig(cwd: string): Promise<boolean> {
  const targetConfigPath = configPath(cwd);
  const createdConfig = !(await fileExists(targetConfigPath));
  if (createdConfig) {
    await writeYamlFile(targetConfigPath, defaultConfig());
    return true;
  }

  const raw = await readYamlFile<unknown>(targetConfigPath);
  const root = requirePlainObject(raw, "config");
  rejectUnknownKeys(root, ["agents"], "config");
  const agents = requirePlainObject(root.agents, "agents");
  rejectUnknownKeys(agents, ROLE_NAMES, "agents");

  let changed = false;
  const expandedAgents: Record<string, unknown> = { ...agents };
  for (const role of ROLE_NAMES) {
    if (expandedAgents[role] === undefined) {
      expandedAgents[role] = {};
      changed = true;
    }
  }

  const expanded = { agents: expandedAgents };
  parseConfig(expanded);
  if (changed) await writeYamlFile(targetConfigPath, expanded);
  return false;
}

async function loadSkill(role: AgentRole): Promise<{ description: string; body: string }> {
  const doc = parseMarkdownDocument<{ name: string; description: string }>(await readText(skillPath(role)));
  if (doc.data.name !== role) {
    throw new Error(`Expected ${role} skill, found ${doc.data.name}`);
  }
  if (!doc.data.description) {
    throw new Error(`${role} skill is missing a description`);
  }
  return { description: doc.data.description, body: doc.body };
}

function renderAgent(role: AgentRole, description: string, body: string, config: AgentConfig): string {
  const frontmatter: Record<string, unknown> = {
    name: role,
    description,
  };
  if (config.model) frontmatter.model = config.model;
  if (config.thinking) frontmatter["thinking-level"] = config.thinking;
  return serializeMarkdownDocument(frontmatter, body);
}

export async function initProject(cwd: string): Promise<ProjectInitResult> {
  return await withStoreWriteLock(cwd, async () => {
  const targetConfigPath = configPath(cwd);
  const createdConfig = await ensureConfig(cwd);

  const config = await loadConfig(cwd);
  const skills = Object.fromEntries(
    await Promise.all(ROLE_NAMES.map(async (role) => [role, await loadSkill(role)])),
  ) as Record<AgentRole, { description: string; body: string }>;

  const targetAgentsDir = agentsDir(cwd);
  await fs.mkdir(targetAgentsDir, { recursive: true });

  const targetAgentPaths = Object.fromEntries(
    ROLE_NAMES.map((role) => [role, agentPath(cwd, role)]),
  ) as Record<AgentRole, string>;

  for (const role of ROLE_NAMES) {
    await writeText(
      targetAgentPaths[role],
      renderAgent(role, skills[role].description, skills[role].body, config.agents[role]),
    );
  }

  return {
    configPath: targetConfigPath,
    agentPaths: targetAgentPaths,
    createdConfig,
  };
  });
}
