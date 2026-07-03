import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {fileExists, readText, readYamlFile, writeText, writeYamlFile} from './files'
import {parseMarkdownDocument, serializeMarkdownDocument} from './frontmatter'
import {withStoreWriteLock} from './lock'
import {roadmapsDir} from './paths'

const CONFIG_FILE = 'config.yml'
const OMP_AGENTS_DIR = path.join('.omp', 'agents')
export const ROLE_NAMES = ['worker-light', 'worker', 'worker-heavy', 'reviewer', 'wave-flow-checker', 'roadmap-milestone-checker'] as const
export const THINKING_LEVELS = ['inherit', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
const THINKING_LEVELS_SET = new Set<string>(THINKING_LEVELS)
export const DEFAULT_TRANSPORT_RESUME_ATTEMPTS = 3

export type AgentRole = (typeof ROLE_NAMES)[number];

export interface AgentConfig {
	model?: string;
	thinking?: string;
}

export interface OrchestrationConfig {
	transport_resume_attempts: number;
}

// Per-language code-style guidance produced by `omr:learn-style` (or authored by
// hand in the global config). Kept compact so it can be handed to workers cheaply.
export interface StyleGuide {
	summary?: string;
	guidelines: string[];
}

export interface RoadmapProjectConfig {
	agents: Record<AgentRole, AgentConfig>;
	orchestration: OrchestrationConfig;
	// Lockout flag (project scope). When true, omr tools/agents are paused.
	disabled?: boolean;
	// Code-style guidance keyed by language id (e.g. `typescript`, `go`).
	style?: Record<string, StyleGuide>;
}

export interface ProjectInitResult {
	configPath: string;
	agentPaths: Record<AgentRole, string>;
	createdConfig: boolean;
}

function configPath(cwd: string): string {
	return path.join(roadmapsDir(cwd), CONFIG_FILE)
}

function agentsDir(cwd: string): string {
	return path.join(cwd, OMP_AGENTS_DIR)
}

// User-level (global) agents are discovered by OMP at ~/.omp/agent/agents/*.md
// (respecting PI_CONFIG_DIR). Project agents live at <cwd>/.omp/agents/*.md.
export function globalAgentsDir(homeDir: string = os.homedir()): string {
	const configDirName = process.env.PI_CONFIG_DIR || '.omp'
	return path.join(homeDir, configDirName, 'agent', 'agents')
}

// Auxiliary agents generated alongside the configurable worker/reviewer roles. These
// are not model-configurable in config.yml; they inherit OMP's model/reasoning.
export const AUX_AGENT_NAMES = ['style-scout'] as const

function skillPath(name: string): string {
	// `here` is the directory of the running module. Skills ship one level up:
	//  - extension (core loaded as source):   packages/core/src -> ../skills = packages/core/skills
	//  - bundled CLI (dist/index.js):          packages/cli/dist -> ../skills = packages/cli/skills
	const here = path.dirname(fileURLToPath(import.meta.url))
	return path.resolve(here, '..', 'skills', name, 'SKILL.md')
}

function objectKeys(value: object): string[] {
	return Object.keys(value).sort((a, b) => a.localeCompare(b))
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must be an object`)
	}
	return value as Record<string, unknown>
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedSet = new Set(allowed)
	const unknown = objectKeys(value).filter((key) => !allowedSet.has(key))
	if (unknown.length > 0) {
		throw new Error(`${label} contains unsupported key${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
	}
}

function parseRoleConfig(value: unknown, role: AgentRole): AgentConfig {
	// A missing role inherits (no model/thinking) — global/project configs may list only a subset.
	if (value === undefined) return {}
	const roleConfig = requirePlainObject(value, `agents.${role}`)
	rejectUnknownKeys(roleConfig, ['model', 'thinking'], `agents.${role}`)

	const config: AgentConfig = {}
	if (roleConfig.model !== undefined) {
		if (typeof roleConfig.model !== 'string' || roleConfig.model.trim() === '') {
			throw new Error(`agents.${role}.model must be a non-empty string`)
		}
		config.model = roleConfig.model.trim()
	}

	if (roleConfig.thinking !== undefined) {
		if (typeof roleConfig.thinking !== 'string' || !THINKING_LEVELS_SET.has(roleConfig.thinking)) {
			throw new Error(
				`agents.${role}.thinking must be one of: ${THINKING_LEVELS.join(', ')}`,
			)
		}
		config.thinking = roleConfig.thinking
	}

	return config
}

function defaultOrchestrationConfig(): OrchestrationConfig {
	return {transport_resume_attempts: DEFAULT_TRANSPORT_RESUME_ATTEMPTS}
}

function parseOrchestrationConfig(value: unknown): OrchestrationConfig {
	if (value === undefined) return defaultOrchestrationConfig()
	const orchestration = requirePlainObject(value, 'orchestration')
	rejectUnknownKeys(orchestration, ['transport_resume_attempts'], 'orchestration')
	if (orchestration.transport_resume_attempts === undefined) return defaultOrchestrationConfig()

	const attempts = orchestration.transport_resume_attempts
	if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1) {
		throw new Error('orchestration.transport_resume_attempts must be a positive integer')
	}
	return {transport_resume_attempts: attempts}
}

function parseDisabled(value: unknown): boolean | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'boolean') throw new Error('disabled must be a boolean')
	return value
}

function parseStyleGuide(value: unknown, language: string): StyleGuide {
	const guide = requirePlainObject(value, `style.${language}`)
	rejectUnknownKeys(guide, ['summary', 'guidelines'], `style.${language}`)

	const result: StyleGuide = {guidelines: []}
	if (guide.summary !== undefined) {
		if (typeof guide.summary !== 'string') throw new Error(`style.${language}.summary must be a string`)
		result.summary = guide.summary
	}
	if (guide.guidelines !== undefined) {
		if (!Array.isArray(guide.guidelines) || guide.guidelines.some((entry) => typeof entry !== 'string')) {
			throw new Error(`style.${language}.guidelines must be an array of strings`)
		}
		result.guidelines = guide.guidelines as string[]
	}
	return result
}

function parseStyle(value: unknown): Record<string, StyleGuide> | undefined {
	if (value === undefined) return undefined
	const style = requirePlainObject(value, 'style')
	const result: Record<string, StyleGuide> = {}
	for (const language of objectKeys(style)) {
		result[language] = parseStyleGuide(style[language], language)
	}
	return result
}

function parseConfig(raw: unknown): RoadmapProjectConfig {
	const root = requirePlainObject(raw, 'config')
	rejectUnknownKeys(root, ['agents', 'orchestration', 'disabled', 'style'], 'config')

	const agents = requirePlainObject(root.agents, 'agents')
	rejectUnknownKeys(agents, ROLE_NAMES, 'agents')

	const config: RoadmapProjectConfig = {
		agents: Object.fromEntries(
			ROLE_NAMES.map((role) => [role, parseRoleConfig(agents[role], role)]),
		) as Record<AgentRole, AgentConfig>,
		orchestration: parseOrchestrationConfig(root.orchestration),
	}

	const disabled = parseDisabled(root.disabled)
	if (disabled !== undefined) config.disabled = disabled
	const style = parseStyle(root.style)
	if (style !== undefined) config.style = style
	return config
}

export async function loadConfig(cwd: string): Promise<RoadmapProjectConfig> {
	return parseConfig(await readYamlFile(configPath(cwd)))
}

export async function loadTransportResumeAttempts(cwd: string): Promise<number> {
	try {
		if (!(await fileExists(configPath(cwd)))) return DEFAULT_TRANSPORT_RESUME_ATTEMPTS
		return (await loadConfig(cwd)).orchestration.transport_resume_attempts
	} catch {
		return DEFAULT_TRANSPORT_RESUME_ATTEMPTS
	}
}

function defaultConfig(): RoadmapProjectConfig {
	return {
		agents: Object.fromEntries(ROLE_NAMES.map((role) => [role, {}])) as Record<AgentRole, AgentConfig>,
		orchestration: defaultOrchestrationConfig(),
	}
}

export async function ensureConfig(cwd: string): Promise<boolean> {
	const targetConfigPath = configPath(cwd)
	const createdConfig = !(await fileExists(targetConfigPath))
	if (createdConfig) {
		await writeYamlFile(targetConfigPath, defaultConfig())
		return true
	}

	const raw = await readYamlFile<unknown>(targetConfigPath)
	const root = requirePlainObject(raw, 'config')
	rejectUnknownKeys(root, ['agents', 'orchestration', 'disabled', 'style'], 'config')
	const agents = requirePlainObject(root.agents, 'agents')
	rejectUnknownKeys(agents, ROLE_NAMES, 'agents')

	let changed = false
	const expandedAgents: Record<string, unknown> = {...agents}
	for (const role of ROLE_NAMES) {
		if (expandedAgents[role] === undefined) {
			expandedAgents[role] = {}
			changed = true
		}
	}

	const expanded: Record<string, unknown> = {agents: expandedAgents}
	if (root.orchestration !== undefined) {
		expanded.orchestration = root.orchestration
	} else {
		expanded.orchestration = defaultOrchestrationConfig()
		changed = true
	}
	// Preserve optional lockout/style keys unchanged.
	if (root.disabled !== undefined) expanded.disabled = root.disabled
	if (root.style !== undefined) expanded.style = root.style
	parseConfig(expanded)
	if (changed) await writeYamlFile(targetConfigPath, expanded)
	return false
}

export function homeConfigDir(homeDir: string = os.homedir()): string {
	return path.join(homeDir, '.omp', 'oh-my-roadmap')
}

function homeConfigPath(homeDir?: string): string {
	return path.join(homeConfigDir(homeDir), CONFIG_FILE)
}

// Global config lives at ~/.omp/oh-my-roadmap/config.yml. Absent by default.
export async function loadGlobalConfig(homeDir?: string): Promise<RoadmapProjectConfig | undefined> {
	const targetPath = homeConfigPath(homeDir)
	if (!(await fileExists(targetPath))) return undefined
	return parseConfig(await readYamlFile(targetPath))
}

function mergeConfigs(base: RoadmapProjectConfig, override: RoadmapProjectConfig): RoadmapProjectConfig {
	const agents = Object.fromEntries(
		ROLE_NAMES.map((role) => [role, {...base.agents[role], ...override.agents[role]}]),
	) as Record<AgentRole, AgentConfig>

	const merged: RoadmapProjectConfig = {
		agents,
		// Project orchestration wins; both configs always carry a resolved value.
		orchestration: override.orchestration,
	}

	const disabled = override.disabled ?? base.disabled
	if (disabled !== undefined) merged.disabled = disabled

	if (base.style !== undefined || override.style !== undefined) {
		merged.style = {...(base.style ?? {}), ...(override.style ?? {})}
	}
	return merged
}

// Unified config: global (~/.omp/oh-my-roadmap) as the base, project (.omr) overriding.
// Project values win per role/field, per style language, and for the lockout flag.
export async function loadMergedConfig(cwd: string, homeDir?: string): Promise<RoadmapProjectConfig> {
	const global = await loadGlobalConfig(homeDir)
	const project = (await fileExists(configPath(cwd))) ? await loadConfig(cwd) : undefined
	if (!global) return project ?? defaultConfig()
	if (!project) return global
	return mergeConfigs(global, project)
}

// Lockout: whether omr is paused via the unified (global + project) config.
export async function loadDisabled(cwd: string, homeDir?: string): Promise<boolean> {
	try {
		return (await loadMergedConfig(cwd, homeDir)).disabled === true
	} catch {
		return false
	}
}

// Set the project-scope lockout flag, creating a minimal project config if none exists.
export async function setProjectDisabled(cwd: string, disabled: boolean): Promise<void> {
	await withStoreWriteLock(cwd, async () => {
		const targetConfigPath = configPath(cwd)
		const existing = (await fileExists(targetConfigPath)) ? await loadConfig(cwd) : defaultConfig()
		const next: RoadmapProjectConfig = {...existing, disabled}
		parseConfig(next as unknown)
		await writeYamlFile(targetConfigPath, next)
	})
}

// Upsert per-language code-style guidance into the project config (used by omr:learn-style).
export async function setProjectStyle(cwd: string, language: string, guide: StyleGuide): Promise<void> {
	if (!language.trim()) throw new Error('style language must be a non-empty string')
	await withStoreWriteLock(cwd, async () => {
		const targetConfigPath = configPath(cwd)
		const existing = (await fileExists(targetConfigPath)) ? await loadConfig(cwd) : defaultConfig()
		const next: RoadmapProjectConfig = {...existing, style: {...existing.style, [language.trim()]: guide}}
		parseConfig(next as unknown)
		await writeYamlFile(targetConfigPath, next)
	})
}

async function loadSkill(name: string): Promise<{ description: string; body: string }> {
	const doc = parseMarkdownDocument<{ name: string; description: string }>(await readText(skillPath(name)))
	if (doc.data.name !== name) {
		throw new Error(`Expected ${name} skill, found ${doc.data.name}`)
	}
	if (!doc.data.description) {
		throw new Error(`${name} skill is missing a description`)
	}
	return {description: doc.data.description, body: doc.body}
}

function renderAgent(name: string, description: string, body: string, config: AgentConfig): string {
	const frontmatter: Record<string, unknown> = {
		name,
		description,
	}
	if (config.model) frontmatter.model = config.model
	if (config.thinking) frontmatter['thinking-level'] = config.thinking
	return serializeMarkdownDocument(frontmatter, body)
}

export async function generateAgentsAt(targetAgentsDir: string, config: RoadmapProjectConfig): Promise<Record<AgentRole, string>> {
	const skills = Object.fromEntries(
		await Promise.all(ROLE_NAMES.map(async (role) => [role, await loadSkill(role)])),
	) as Record<AgentRole, { description: string; body: string }>

	await fs.mkdir(targetAgentsDir, {recursive: true})

	const targetAgentPaths = Object.fromEntries(
		ROLE_NAMES.map((role) => [role, path.join(targetAgentsDir, `${role}.md`)]),
	) as Record<AgentRole, string>

	for (const role of ROLE_NAMES) {
		await writeText(
			targetAgentPaths[role],
			renderAgent(role, skills[role].description, skills[role].body, config.agents[role]),
		)
	}

	// Auxiliary agents (e.g. style-scout) inherit OMP's model/reasoning; not config-driven.
	for (const name of AUX_AGENT_NAMES) {
		const skill = await loadSkill(name)
		await writeText(path.join(targetAgentsDir, `${name}.md`), renderAgent(name, skill.description, skill.body, {}))
	}

	return targetAgentPaths
}

export async function generateAgents(cwd: string, config: RoadmapProjectConfig): Promise<Record<AgentRole, string>> {
	return generateAgentsAt(agentsDir(cwd), config)
}

// `omr-cli init` / legacy scaffolding: create the default config when missing, then
// (re)generate every agent definition from the config's models.
export async function initProject(cwd: string): Promise<ProjectInitResult> {
	return await withStoreWriteLock(cwd, async () => {
		const targetConfigPath = configPath(cwd)
		const createdConfig = await ensureConfig(cwd)
		const config = await loadConfig(cwd)
		const targetAgentPaths = await generateAgents(cwd, config)

		return {
			configPath: targetConfigPath,
			agentPaths: targetAgentPaths,
			createdConfig,
		}
	})
}

// `omr-cli apply`: regenerate agent definitions from an existing config's models.
// Requires the config to already exist (does not scaffold a default).
export async function applyProject(cwd: string): Promise<ProjectInitResult> {
	return await withStoreWriteLock(cwd, async () => {
		const targetConfigPath = configPath(cwd)
		if (!(await fileExists(targetConfigPath))) {
			throw new Error(`No config found at ${targetConfigPath}. Run \`omr init\` first.`)
		}
		const config = await loadConfig(cwd)
		const targetAgentPaths = await generateAgents(cwd, config)

		return {
			configPath: targetConfigPath,
			agentPaths: targetAgentPaths,
			createdConfig: false,
		}
	})
}

export type InitScope = 'project' | 'global';

function buildConfigFromAgents(
	agents: Record<AgentRole, AgentConfig>,
	existing?: RoadmapProjectConfig,
): RoadmapProjectConfig {
	const config: RoadmapProjectConfig = {
		agents,
		orchestration: existing?.orchestration ?? defaultOrchestrationConfig(),
	}
	if (existing?.disabled !== undefined) config.disabled = existing.disabled
	if (existing?.style !== undefined) config.style = existing.style
	return config
}

// Interactive `omr-cli init`: write the prompted per-role models to the scoped config and
// generate the matching agent definitions. A global init also scaffolds a model-free project
// `.omr/config.yml` in the current folder so project work still has a config to override with.
export async function initScoped(opts: {
	scope: InitScope;
	cwd: string;
	agents: Record<AgentRole, AgentConfig>;
	homeDir?: string;
}): Promise<ProjectInitResult> {
	const {scope, cwd, agents, homeDir} = opts
	return await withStoreWriteLock(cwd, async () => {
		if (scope === 'global') {
			const targetConfigPath = homeConfigPath(homeDir)
			const existed = await fileExists(targetConfigPath)
			const existing = existed ? parseConfig(await readYamlFile(targetConfigPath)) : undefined
			const config = buildConfigFromAgents(agents, existing)
			parseConfig(config as unknown)
			await writeYamlFile(targetConfigPath, config)
			const agentPaths = await generateAgentsAt(globalAgentsDir(homeDir), config)
			// Always scaffold a model-free project config in the current folder.
			await ensureConfig(cwd)
			return {configPath: targetConfigPath, agentPaths, createdConfig: !existed}
		}

		const targetConfigPath = configPath(cwd)
		const existed = await fileExists(targetConfigPath)
		const existing = existed ? await loadConfig(cwd) : undefined
		const config = buildConfigFromAgents(agents, existing)
		parseConfig(config as unknown)
		await writeYamlFile(targetConfigPath, config)
		const agentPaths = await generateAgents(cwd, config)
		return {configPath: targetConfigPath, agentPaths, createdConfig: !existed}
	})
}
