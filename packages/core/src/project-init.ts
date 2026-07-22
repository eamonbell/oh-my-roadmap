import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {fileExists, readYamlFile, writeText, writeYamlFile} from './files'
import {parseMarkdownDocument, serializeMarkdownDocument} from './frontmatter'
import {withStoreWriteLock} from './lock'
import {activeProfileFromEnv, ompAgentsDir, ompOmrConfigDir} from './omp-paths'
import {roadmapsDir} from './paths'
import {fileURLToPath} from 'node:url'
import {existsSync as fileExistsSync} from 'node:fs'

const CONFIG_FILE = 'config.yml'
const OMP_AGENTS_DIR = path.join('.omp', 'agents')
export const ROLE_NAMES = ['worker-light', 'worker', 'worker-heavy', 'reviewer', 'wave-flow-checker', 'roadmap-milestone-checker', 'style-scout'] as const
export const THINKING_LEVELS = ['inherit', 'auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const THINKING_LEVELS_SET = new Set<string>(THINKING_LEVELS)
export const DEFAULT_TRANSPORT_RESUME_ATTEMPTS = 3

export type AgentRole = (typeof ROLE_NAMES)[number];

export interface AgentConfig {
	model?: string;
	thinking?: string;
	// OMP prewalk hand-off (opt-in, default off): `true` starts the agent on its
	// resolved model to plan/init todos, then hands off to the default prewalk
	// target at its first edit/write; a string is a custom target model pattern.
	prewalk?: boolean | string;
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

// Opt-in Moshi notifications. Absent means disabled; notifications are sent only
// when `enabled` is exactly true after global/project merge. `socket_path` overrides
// the platform default Moshi local-socket path.
//
// `enabled` is optional in the stored shape so shallow merging preserves the source's
// intent: a project config that sets only `socket_path` must not clobber a
// profile-global `enabled: true`. A missing `enabled` reads as disabled.
export interface MoshiConfig {
	enabled?: boolean;
	socket_path?: string;
	// When true, append a per-project trace of Moshi notification decisions to
	// .omr/logs/moshi.ndjson (also enabled by the OMR_MOSHI_TRACE env var). For debugging.
	trace?: boolean;
}

export interface RoadmapProjectConfig {
	agents: Record<AgentRole, AgentConfig>;
	orchestration: OrchestrationConfig;
	// Lockout flag (project scope). When true, omr tools/agents are paused.
	disabled?: boolean;
	// Code-style guidance keyed by language id (e.g. `typescript`, `go`).
	style?: Record<string, StyleGuide>;
	// Opt-in Moshi notification settings.
	moshi?: MoshiConfig;
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

// User-level (global) agents are discovered by OMP at <ompRoot>/agent/agents/*.md
// (respecting PI_CONFIG_DIR and the active profile). Project agents live at
// <cwd>/.omp/agents/*.md. A missing profile falls back to the ambient OMP profile.
export function globalAgentsDir(homeDir?: string, profile?: string): string {
	return ompAgentsDir({homeDir, profile: profile ?? activeProfileFromEnv()})
}

// Auxiliary agents generated alongside the configurable worker/reviewer roles. These
// are not model-configurable in config.yml; they inherit OMP's model/reasoning.
export const AUX_AGENT_NAMES = ['style-scout'] as const

// Sub-agent prompt templates (one per role), bundled as text via import. Not OMP
// skills — these are the source bodies that generateAgents() renders into OMP agent
// definitions with config-driven model/reasoning. They ship in the package's
// agent-templates/ dir and are read from disk at runtime.
//
// We deliberately do NOT `import ... AGENT.md with {type: 'text'}`: OMP's plugin
// extension validator walks the module graph by scanning import specifiers and
// ignores the import attribute, then forces a JS loader on every graphed file by
// extension — so a text-imported .md gets parsed as JavaScript and install fails.
// Reading from disk keeps the .md files out of that graph.
// Genuine OMP skills live in the plugin's own skills/ folder.
// const AGENT_TEMPLATES_DIR = path.join(import.meta.dir, '..', 'agent-templates')
function resolveAgentTemplatesDir(): string {
	// Prefer resolving relative to this module (works when core runs unbundled).
	const localDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-templates')
	if (fileExistsSync(localDir)) return localDir

	// When the CLI bundles core into a single file, import.meta.url points at the
	// bundle (which has no agent-templates/). Ask module resolution where the core
	// package actually lives and read the templates it shipped with.
	const require = createRequire(import.meta.url)
	const corePkgJson = require.resolve('@oh-my-roadmap/core/package.json')
	return path.join(path.dirname(corePkgJson), 'agent-templates')
}

// Allow the CLI (single-file bundle) to supply embedded template sources so it does
// not have to read agent-templates/ from disk. The extension keeps reading from disk.
let agentTemplatesDir: string | undefined
let templateSourceProvider: ((name: AgentRole) => string) | undefined

export function setAgentTemplateSourceProvider(provider: (name: AgentRole) => string): void {
	templateSourceProvider = provider
}

function readAgentTemplateSource(name: AgentRole): string {
	if (templateSourceProvider) return templateSourceProvider(name)
	agentTemplatesDir ??= resolveAgentTemplatesDir()
	return readFileSync(path.join(agentTemplatesDir, name, 'AGENT.md'), 'utf8')
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
	rejectUnknownKeys(roleConfig, ['model', 'thinking', 'prewalk'], `agents.${role}`)

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

	if (roleConfig.prewalk !== undefined) {
		// `true`/`false` toggle the default prewalk target; a non-empty string is a
		// custom target model pattern. Reject other shapes so a typo fails loudly.
		if (typeof roleConfig.prewalk === 'boolean') {
			config.prewalk = roleConfig.prewalk
		} else if (typeof roleConfig.prewalk === 'string' && roleConfig.prewalk.trim() !== '') {
			config.prewalk = roleConfig.prewalk.trim()
		} else {
			throw new Error(`agents.${role}.prewalk must be a boolean or a non-empty model-pattern string`)
		}
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

function parseMoshi(value: unknown): MoshiConfig | undefined {
	if (value === undefined) return undefined
	const moshi = requirePlainObject(value, 'moshi')
	rejectUnknownKeys(moshi, ['enabled', 'socket_path', 'trace'], 'moshi')

	// Only store fields when explicitly provided so shallow merge preserves per-field
	// intent. A missing `enabled`/`trace` reads as disabled downstream.
	const result: MoshiConfig = {}
	if (moshi.enabled !== undefined) {
		if (typeof moshi.enabled !== 'boolean') throw new Error('moshi.enabled must be a boolean')
		result.enabled = moshi.enabled
	}
	if (moshi.trace !== undefined) {
		if (typeof moshi.trace !== 'boolean') throw new Error('moshi.trace must be a boolean')
		result.trace = moshi.trace
	}
	if (moshi.socket_path !== undefined) {
		if (typeof moshi.socket_path !== 'string' || moshi.socket_path.trim() === '') {
			throw new Error('moshi.socket_path must be a non-empty string')
		}
		result.socket_path = moshi.socket_path.trim()
	}
	return result
}

function parseConfig(raw: unknown): RoadmapProjectConfig {
	const root = requirePlainObject(raw, 'config')
	rejectUnknownKeys(root, ['agents', 'orchestration', 'disabled', 'style', 'moshi'], 'config')

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
	const moshi = parseMoshi(root.moshi)
	if (moshi !== undefined) config.moshi = moshi
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
	rejectUnknownKeys(root, ['agents', 'orchestration', 'disabled', 'style', 'moshi'], 'config')
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
	// Preserve optional lockout/style/moshi keys unchanged.
	if (root.disabled !== undefined) expanded.disabled = root.disabled
	if (root.style !== undefined) expanded.style = root.style
	if (root.moshi !== undefined) expanded.moshi = root.moshi
	parseConfig(expanded)
	if (changed) await writeYamlFile(targetConfigPath, expanded)
	return false
}

// Our omr global config dir: <ompRoot>/oh-my-roadmap (honoring PI_CONFIG_DIR and
// the active profile). A missing profile falls back to the ambient OMP profile.
export function homeConfigDir(homeDir?: string, profile?: string): string {
	return ompOmrConfigDir({homeDir, profile: profile ?? activeProfileFromEnv()})
}

function homeConfigPath(homeDir?: string, profile?: string): string {
	return path.join(homeConfigDir(homeDir, profile), CONFIG_FILE)
}

// Global config lives at <ompRoot>/oh-my-roadmap/config.yml. Absent by default.
export async function loadGlobalConfig(homeDir?: string, profile?: string): Promise<RoadmapProjectConfig | undefined> {
	const targetPath = homeConfigPath(homeDir, profile)
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

	// Shallow-merge moshi so a profile-global config can enable it while a project
	// config overrides only socket_path (or disables with `enabled: false`). The
	// leading `enabled: false` guarantees a defined flag; later spreads win.
	if (base.moshi !== undefined || override.moshi !== undefined) {
		merged.moshi = {enabled: false, ...(base.moshi ?? {}), ...(override.moshi ?? {})}
	}
	return merged
}

// Unified config: global (<ompRoot>/oh-my-roadmap) as the base, project (.omr)
// overriding. Project values win per role/field, per style language, and for the
// lockout flag. The active profile selects which global config is the base.
export async function loadMergedConfig(cwd: string, homeDir?: string, profile?: string): Promise<RoadmapProjectConfig> {
	const global = await loadGlobalConfig(homeDir, profile)
	const project = (await fileExists(configPath(cwd))) ? await loadConfig(cwd) : undefined
	if (!global) return project ?? defaultConfig()
	if (!project) return global
	return mergeConfigs(global, project)
}

// Opt-in Moshi settings from the unified (global + project) config. Missing config
// resolves to disabled. Parse errors are not swallowed — invalid config fails loudly
// like the rest of the config surface.
export async function loadMoshiConfig(cwd: string, homeDir?: string, profile?: string): Promise<MoshiConfig> {
	return (await loadMergedConfig(cwd, homeDir, profile)).moshi ?? {enabled: false}
}

// Lockout: whether omr is paused via the unified (global + project) config.
export async function loadDisabled(cwd: string, homeDir?: string, profile?: string): Promise<boolean> {
	try {
		return (await loadMergedConfig(cwd, homeDir, profile)).disabled === true
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

function loadAgentTemplate(name: AgentRole): { description: string; body: string } {
	const doc = parseMarkdownDocument<{ name: string; description: string }>(readAgentTemplateSource(name))
	if (doc.data.name !== name) {
		throw new Error(`Expected ${name} agent template, found ${doc.data.name}`)
	}
	if (!doc.data.description) {
		throw new Error(`${name} agent template is missing a description`)
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
	if (config.prewalk) frontmatter.prewalk = config.prewalk
	return serializeMarkdownDocument(frontmatter, body)
}

export async function generateAgentsAt(targetAgentsDir: string, config: RoadmapProjectConfig): Promise<Record<AgentRole, string>> {
	const templates = Object.fromEntries(
		ROLE_NAMES.map((role) => [role, loadAgentTemplate(role)]),
	) as Record<AgentRole, { description: string; body: string }>

	await fs.mkdir(targetAgentsDir, {recursive: true})

	const targetAgentPaths = Object.fromEntries(
		ROLE_NAMES.map((role) => [role, path.join(targetAgentsDir, `${role}.md`)]),
	) as Record<AgentRole, string>

	for (const role of ROLE_NAMES) {
		// A config may omit a role (global/project configs list only a subset); an
		// absent role inherits OMP defaults.
		await writeText(
			targetAgentPaths[role],
			renderAgent(role, templates[role].description, templates[role].body, config.agents[role] ?? {}),
		)
	}

	// Auxiliary agents (e.g. style-scout) inherit OMP's model/reasoning; not config-driven.
	/*for (const name of AUX_AGENT_NAMES) {
		const template = loadAgentTemplate(name)
		await writeText(path.join(targetAgentsDir, `${name}.md`), renderAgent(name, template.description, template.body, {}))
	}*/

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

// `omr apply` scoped to project or global. Regenerates agent definitions from an
// already-existing config; never scaffolds one. A missing config yields an
// actionable "run init first" error naming the scope + profile.
export async function applyScoped(opts: {
	scope: InitScope;
	cwd: string;
	homeDir?: string | undefined;
	profile?: string | undefined;
}): Promise<ProjectInitResult> {
	const {scope, cwd, homeDir, profile} = opts
	if (scope === 'project') return applyProject(cwd)

	return await withStoreWriteLock(cwd, async () => {
		const targetConfigPath = homeConfigPath(homeDir, profile)
		if (!(await fileExists(targetConfigPath))) {
			const initHint = profile ? `omr init --global --profile ${profile}` : 'omr init --global'
			throw new Error(`No global config found at ${targetConfigPath}. Run \`${initHint}\` first.`)
		}
		const config = parseConfig(await readYamlFile(targetConfigPath))
		const agentPaths = await generateAgentsAt(globalAgentsDir(homeDir, profile), config)
		return {configPath: targetConfigPath, agentPaths, createdConfig: false}
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
	if (existing?.moshi !== undefined) config.moshi = existing.moshi
	return config
}

// Interactive `omr-cli init`: write the prompted per-role models to the scoped config and
// generate the matching agent definitions. A global init also scaffolds a model-free project
// `.omr/config.yml` in the current folder so project work still has a config to override with.
export async function initScoped(opts: {
	scope: InitScope;
	cwd: string;
	agents: Record<AgentRole, AgentConfig>;
	homeDir?: string | undefined;
	profile?: string | undefined;
}): Promise<ProjectInitResult> {
	const {scope, cwd, agents, homeDir, profile} = opts
	return await withStoreWriteLock(cwd, async () => {
		if (scope === 'global') {
			const targetConfigPath = homeConfigPath(homeDir, profile)
			const existed = await fileExists(targetConfigPath)
			const existing = existed ? parseConfig(await readYamlFile(targetConfigPath)) : undefined
			const config = buildConfigFromAgents(agents, existing)
			parseConfig(config as unknown)
			await writeYamlFile(targetConfigPath, config)
			const agentPaths = await generateAgentsAt(globalAgentsDir(homeDir, profile), config)
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
