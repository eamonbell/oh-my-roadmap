export const COMMANDS = [
	['omr:rm-new', 'Create a new gated roadmap workflow'],
	['omr:rm-resume', 'Resume the active roadmap from .omr state'],
	['omr:rm-status', 'Report active roadmap state, validation, and next action'],
	['omr:rm-amend', 'Record an approved roadmap amendment'],
	['omr:rm-reopen', 'Reopen the approved roadmap for pre-milestone changes'],
	['omr:rm-repair', 'Repair roadmap hash and generated-artifact drift'],
	['omr:ms-plan', 'Plan the next milestone with dependency waves'],
	['omr:ms-implement', 'Implement the approved milestone or active change plan'],
	['omr:ms-status', 'Report active milestone health'],
	['omr:ms-close', 'Close a milestone with evidence'],
	['omr:byp-request', 'Record a reasoned implementation-gate bypass'],
	['omr:byp-clear', 'Clear an active bypass'],
	['omr:chg-request', 'Plan a post-implementation change request'],
	['omr:chg-status', 'Report active change-request state'],
	['omr:chg-close', 'Close an active change request with evidence'],
	['omr:blk-list', 'List open roadmap blockers and recovery commands'],
	['omr:blk-status', 'Report current blocker state and next recovery step'],
	['omr:blk-resolve', 'Resolve a blocker by id with a resolution'],
	['omr:blk-defer', 'Defer a blocker by id with a reason'],
] as const

export const DETAILS_COMMAND = 'omr:rm-details'
export const USAGE_COMMAND = 'omr:rm-usage'
export const FINDINGS_CLEAR_COMMAND = 'omr:fnd-clear'
export const DISABLE_COMMAND = 'omr:disable'
export const ENABLE_COMMAND = 'omr:enable'
export const LEARN_STYLE_COMMAND = 'omr:learn-style'
export const PLAN_DETAILS_COMMAND = 'omr:plan-details'

// Ad-hoc plan commands (roadmap-free lightweight flow), prompt-driven like the roadmap commands.
export const ADHOC_COMMANDS = [
	['omr:adhoc-new', 'Create and plan a new ad-hoc plan (no roadmap)'],
	['omr:adhoc-plan', 'Revise the active draft ad-hoc plan'],
	['omr:adhoc-implement', 'Implement the approved ad-hoc plan in waves'],
	['omr:adhoc-status', 'Report active ad-hoc plan health'],
	['omr:adhoc-close', 'Close the active ad-hoc plan with evidence'],
	['omr:adhoc-cancel', 'Cancel and clear the active ad-hoc plan'],
] as const
export const COMMAND_MESSAGE_TYPE = 'oh-my-roadmap.command-result'
