import {Component, matchesKey, ScrollView, TUI} from "@oh-my-pi/pi-tui";

const DETAILS_VIEW_HEIGHT = 24;
const MIN_VIEW_WIDTH = 30;
const MIN_VIEW_HEIGHT = 8;

export class RoadmapDetailsView implements Component {
	readonly #report: string;
	readonly #done: () => void;
	readonly #tui: TUI;

	readonly #scrollView = new ScrollView([], {
		height: 1,
		scrollbar: "auto",
	});

	constructor(report: string, tui: TUI, done: () => void) {
		this.#report = report;
		this.#tui = tui;
		this.#done = done;
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "esc") ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			matchesKey(data, "ctrl+c") ||
			data === "\n"
		) {
			this.#done();
			return;
		}

		if (this.#scrollView.handleScrollKey(data)) {
			this.#tui.requestRender();
		}
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(MIN_VIEW_WIDTH, Math.trunc(width || 80));
		const safeHeight = Math.max(MIN_VIEW_HEIGHT, getTuiRows(this.#tui));

		const frame = renderRoadmapReportFrame({
			report: this.#report,
			width: safeWidth,
			height: safeHeight,
			scrollView: this.#scrollView,
		});

		return fitFrameToTerminal(frame, safeWidth, safeHeight);
	}
}

type RenderRoadmapReportFrameOptions = {
	report: string;
	width: number;
	height: number;
	scrollView: ScrollView;
};

function renderRoadmapReportFrame(options: RenderRoadmapReportFrameOptions): string[] {
	const {report, width, height, scrollView} = options;

	const safeWidth = Math.max(MIN_VIEW_WIDTH, width);
	const safeHeight = Math.max(MIN_VIEW_HEIGHT, height);
	const contentWidth = Math.max(1, safeWidth - 4);

	const parsed = parseRoadmapReport(report);

	const headerLines = renderFixedHeader(parsed, safeWidth);
	const footerLines = renderFixedFooter(safeWidth);

	const scrollHeight = Math.max(1, safeHeight - headerLines.length - footerLines.length);

	scrollView.setHeight(scrollHeight);
	scrollView.setLines(renderScrollableBody(parsed, contentWidth));

	const scrolledBody = scrollView.render(contentWidth).map((line) => row(line, safeWidth));

	return [
		...headerLines,
		...scrolledBody,
		...footerLines,
	];
}

function renderFixedHeader(parsed: ParsedRoadmapReport, width: number): string[] {
	const lines: string[] = [];

	lines.push(topBorder(width, ` ${s.bold}${s.cyan}${parsed.title}${s.reset} `));
	lines.push(emptyRow(width));

	for (const item of parsed.summary) {
		lines.push(...renderKeyValueRows(item.key, item.value, width));
	}

	if (parsed.summary.length > 0) {
		lines.push(emptyRow(width));
	}

	lines.push(divider(width));

	return lines;
}

function renderFixedFooter(width: number): string[] {
	return [
		divider(width),
		row(`${s.dim}↑/↓ scroll  •  PgUp/PgDn jump  •  Esc/Enter close${s.reset}`, width, "center"),
		bottomBorder(width),
	];
}

function renderScrollableBody(parsed: ParsedRoadmapReport, contentWidth: number): string[] {
	const lines: string[] = [];

	for (const section of parsed.sections) {
		if (lines.length > 0) {
			lines.push("");
		}

		lines.push(sectionHeaderContent(section.title));

		for (const line of section.lines) {
			lines.push(...renderReportContentLine(line, contentWidth));
		}
	}

	if (parsed.nextAction) {
		if (lines.length > 0) {
			lines.push("");
		}

		lines.push(sectionHeaderContent("Next action"));

		for (const line of wrapWords(parsed.nextAction, Math.max(1, contentWidth - 2))) {
			lines.push(`${s.green}→${s.reset} ${line}`);
		}
	}

	if (lines.length === 0) {
		lines.push(`${s.dim}No roadmap details available.${s.reset}`);
	}

	return lines;
}

type ParsedRoadmapReport = {
	title: string;
	summary: Array<{ key: string; value: string }>;
	sections: Array<{ title: string; lines: string[] }>;
	nextAction: string | null;
};

function parseRoadmapReport(report: string): ParsedRoadmapReport {
	const rawLines = report.split("\n").map((line) => line.trimEnd());

	let title = "Roadmap Details";
	const summary: Array<{ key: string; value: string }> = [];
	const sections: Array<{ title: string; lines: string[] }> = [];

	let currentSection: { title: string; lines: string[] } | null = null;
	let nextAction: string | null = null;

	const pushSection = (sectionTitle: string): { title: string; lines: string[] } => {
		const section = {title: sectionTitle, lines: []};
		sections.push(section);
		currentSection = section;
		return section;
	};

	for (const rawLine of rawLines) {
		const line = rawLine.trim();

		if (!line) continue;

		if (line.startsWith("# ")) {
			title = toTitle(line.replace(/^#\s+/, ""));
			continue;
		}

		if (line.startsWith("Next action:")) {
			nextAction = line.replace(/^Next action:\s*/, "");
			continue;
		}

		const pair = splitKeyValue(line);

		if (pair && isSummaryKey(pair.key)) {
			summary.push(pair);
			continue;
		}

		if (pair && isSectionStart(pair.key)) {
			const section = pushSection(pair.key);
			section.lines.push(`${pair.key}: ${pair.value}`);
			continue;
		}

		if (!currentSection) {
			currentSection = pushSection("Details");
		}

		currentSection.lines.push(line);
	}

	return {
		title,
		summary,
		sections,
		nextAction,
	};
}

function splitKeyValue(line: string): { key: string; value: string } | null {
	const index = line.indexOf(":");
	if (index < 0) return null;

	const key = line.slice(0, index).trim();
	const value = line.slice(index + 1).trim();

	if (!key) return null;

	return {key, value};
}

function isSummaryKey(key: string): boolean {
	return [
		"Roadmap",
		"Phase",
		"Active milestone",
		"Active change request",
		"Bypass",
	].includes(key);
}

function isSectionStart(key: string): boolean {
	return [
		"Milestone status",
		"Change status",
		"Milestone closeout",
		"Validation",
		"Implementation gate",
	].includes(key);
}

function renderKeyValueRows(key: string, value: string, width: number): string[] {
	const contentWidth = Math.max(10, width - 4);
	const labelWidth = Math.min(24, Math.max(14, key.length + 1));
	const valueWidth = Math.max(10, contentWidth - labelWidth);

	const styledValue = styleValue(value);
	const wrapped = wrapWords(styledValue, valueWidth);

	return wrapped.map((line, index) => {
		const label = index === 0 ? `${s.dim}${key.padEnd(labelWidth)}${s.reset}` : " ".repeat(labelWidth);
		return row(`${label}${line}`, width);
	});
}

function renderReportContentLine(line: string, contentWidth: number): string[] {
	if (line.startsWith("- ERROR ")) {
		const message = line.replace(/^- ERROR\s+/, "");
		return wrapWords(message, Math.max(1, contentWidth - 2)).map((wrapped, index) =>
			`${index === 0 ? `${s.red}✖${s.reset} ` : "  "}${s.red}${wrapped}${s.reset}`,
		);
	}

	if (line.startsWith("- WARN ")) {
		const message = line.replace(/^- WARN\s+/, "");
		return wrapWords(message, Math.max(1, contentWidth - 2)).map((wrapped, index) =>
			`${index === 0 ? `${s.yellow}▲${s.reset} ` : "  "}${s.yellow}${wrapped}${s.reset}`,
		);
	}

	if (line.startsWith("- ")) {
		return wrapWords(line.slice(2), Math.max(1, contentWidth - 2)).map((wrapped, index) =>
			`${index === 0 ? `${s.cyan}•${s.reset} ` : "  "}${wrapped}`,
		);
	}

	const pair = splitKeyValue(line);
	if (pair) {
		return renderKeyValueContentLines(pair.key, pair.value, contentWidth);
	}

	return wrapWords(line, contentWidth);
}

function renderKeyValueContentLines(key: string, value: string, contentWidth: number): string[] {
	const labelWidth = Math.min(24, Math.max(14, key.length + 1));
	const valueWidth = Math.max(1, contentWidth - labelWidth);

	const styledValue = styleValue(value);
	const wrapped = wrapWords(styledValue, valueWidth);

	return wrapped.map((line, index) => {
		const label = index === 0 ? `${s.dim}${key.padEnd(labelWidth)}${s.reset}` : " ".repeat(labelWidth);
		return `${label}${line}`;
	});
}

function sectionHeaderContent(title: string): string {
	return ` ${s.bold}${s.magenta}${toTitle(title)}${s.reset}`;
}

function styleValue(value: string): string {
	const lower = value.toLowerCase();

	if (["valid", "open", "complete", "completed", "done", "active"].includes(lower)) {
		return `${s.green}${value}${s.reset}`;
	}

	if (["invalid", "closed", "blocked", "failed", "error"].includes(lower)) {
		return `${s.red}${value}${s.reset}`;
	}

	if (["inactive", "none", "not recorded", "pending", "todo"].includes(lower)) {
		return `${s.dim}${value}${s.reset}`;
	}

	return value
	.replace(/\bvalid\b/gi, `${s.green}$&${s.reset}`)
	.replace(/\binvalid\b/gi, `${s.red}$&${s.reset}`)
	.replace(/\bopen\b/gi, `${s.green}$&${s.reset}`)
	.replace(/\bclosed\b/gi, `${s.red}$&${s.reset}`)
	.replace(/\bblocked\b/gi, `${s.red}$&${s.reset}`)
	.replace(/\bcomplete(?:d)?\b/gi, `${s.green}$&${s.reset}`)
	.replace(/\bin progress\b/gi, `${s.cyan}$&${s.reset}`)
	.replace(/\bpending\b/gi, `${s.yellow}$&${s.reset}`);
}

function row(text: string, width: number, align: "left" | "center" = "left"): string {
	const contentWidth = Math.max(0, width - 4);
	const clipped = truncateAnsi(text, contentWidth);
	const used = visibleWidth(clipped);

	let leftPad = 0;
	let rightPad = Math.max(0, contentWidth - used);

	if (align === "center") {
		leftPad = Math.floor(rightPad / 2);
		rightPad -= leftPad;
	}

	return `${s.dim}│${s.reset} ${" ".repeat(leftPad)}${clipped}${" ".repeat(rightPad)} ${s.dim}│${s.reset}`;
}

function emptyRow(width: number): string {
	return row("", width);
}

function topBorder(width: number, title: string): string {
	const used = visibleWidth(title);
	const remaining = Math.max(0, width - used - 2);
	return `${s.dim}╭${s.reset}${title}${s.dim}${"─".repeat(remaining)}╮${s.reset}`;
}

function bottomBorder(width: number): string {
	return `${s.dim}╰${"─".repeat(Math.max(0, width - 2))}╯${s.reset}`;
}

function divider(width: number): string {
	return `${s.dim}├${"─".repeat(Math.max(0, width - 2))}┤${s.reset}`;
}

function fitFrameToTerminal(lines: readonly string[], width: number, height: number): string[] {
	const result: string[] = [];

	for (let index = 0; index < height; index++) {
		const line = lines[index] ?? "";
		result.push(padAnsiToWidth(truncateAnsi(line, width), width));
	}

	return result;
}

function padAnsiToWidth(input: string, width: number): string {
	const padding = Math.max(0, width - visibleWidth(input));
	return `${input}${" ".repeat(padding)}`;
}

function getTuiRows(tui: TUI): number {
	const terminal = (tui as unknown as { terminal?: { rows?: number } }).terminal;

	return terminal?.rows ?? process.stdout.rows ?? DETAILS_VIEW_HEIGHT;
}

function wrapWords(input: string, width: number): string[] {
	if (width <= 0) return [""];
	if (visibleWidth(input) <= width) return [input];

	const words = input.split(/(\s+)/);
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (!word) continue;

		const next = current ? current + word : word.trimStart();

		if (visibleWidth(next) <= width) {
			current = next;
			continue;
		}

		if (current.trim()) {
			lines.push(current.trimEnd());
			current = word.trimStart();
			continue;
		}

		const hardWrapped = hardWrap(word, width);
		lines.push(...hardWrapped.slice(0, -1));
		current = hardWrapped.at(-1) ?? "";
	}

	if (current.trim()) {
		lines.push(current.trimEnd());
	}

	return lines.length ? lines : [""];
}

function hardWrap(input: string, width: number): string[] {
	const lines: string[] = [];
	let remaining = input;

	while (visibleWidth(remaining) > width) {
		const next = truncateAnsi(remaining, width);
		lines.push(next);
		remaining = stripVisiblePrefix(remaining, visibleWidth(next));
	}

	if (remaining) {
		lines.push(remaining);
	}

	return lines;
}

function truncateAnsi(input: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";

	let output = "";
	let width = 0;

	for (let index = 0; index < input.length; index++) {
		const char = input[index];

		if (char === "\u001b") {
			const match = input.slice(index).match(/^\u001b\[[0-9;]*m/);
			if (match) {
				output += match[0];
				index += match[0].length - 1;
				continue;
			}
		}

		if (width + 1 > maxWidth) break;

		output += char;
		width++;
	}

	if (output.includes("\u001b[")) {
		output += s.reset;
	}

	return output;
}

function stripVisiblePrefix(input: string, count: number): string {
	let consumed = 0;

	for (let index = 0; index < input.length; index++) {
		const char = input[index];

		if (char === "\u001b") {
			const match = input.slice(index).match(/^\u001b\[[0-9;]*m/);
			if (match) {
				index += match[0].length - 1;
				continue;
			}
		}

		consumed++;

		if (consumed >= count) {
			return input.slice(index + 1);
		}
	}

	return "";
}

function visibleWidth(input: string): number {
	return stripAnsi(input).length;
}

function stripAnsi(input: string): string {
	return input.replace(/\u001b\[[0-9;]*m/g, "");
}

function toTitle(input: string): string {
	return input
	.replace(/[-_]/g, " ")
	.replace(/\s+/g, " ")
	.trim()
	.replace(/\b\w/g, (char) => char.toUpperCase());
}

const s = {
	reset: "\u001b[0m",
	bold: "\u001b[1m",
	dim: "\u001b[2m",
	red: "\u001b[31m",
	green: "\u001b[32m",
	yellow: "\u001b[33m",
	cyan: "\u001b[36m",
	magenta: "\u001b[35m",
} as const;