import type {ActiveRoadmapDetailSummary, RoadmapDetailControl, RoadmapDetailSummary} from '../../core/roadmap-detail-summary/index'
import {
	COLUMN_GAP,
	DETAILS_VIEW_HEIGHT,
	EMPTY_NEXT_ACTION,
	MIN_MAIN_WIDTH,
	MIN_RAIL_WIDTH,
	MIN_VIEW_HEIGHT,
	MIN_VIEW_WIDTH,
	TAB_NAMES
} from './constants'
import {issueCountLabel, renderTabContent} from './tabs'
import {
	arrowLines,
	bottomBorder,
	divider,
	fitLinesToHeight,
	keyValueLines,
	renderColumns,
	row,
	s,
	sectionHeader,
	styleValue,
	topBorder,
	truncateAnsi,
	wrapWords
} from './text'
import type {ColumnLayout, FocusArea, RenderBodyOptions, RenderRoadmapDetailsFrameOptions} from './types'

export function renderRoadmapDetailsFrame(options: RenderRoadmapDetailsFrameOptions): string[] {
	const {summary, width, height, scrollView} = options
	const safeWidth = Math.max(MIN_VIEW_WIDTH, Math.trunc(width || MIN_VIEW_WIDTH))
	const safeHeight = Math.max(MIN_VIEW_HEIGHT, Math.trunc(height || DETAILS_VIEW_HEIGHT))
	const contentWidth = Math.max(1, safeWidth - 4)
	const activeTabIndex = clampTabIndex(options.activeTabIndex ?? 0)
	const focus = options.focus ?? 'rail'
	const message = options.message ?? ''
	const headerLines = renderFixedHeader(summary, safeWidth)
	const footerLines = renderFixedFooter(focus, safeWidth)
	const bodyHeight = Math.max(1, safeHeight - headerLines.length - footerLines.length)
	const body = renderBody({
		summary,
		contentWidth,
		bodyHeight,
		scrollView,
		activeTabIndex,
		focus,
		message,
	})

	return [
		...headerLines,
		...body.map((line) => row(line, safeWidth)),
		...footerLines,
	]
}

function clampTabIndex(index: number): number {
	if (!Number.isFinite(index)) return 0
	return Math.max(0, Math.min(TAB_NAMES.length - 1, Math.trunc(index)))
}

function renderFixedHeader(summary: RoadmapDetailSummary, width: number): string[] {
	if (summary.kind === 'empty') {
		return [
			topBorder(width, ` ${s.bold}${s.cyan}Roadmap Details${s.reset} `),
			row(`${s.dim}No active roadmap${s.reset}`, width),
			divider(width),
		]
	}

	return [
		topBorder(width, ` ${s.bold}${s.cyan}${summary.roadmap.title}${s.reset} `),
		row(`${summary.roadmap.id}  ${s.dim}phase${s.reset} ${styleValue(summary.roadmap.phase)}`, width),
		divider(width),
	]
}

function renderFixedFooter(focus: FocusArea, width: number): string[] {
	const railKeys = 'Rail: ↑/↓ tabs  Enter main  Esc close'
	const mainKeys = 'Main: ↑/↓ scroll  PgUp/PgDn jump  Esc rail  Ctrl+C close'
	return [
		divider(width),
		row(`${s.dim}${focus === 'rail' ? railKeys : mainKeys}${s.reset}`, width, 'center'),
		bottomBorder(width),
	]
}


function renderBody(options: RenderBodyOptions): string[] {
	const {summary, contentWidth, bodyHeight, scrollView, activeTabIndex, focus, message} = options
	if (summary.kind === 'empty') {
		scrollView.setHeight(bodyHeight)
		scrollView.setLines([
			sectionHeader('Next Action'),
			...arrowLines(EMPTY_NEXT_ACTION, contentWidth),
			'',
			sectionHeader('Status'),
			...wrapWords(summary.message, contentWidth),
		])
		return scrollView.render(contentWidth) as string[]
	}

	const layout = computeColumnLayout(contentWidth)
	const mainLines = renderTabContent(summary, TAB_NAMES[activeTabIndex] ?? 'Overview', layout.mode === 'columns' ? layout.mainWidth : layout.contentWidth)
	const statusLines = message ? [`${s.yellow}${message}${s.reset}`, ''] : []
	const visibleMainHeight = Math.max(1, layout.mode === 'columns' ? bodyHeight : bodyHeight - renderRail(summary, activeTabIndex, focus, layout.contentWidth).length - 1)
	scrollView.setHeight(visibleMainHeight)
	scrollView.setLines([...statusLines, ...mainLines])

	if (layout.mode === 'columns') {
		const rail = renderRail(summary, activeTabIndex, focus, layout.railWidth)
		const main = scrollView.render(layout.mainWidth) as string[]
		return renderColumns(rail, main, layout.railWidth, layout.mainWidth, bodyHeight)
	}

	const rail = renderRail(summary, activeTabIndex, focus, layout.contentWidth)
	const main = scrollView.render(layout.contentWidth) as string[]
	return fitLinesToHeight([...rail, '', ...main], bodyHeight)
}


function computeColumnLayout(contentWidth: number): ColumnLayout {
	if (contentWidth < MIN_RAIL_WIDTH + COLUMN_GAP + MIN_MAIN_WIDTH) {
		return {mode: 'stacked', contentWidth}
	}

	const railWidth = Math.max(MIN_RAIL_WIDTH, Math.floor(contentWidth * 0.27))
	const mainWidth = contentWidth - railWidth - COLUMN_GAP

	if (mainWidth < MIN_MAIN_WIDTH) {
		return {mode: 'stacked', contentWidth}
	}

	return {mode: 'columns', contentWidth, railWidth, mainWidth}
}

function renderRail(summary: ActiveRoadmapDetailSummary, activeTabIndex: number, focus: FocusArea, width: number): string[] {
	const lines = [
		sectionHeader(focus === 'rail' ? 'Tabs *' : 'Tabs'),
		...TAB_NAMES.flatMap((tab, index) => tabLine(tab, index === activeTabIndex, focus === 'rail', width)),
		'',
		sectionHeader('Health'),
		...keyValueLines('Phase', summary.roadmap.phase, width),
		...keyValueLines('Status', summary.roadmapHealth.status, width),
		...keyValueLines('Blockers', String(summary.roadmapHealth.openBlockerCount), width),
		...keyValueLines('Issues', issueCountLabel(summary), width),
		'',
		sectionHeader('Shortcuts'),
		...summary.availableControls.map((control) => shortcutLine(control, width)),
	]
	return lines
}

function tabLine(tab: string, selected: boolean, focused: boolean, width: number): string[] {
	const marker = selected ? (focused ? '>' : '*') : ' '
	const text = `${marker} ${tab}`
	return wrapWords(selected ? `${s.cyan}${s.bold}${text}${s.reset}` : `${s.dim}${text}${s.reset}`, width)
}

function shortcutLine(control: RoadmapDetailControl, width: number): string {
	const label = `[${control.key}] ${control.label}`
	const suffix = control.enabled ? '' : ' disabled'
	return truncateAnsi(control.enabled ? `${s.cyan}${label}${s.reset}` : `${s.dim}${label}${suffix}${s.reset}`, width)
}
