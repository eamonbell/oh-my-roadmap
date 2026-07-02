// Public entry point for @oh-my-roadmap/core.
// Subpaths (e.g. @oh-my-roadmap/core/store/index) remain importable directly;
// this barrel exposes the config + agent-generation API used by omr-cli.
export {
	initProject,
	applyProject,
	generateAgents,
	loadConfig,
	ensureConfig,
	loadTransportResumeAttempts,
	DEFAULT_TRANSPORT_RESUME_ATTEMPTS,
} from './project-init'
export type {
	ProjectInitResult,
	RoadmapProjectConfig,
	AgentConfig,
	AgentRole,
	OrchestrationConfig,
} from './project-init'
