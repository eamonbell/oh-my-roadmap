import type {HookAPI} from '@oh-my-pi/pi-coding-agent/extensibility/hooks'
import {shouldBlockToolCall} from '@oh-my-roadmap/core/gate'

export default function roadmapEngineerGate(pi: HookAPI): void {
	pi.on('tool_call', async (event, ctx) => {
		const decision = await shouldBlockToolCall(ctx.cwd, event.toolName, event.input)
		if (!decision.block) return
		return decision.reason
			? {block: true, reason: decision.reason}
			: {block: true}
	})
}
