import {type AgentToolResult} from '@oh-my-pi/pi-coding-agent'
import type {ExtensionContext, ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {type Component, Text} from '@oh-my-pi/pi-tui'
import type {ToolRegistrationContext} from './shared'
import {clearFindingsReportTile, createReportTile, FINDINGS_REPORT_WIDGET_KEY} from '../../findings.ts'

type SubmitFindingsReportParams = {
	title: string
	markdown: string
}

type SubmitFindingsReportResult = {
	success: boolean
	error?: string
}

function resultText(result: SubmitFindingsReportResult): string {
	if (result.success) return 'Findings report tile rendered.'
	return `Findings report tile failed: ${result.error ?? 'unknown error'}`
}

function isSubmitFindingsReportResult(value: unknown): value is SubmitFindingsReportResult {
	return typeof value === 'object'
		&& value !== null
		&& 'success' in value
		&& typeof value.success === 'boolean'
}

export function registerFindingsReportTool(ctx: ToolRegistrationContext): void {
	const {z, register} = ctx

	register({
		name: 'omr_submit_findings_report',
		label: 'Submit Findings Report',
		description: 'Submit a report containing a summary of findings requested by the user.',
		approval: 'read',
		parameters: z.object({
			title: z.string().default('Findings Summary'),
			markdown: z.string(),
		}),

		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<SubmitFindingsReportResult>> {
			const input = params as SubmitFindingsReportParams

			try {
				if (!ctx.hasUI) {
					return {
						content: [{type: 'text', text: 'Findings report tile not rendered: UI unavailable.'}],
						details: {success: false, error: 'UI unavailable'},
					}
				}

				ctx.ui.setWidget(
					FINDINGS_REPORT_WIDGET_KEY,
					(_tui, theme) => createReportTile(input.title, input.markdown, theme),
					{placement: 'aboveEditor'},
				)

				return {
					content: [{type: 'text', text: 'Findings report tile rendered.'}],
					details: {success: true},
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)

				return {
					content: [{type: 'text', text: `Findings report tile failed: ${message}`}],
					details: {success: false, error: message},
				}
			}
		},

		renderResult(result, _options, theme): Component {
			return new Text(
				isSubmitFindingsReportResult(result.details)
					? resultText(result.details)
					: theme.fg('error', 'Findings report tile failed: missing result details'),
				0,
				0,
			)
		},

		onSession(event, ctx): void {
			if (event.reason === 'shutdown') {
				clearFindingsReportTile(ctx)
			}
		},
	} as ToolDefinition)
}
