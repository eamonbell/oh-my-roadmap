import {AUX_AGENT_NAMES, loadDisabled, ROLE_NAMES} from './project-init'
import {validateImplementationGate} from './validation'

export const DIRECT_FILE_WRITE_TOOLS = new Set(['write', 'edit', 'ast_edit', 'resolve'])

// OMR-generated agents dispatched via the built-in `task` tool. While omr is paused,
// spawning any of these (or calling any omr_* tool) is blocked.
const OMR_AGENT_NAMES = new Set<string>([...ROLE_NAMES, ...AUX_AGENT_NAMES])

export interface ToolGateDecision {
	block: boolean;
	reason?: string;
}

function isOmrToolCall(toolName: string, input?: Record<string, unknown>): boolean {
	if (toolName.startsWith('omr_')) return true
	if (toolName === 'task') {
		const agent = typeof input?.agent === 'string' ? input.agent.trim() : ''
		return OMR_AGENT_NAMES.has(agent)
	}
	return false
}

export async function shouldBlockToolCall(
	cwd: string,
	toolName: string,
	input?: Record<string, unknown>,
	homeDir?: string,
): Promise<ToolGateDecision> {
	// Lockout gate: when omr is disabled, block omr tools and omr agent spawns so
	// unrelated agents don't drive roadmap work or load omr skills.
	if (isOmrToolCall(toolName, input) && (await loadDisabled(cwd, homeDir))) {
		return {
			block: true,
			reason:
				'oh-my-roadmap is paused (disabled in .omr/config.yml). Do not call omr tools, spawn omr agents, ' +
				'or load omr skills. Run /omr:enable to resume.',
		}
	}

	// Implementation write-gate: block direct file writes unless implementation is legally open.
	if (!DIRECT_FILE_WRITE_TOOLS.has(toolName)) return {block: false}

	const gate = await validateImplementationGate(cwd)
	if (gate.valid) return {block: false}

	const reason = gate.errors.map((error) => `- ${error.message}`).join('\n')
	return {
		block: true,
		reason: `oh-my-roadmap blocked ${toolName}: implementation gates are not satisfied.\n${reason}`,
	}
}
