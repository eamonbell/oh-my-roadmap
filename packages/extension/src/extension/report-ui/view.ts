import {Component, matchesKey, ScrollView, TUI} from '@oh-my-pi/pi-tui'
import type {RoadmapDetailSummary} from '@oh-my-roadmap/core/roadmap-detail-summary/index'
import {TAB_NAMES} from './constants'
import {renderRoadmapDetailsFrame} from './frame'
import {fitFrameToTerminal, getTuiRowsAndCols} from './text'
import type {FocusArea} from './types'

export class RoadmapDetailsView implements Component {
	#summary: RoadmapDetailSummary
	readonly #done: () => void
	readonly #onControl: ((key: string, view: RoadmapDetailsView) => void) | undefined
	readonly #tui: TUI
	#focus: FocusArea = 'rail'
	#activeTabIndex = 0
	#message = ''

	readonly #mainScrollView = new ScrollView([], {
		height: 1,
		scrollbar: 'auto',
	})

	constructor(
		summary: RoadmapDetailSummary,
		tui: TUI,
		done: () => void,
		onControl?: (key: string, view: RoadmapDetailsView) => void,
	) {
		this.#summary = summary
		this.#tui = tui
		this.#done = done
		this.#onControl = onControl
	}

	setSummary(summary: RoadmapDetailSummary): void {
		this.#summary = summary
		this.#mainScrollView.scrollToTop()
		this.#tui.requestRender()
	}

	showMessage(message: string): void {
		this.#message = message
		this.#tui.requestRender()
	}

	handleInput(data: string): void {
		if (matchesKey(data, 'ctrl+c')) {
			this.#done()
			return
		}

		if (this.#summary.kind === 'active') {
			const key = data.toLowerCase()
			const control = this.#summary.availableControls.find((candidate) => candidate.key === key)
			if (control) {
				this.#message = ''
				if (!control.enabled) {
					this.showMessage(`[${control.key}] ${control.label} disabled: ${control.reason ?? 'unavailable'}`)
					return
				}
				this.#onControl?.(control.key, this)
				return
			}
		}

		if (this.#focus === 'rail') {
			if (matchesKey(data, 'escape') || matchesKey(data, 'esc')) {
				this.#done()
				return
			}
			if (matchesKey(data, 'enter') || matchesKey(data, 'return') || data === '\n') {
				this.#focus = 'main'
				this.#message = ''
				this.#tui.requestRender()
				return
			}
			if (matchesKey(data, 'up')) {
				this.#moveTab(-1)
				return
			}
			if (matchesKey(data, 'down')) {
				this.#moveTab(1)
				return
			}
			return
		}

		if (matchesKey(data, 'escape') || matchesKey(data, 'esc')) {
			this.#focus = 'rail'
			this.#tui.requestRender()
			return
		}

		if (this.#mainScrollView.handleScrollKey(data)) {
			this.#tui.requestRender()
		}
	}

	render(width: number): readonly string[] {
		const dims = getTuiRowsAndCols(this.#tui, width)

		const frame = renderRoadmapDetailsFrame({
			summary: this.#summary,
			width: dims.cols,
			height: dims.rows,
			scrollView: this.#mainScrollView,
			activeTabIndex: this.#activeTabIndex,
			focus: this.#focus,
			message: this.#message,
		})

		return fitFrameToTerminal(frame, dims.cols, dims.rows)
	}

	#moveTab(delta: number): void {
		this.#activeTabIndex = (this.#activeTabIndex + delta + TAB_NAMES.length) % TAB_NAMES.length
		this.#message = ''
		this.#mainScrollView.scrollToTop()
		this.#tui.requestRender()
	}
}
