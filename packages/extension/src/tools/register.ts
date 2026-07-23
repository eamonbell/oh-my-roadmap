import type {ExtensionAPI, ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {withDiagnosticTiming} from '@oh-my-roadmap/core/diagnostics'
import {notifyMoshiForRoadmapToolResult} from '../extension/moshi-notifications'
import {registerAdhocTools} from './register/adhoc-tools'
import {registerBaselineTools} from './register/baseline-tools'
import {registerBlockerTools} from './register/blocker-tools'
import {registerContextTools} from './register/context-tools'
import {registerFindingsReportTool} from './register/findings-report-tool'
import {registerGraphTools} from './register/graph-tools'
import {registerReportTools} from './register/report-tools'
import {registerRoadmapLifecycleTools} from './register/roadmap-tools'
import {registerScoutTools} from './register/scout-tools'
import {createToolRegistrationSchemas, toolMetadata, type ToolRegistrationContext} from './register/shared'
import {registerStyleTools} from './register/style-tools'
import {registerTransitionTools} from './register/transition-tools'
import {registerWaveTools} from './register/wave-tools'

export function registerRoadmapTools(api: ExtensionAPI): void {
	const z = api.zod.z
	const register = (tool: ToolDefinition) =>
		api.registerTool({
			...tool,
			async execute(toolCallId, params, signal, update, ctx) {
				const result = await withDiagnosticTiming({
					component: 'tool',
					operation: tool.name,
					cwd: ctx.cwd,
					slowMs: 1000,
					metadata: toolMetadata(tool, toolCallId, params),
				}, async () => await tool.execute(toolCallId, params, signal, update, ctx))
				// Fire-and-forget: opt-in Moshi notification never delays or fails the result.
				void notifyMoshiForRoadmapToolResult(ctx, tool.name, params, result, api.logger).catch(() => {})
				return result
			},
		} as ToolDefinition)

	const schemas = createToolRegistrationSchemas(z)
	const ctx: ToolRegistrationContext = {api, z, register, schemas}

	registerRoadmapLifecycleTools(ctx)
	registerContextTools(ctx)
	registerTransitionTools(ctx)
	registerBlockerTools(ctx)
	registerWaveTools(ctx)
	registerBaselineTools(ctx)
	registerReportTools(ctx)
	registerFindingsReportTool(ctx)
	registerGraphTools(ctx)
	registerStyleTools(ctx)
	registerAdhocTools(ctx)
	registerScoutTools(ctx)
}
