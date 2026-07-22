import {AUX_AGENT_NAMES, loadDisabled, ROLE_NAMES} from './project-init'
import {validateImplementationGate} from './validation'

export const DIRECT_FILE_WRITE_TOOLS = new Set(['write', 'edit', 'ast_edit'])

// OMR-generated agents dispatched via the built-in `task` tool. While omr is paused,
// spawning any of these (or calling any omr_* tool) is blocked.
const OMR_AGENT_NAMES = new Set<string>([...ROLE_NAMES, ...AUX_AGENT_NAMES])

export interface ToolGateDecision {
	block: boolean;
	reason?: string;
}

// Under OMP's `xd://` tool transport (default on since 17.0.0), discoverable custom
// tools are unmounted from the top-level toolset and driven through `write`: an
// omr_* call arrives at the tool_call hook as `write` to `xd://omr_<name>` with the
// JSON args in `content`. Decode that back to the underlying tool name (+ args) so
// both the omr lockout and the file-write gate see the real call, not a bare `write`.
// A plain top-level call (xd:// disabled) passes through unchanged, so both modes work.
function resolveDispatch(
	toolName: string,
	input?: Record<string, unknown>,
): {toolName: string; input: Record<string, unknown> | undefined} {
	// Only the write tool carries xd:// device dispatch.
	if (toolName !== 'write' || !input) return {toolName, input}
	const rawPath = typeof input.path === 'string'
		? input.path
		: typeof input.file_path === 'string'
			? input.file_path
			: ''
	if (!rawPath.trim().toLowerCase().startsWith('xd://')) return {toolName, input}
	// `xd://<device>` — the device is the single path segment after the scheme.
	const device = rawPath.trim().slice('xd://'.length).replace(/[/?#].*$/, '').trim()
	if (!device) return {toolName, input}
	if (device.startsWith('omr_')) {
		// omr device: recover the JSON args best-effort (the name alone drives the
		// lockout, so a malformed/partial payload still gates correctly).
		let decoded: Record<string, unknown> | undefined
		if (typeof input.content === 'string') {
			try {
				const parsed: unknown = JSON.parse(input.content)
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					decoded = parsed as Record<string, unknown>
				}
			} catch {
				// Fall through with no decoded args.
			}
		}
		return {toolName: device, input: decoded ?? input}
	}
	// Any other device (xd://resolve, xd://propose, web_search, …) is neither an omr
	// call nor a working-tree write — surface the device name so it misses both gates
	// (in particular, it must NOT be treated as a direct file write).
	return {toolName: device, input}
}

function isOmrToolCall(toolName: string, input?: Record<string, unknown>): boolean {
	if (toolName.startsWith('omr_')) return true
	if (toolName === 'task') {
		// The task tool's `agent` moved into per-item entries (16.4.5); the flat
		// single-task form still carries it at the top level. Detect an omr agent in
		// either shape.
		if (agentInSet(input?.agent)) return true
		const tasks = input?.tasks
		if (Array.isArray(tasks)) {
			for (const item of tasks) {
				if (item && typeof item === 'object' && agentInSet((item as {agent?: unknown}).agent)) {
					return true
				}
			}
		}
	}
	return false
}

function agentInSet(agent: unknown): boolean {
	return typeof agent === 'string' && OMR_AGENT_NAMES.has(agent.trim())
}

export async function shouldBlockToolCall(
	cwd: string,
	rawToolName: string,
	rawInput?: Record<string, unknown>,
	homeDir?: string,
): Promise<ToolGateDecision> {
	const {toolName, input} = resolveDispatch(rawToolName, rawInput)

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
