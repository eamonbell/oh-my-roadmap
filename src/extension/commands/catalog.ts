export const COMMANDS = [
	['roadmap:new', 'Create a new gated roadmap workflow'],
	['roadmap:resume', 'Resume the active roadmap from .roadmaps state'],
	['roadmap:status', 'Report active roadmap state, validation, and next action'],
	['roadmap:amend', 'Record an approved roadmap amendment'],
	['roadmap:reopen', 'Reopen the approved roadmap for pre-milestone changes'],
	['roadmap:repair', 'Repair roadmap hash and generated-artifact drift'],
	['milestone:plan', 'Plan the next milestone with dependency waves'],
	['milestone:implement', 'Implement the approved milestone or active change plan'],
	['milestone:status', 'Report active milestone health'],
	['milestone:close', 'Close a milestone with evidence'],
	['bypass:request', 'Record a reasoned implementation-gate bypass'],
	['bypass:clear', 'Clear an active bypass'],
	['change:request', 'Plan a post-implementation change request'],
	['change:status', 'Report active change-request state'],
	['change:close', 'Close an active change request with evidence'],
	['blocker:list', 'List open roadmap blockers and recovery commands'],
	['blocker:status', 'Report current blocker state and next recovery step'],
	['blocker:resolve', 'Resolve a blocker by id with a resolution'],
	['blocker:defer', 'Defer a blocker by id with a reason'],
] as const

export const INIT_COMMAND = 'roadmap:init'
export const DETAILS_COMMAND = 'roadmap:details'
export const FINDINGS_CLEAR_COMMAND = 'findings:clear'
export const COMMAND_MESSAGE_TYPE = 'roadmap-engineer.command-result'
