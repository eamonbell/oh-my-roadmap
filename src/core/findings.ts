import type {ExtensionContext} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import type {Theme} from '@oh-my-pi/pi-coding-agent'
import {Box, Component, Markdown, MarkdownTheme, Text} from '@oh-my-pi/pi-tui'

export const FINDINGS_REPORT_WIDGET_KEY = 'findings-report-tile'
export type FindingsReportUiContext = Pick<ExtensionContext, 'hasUI' | 'ui'>

export function clearFindingsReportTile(ctx: FindingsReportUiContext): boolean {
	if (!ctx.hasUI) return false
	ctx.ui.setWidget(FINDINGS_REPORT_WIDGET_KEY, undefined)
	return true
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

export function createReportTile(title: string, markdown: string, theme: Theme): Component {
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