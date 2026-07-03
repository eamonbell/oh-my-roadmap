import type {TUI} from '@oh-my-pi/pi-tui'
import {COLUMN_GAP, DETAILS_VIEW_HEIGHT, MIN_VIEW_HEIGHT, MIN_VIEW_WIDTH} from './constants'

export function renderColumns(left: string[], right: string[], leftWidth: number, rightWidth: number, height: number): string[] {
	const leftWrapped = left.flatMap((line) => wrapWords(line, leftWidth))
	const rightWrapped = right.flatMap((line) => wrapWords(line, rightWidth))
	const lines: string[] = []

	for (let index = 0; index < height; index++) {
		const leftLine = padAnsiToWidth(truncateAnsi(leftWrapped[index] ?? '', leftWidth), leftWidth)
		const rightLine = truncateAnsi(rightWrapped[index] ?? '', rightWidth)
		lines.push(`${leftLine}${' '.repeat(COLUMN_GAP)}${rightLine}`)
	}

	return lines
}

export function fitLinesToHeight(lines: string[], height: number): string[] {
	const result: string[] = []
	for (let index = 0; index < height; index++) result.push(lines[index] ?? '')
	return result
}

export function keyValueLines(key: string, value: string, contentWidth: number): string[] {
	const labelWidth = Math.min(18, Math.max(10, key.length + 1))
	const valueWidth = Math.max(1, contentWidth - labelWidth)
	const wrapped = wrapWords(styleValue(value), valueWidth)

	return wrapped.map((line, index) => {
		const label = index === 0 ? `${s.dim}${key.padEnd(labelWidth)}${s.reset}` : ' '.repeat(labelWidth)
		return `${label}${line}`
	})
}

export function arrowLines(text: string, contentWidth: number): string[] {
	return bulletLines(text, contentWidth, s.green, '>')
}

export function bulletLines(text: string, contentWidth: number, color: string, marker = '-'): string[] {
	return wrapWords(text, Math.max(1, contentWidth - 2)).map((line, index) =>
		`${index === 0 ? `${color}${marker}${s.reset} ` : '  '}${line}`,
	)
}

export function sectionHeader(title: string): string {
	return ` ${s.bold}${s.magenta}${title}${s.reset}`
}

export function styleValue(value: string): string {
	const lower = value.toLowerCase()

	if (['valid', 'open', 'complete', 'completed', 'done', 'active', 'healthy', 'passed', 'approved'].includes(lower)) {
		return `${s.green}${value}${s.reset}`
	}

	if (['invalid', 'closed', 'blocked', 'failed', 'error'].includes(lower)) {
		return `${s.red}${value}${s.reset}`
	}

	// In-flight states read as cyan so they stand apart from terminal green/red.
	if (['running', 'reviewing', 'implementing', 'in progress', 'workers_running', 'dispatching'].includes(lower)) {
		return `${s.cyan}${value}${s.reset}`
	}

	if (['inactive', 'none', 'not recorded', 'pending', 'todo', 'outline'].includes(lower)) {
		return `${s.dim}${value}${s.reset}`
	}

	if (['stale', 'attention', 'deferred', 'draft', 'adhoc_draft'].includes(lower)) {
		return `${s.yellow}${value}${s.reset}`
	}

	return value
	.replace(/\bvalid\b/gi, `${s.green}$&${s.reset}`)
	.replace(/\binvalid\b/gi, `${s.red}$&${s.reset}`)
	.replace(/\bopen\b/gi, `${s.green}$&${s.reset}`)
	.replace(/\bclosed\b/gi, `${s.red}$&${s.reset}`)
	.replace(/\bblocked\b/gi, `${s.red}$&${s.reset}`)
	.replace(/\bcomplete(?:d)?\b/gi, `${s.green}$&${s.reset}`)
	.replace(/\bpassed\b/gi, `${s.green}$&${s.reset}`)
	.replace(/\bapproved\b/gi, `${s.green}$&${s.reset}`)
	.replace(/\bfailed\b/gi, `${s.red}$&${s.reset}`)
	.replace(/\b(?:running|reviewing|implementing)\b/gi, `${s.cyan}$&${s.reset}`)
	.replace(/\bin progress\b/gi, `${s.cyan}$&${s.reset}`)
	.replace(/\b(?:pending|deferred)\b/gi, `${s.yellow}$&${s.reset}`)
}

export function row(text: string, width: number, align: 'left' | 'center' = 'left'): string {
	const contentWidth = Math.max(0, width - 4)
	const clipped = truncateAnsi(text, contentWidth)
	const used = visibleWidth(clipped)
	let leftPad = 0
	let rightPad = Math.max(0, contentWidth - used)

	if (align === 'center') {
		leftPad = Math.floor(rightPad / 2)
		rightPad -= leftPad
	}

	return `${s.dim}│${s.reset} ${' '.repeat(leftPad)}${clipped}${' '.repeat(rightPad)} ${s.dim}│${s.reset}`
}

export function topBorder(width: number, title: string): string {
	const used = visibleWidth(title)
	const remaining = Math.max(0, width - used - 2)
	return `${s.dim}╭${s.reset}${title}${s.dim}${'─'.repeat(remaining)}╮${s.reset}`
}

export function bottomBorder(width: number): string {
	return `${s.dim}╰${'─'.repeat(Math.max(0, width - 2))}╯${s.reset}`
}

export function divider(width: number): string {
	return `${s.dim}├${'─'.repeat(Math.max(0, width - 2))}┤${s.reset}`
}

export function fitFrameToTerminal(lines: readonly string[], width: number, height: number): string[] {
	const result: string[] = []

	for (let index = 0; index < height; index++) {
		const line = lines[index] ?? ''
		result.push(padAnsiToWidth(truncateAnsi(line, width), width))
	}

	return result
}

export function padAnsiToWidth(input: string, width: number): string {
	const padding = Math.max(0, width - visibleWidth(input))
	return `${input}${' '.repeat(padding)}`
}

export function getTuiRowsAndCols(tui: TUI, fallbackWidth: number): { rows: number; cols: number } {
	const terminal = (tui as unknown as { terminal?: { rows?: number; columns?: number } }).terminal
	return {
		rows: Math.max(MIN_VIEW_HEIGHT, Math.trunc(terminal?.rows ?? process.stdout.rows ?? DETAILS_VIEW_HEIGHT)),
		cols: Math.max(MIN_VIEW_WIDTH, Math.trunc(terminal?.columns ?? fallbackWidth ?? process.stdout.columns ?? MIN_VIEW_WIDTH)),
	}
}

export function wrapWords(input: string, width: number): string[] {
	if (width <= 0) return ['']
	if (visibleWidth(input) <= width) return [input]

	const words = input.split(/(\s+)/)
	const lines: string[] = []
	let current = ''

	for (const word of words) {
		if (!word) continue
		const next = current ? current + word : word.trimStart()

		if (visibleWidth(next) <= width) {
			current = next
			continue
		}

		if (current.trim()) {
			lines.push(current.trimEnd())
			current = word.trimStart()
			continue
		}

		const hardWrapped = hardWrap(word, width)
		lines.push(...hardWrapped.slice(0, -1))
		current = hardWrapped.at(-1) ?? ''
	}

	if (current.trim()) lines.push(current.trimEnd())
	return lines.length ? lines : ['']
}

export function hardWrap(input: string, width: number): string[] {
	const lines: string[] = []
	let remaining = input

	while (visibleWidth(remaining) > width) {
		const next = truncateAnsi(remaining, width)
		lines.push(next)
		remaining = stripVisiblePrefix(remaining, visibleWidth(next))
	}

	if (remaining) lines.push(remaining)
	return lines
}

export function truncateAnsi(input: string, maxWidth: number): string {
	if (maxWidth <= 0) return ''
	let output = ''
	let width = 0

	for (let index = 0; index < input.length; index++) {
		const char = input[index]

		if (char === '\u001b') {
			const match = input.slice(index).match(/^\u001b\[[0-9;]*m/)
			if (match) {
				output += match[0]
				index += match[0].length - 1
				continue
			}
		}

		if (width + 1 > maxWidth) break
		output += char
		width++
	}

	if (output.includes('\u001b[')) output += s.reset
	return output
}

export function stripVisiblePrefix(input: string, count: number): string {
	let consumed = 0

	for (let index = 0; index < input.length; index++) {
		const char = input[index]

		if (char === '\u001b') {
			const match = input.slice(index).match(/^\u001b\[[0-9;]*m/)
			if (match) {
				index += match[0].length - 1
				continue
			}
		}

		consumed++
		if (consumed >= count) return input.slice(index + 1)
	}

	return ''
}

export function visibleWidth(input: string): number {
	return stripAnsi(input).length
}

export function stripAnsi(input: string): string {
	return input.replace(/\u001b\[[0-9;]*m/g, '')
}

export const s = {
	reset: '\u001b[0m',
	bold: '\u001b[1m',
	dim: '\u001b[2m',
	red: '\u001b[31m',
	green: '\u001b[32m',
	yellow: '\u001b[33m',
	cyan: '\u001b[36m',
	magenta: '\u001b[35m',
} as const
