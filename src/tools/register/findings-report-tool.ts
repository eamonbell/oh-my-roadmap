import {type AgentToolResult, type Theme} from '@oh-my-pi/pi-coding-agent'
import type {ExtensionContext, ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {Box, type Component, Markdown, type MarkdownTheme, Text} from '@oh-my-pi/pi-tui'
import type {ToolRegistrationContext} from './shared'

const WIDGET_KEY = 'findings-report-tile'

type SubmitFindingsReportParams = {
	title: string
	markdown: string
}

type SubmitFindingsReportResult = {
	success: boolean
	error?: string
}

function createMarkdownTheme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg('mdHeading', text),
		link: (text) => theme.fg('mdLink', text),
		linkUrl: (text) => theme.fg('mdLinkUrl', text),
		code: (text) => theme.fg('mdCode', text),
		codeBlock: (text) => theme.fg('mdCodeBlock', text),
		codeBlockBorder: (text) => theme.fg('mdCodeBlockBorder', text),
		quote: (text) => theme.fg('mdQuote', text),
		quoteBorder: (text) => theme.fg('mdQuoteBorder', text),
		hr: (text) => theme.fg('mdHr', text),
		listBullet: (text) => theme.fg('mdListBullet', text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
		symbols: {
			cursor: theme.nav.cursor,
			inputCursor: theme.getSymbolPreset() === 'ascii' ? '|' : '▏',
			boxRound: theme.boxRound,
			boxSharp: theme.boxSharp,
			table: theme.boxSharp,
			quoteBorder: theme.md.quoteBorder,
			hrChar: theme.md.hrChar,
			colorSwatch: theme.md.colorSwatch,
			spinnerFrames: theme.getSpinnerFrames('activity'),
		},
	}
}

function createReportTile(title: string, markdown: string, theme: Theme): Component {
	const tile = new Box(
		1,
		0,
		(text) => theme.bg('customMessageBg', text),
		{
			chars: {
				topLeft: '┌',
				topRight: '┐',
				bottomLeft: '└',
				bottomRight: '┘',
				horizontal: '─',
				vertical: '│',
			},
			color: (text) => theme.fg('borderMuted', text),
		},
	)

	tile.addChild(new Text(theme.fg('accent', theme.bold(title)), 0, 0))
	tile.addChild(new Markdown(markdown, 0, 1, createMarkdownTheme(theme)))

	return tile
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
		name: 'roadmap_engineer_submit_findings_report',
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
					WIDGET_KEY,
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
			if (event.reason === 'shutdown' && ctx.hasUI) {
				ctx.ui.setWidget(WIDGET_KEY, undefined)
			}
		},
	} as ToolDefinition)
}
