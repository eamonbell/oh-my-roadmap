// Public entry point for @oh-my-roadmap/core.
// Subpaths (e.g. @oh-my-roadmap/core/store/index) remain importable directly;
// this barrel exposes the config + agent-generation API used by omr-cli.
export {
	initProject,
	initScoped,
	applyProject,
	applyScoped,
	generateAgents,
	generateAgentsAt,
	globalAgentsDir,
	loadConfig,
	ensureConfig,
	loadGlobalConfig,
	loadMergedConfig,
	loadDisabled,
	setProjectDisabled,
	setProjectStyle,
	homeConfigDir,
	loadTransportResumeAttempts,
	DEFAULT_TRANSPORT_RESUME_ATTEMPTS,
	ROLE_NAMES,
	THINKING_LEVELS,
} from './project-init'
export type {
	ProjectInitResult,
	RoadmapProjectConfig,
	AgentConfig,
	AgentRole,
	OrchestrationConfig,
	StyleGuide,
	InitScope,
} from './project-init'
export {
	validateProfileName,
	activeProfileFromEnv,
	resolveOmpRoot,
	ompPluginRoot,
	ompAgentsDir,
	ompOmrConfigDir,
	resolveScopeAndProfile,
} from './omp-paths'
export type {OmpScope, OmpRootOptions} from './omp-paths'
