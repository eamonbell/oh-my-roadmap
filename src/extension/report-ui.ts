import { Component, matchesKey, ScrollView, TUI } from "@oh-my-pi/pi-tui";
import type {
  ActiveRoadmapDetailSummary,
  RoadmapDetailBlocker,
  RoadmapDetailControl,
  RoadmapDetailEvent,
  RoadmapDetailIssue,
  RoadmapDetailSummary,
  RoadmapDetailTask,
  RoadmapDetailUsageTotals,
} from "../core/roadmap-detail-summary";

export type { RoadmapDetailSummary } from "../core/roadmap-detail-summary";

const DETAILS_VIEW_HEIGHT = 24;
const MIN_VIEW_WIDTH = 30;
const MIN_VIEW_HEIGHT = 8;
const WIDE_LAYOUT_WIDTH = 92;
const RAIL_WIDTH = 28;
const COLUMN_GAP = 2;
const EMPTY_NEXT_ACTION = "Create a roadmap with /roadmap:new.";

export class RoadmapDetailsView implements Component {
  readonly #summary: RoadmapDetailSummary;
  readonly #done: () => void;
  readonly #onControl: ((key: string) => void) | undefined;
  readonly #tui: TUI;

  readonly #scrollView = new ScrollView([], {
    height: 1,
    scrollbar: "auto",
  });

  constructor(summary: RoadmapDetailSummary, tui: TUI, done: () => void, onControl?: (key: string) => void) {
    this.#summary = summary;
    this.#tui = tui;
    this.#done = done;
    this.#onControl = onControl;
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

    if (this.#summary.kind === "active") {
      const key = data.toLowerCase();
      const control = this.#summary.availableControls.find((candidate) => candidate.key === key);
      if (control) {
        this.#onControl?.(control.key);
        return;
      }
    }

    if (this.#scrollView.handleScrollKey(data)) {
      this.#tui.requestRender();
    }
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(MIN_VIEW_WIDTH, Math.trunc(width || 80));
    const safeHeight = Math.max(MIN_VIEW_HEIGHT, getTuiRows(this.#tui));

    const frame = renderRoadmapDetailsFrame({
      summary: this.#summary,
      width: safeWidth,
      height: safeHeight,
      scrollView: this.#scrollView,
    });

    return fitFrameToTerminal(frame, safeWidth, safeHeight);
  }
}

type RenderRoadmapDetailsFrameOptions = {
  summary: RoadmapDetailSummary;
  width: number;
  height: number;
  scrollView: ScrollView;
};

export function renderRoadmapDetailsFrame(options: RenderRoadmapDetailsFrameOptions): string[] {
  const { summary, width, height, scrollView } = options;
  const safeWidth = Math.max(MIN_VIEW_WIDTH, width);
  const safeHeight = Math.max(MIN_VIEW_HEIGHT, height);
  const contentWidth = Math.max(1, safeWidth - 4);
  const headerLines = renderFixedHeader(summary, safeWidth);
  const footerLines = renderFixedFooter(safeWidth);
  const scrollHeight = Math.max(1, safeHeight - headerLines.length - footerLines.length);

  scrollView.setHeight(scrollHeight);
  scrollView.setLines(renderScrollableBody(summary, contentWidth));

  return [
    ...headerLines,
    ...scrollView.render(contentWidth).map((line) => row(line, safeWidth)),
    ...footerLines,
  ];
}

function renderFixedHeader(summary: RoadmapDetailSummary, width: number): string[] {
  if (summary.kind === "empty") {
    return [
      topBorder(width, ` ${s.bold}${s.cyan}Roadmap Details${s.reset} `),
      row(`${s.dim}No active roadmap${s.reset}`, width),
      divider(width),
    ];
  }

  return [
    topBorder(width, ` ${s.bold}${s.cyan}${summary.roadmap.title}${s.reset} `),
    row(`${summary.roadmap.id}  ${s.dim}phase${s.reset} ${styleValue(summary.roadmap.phase)}`, width),
    divider(width),
  ];
}

function renderFixedFooter(width: number): string[] {
  return [
    divider(width),
    row(`${s.dim}↑/↓ scroll  •  PgUp/PgDn jump  •  Esc/Enter close${s.reset}`, width, "center"),
    bottomBorder(width),
  ];
}

function renderScrollableBody(summary: RoadmapDetailSummary, contentWidth: number): string[] {
  if (summary.kind === "empty") {
    return [
      sectionHeader("Next Action"),
      ...arrowLines(EMPTY_NEXT_ACTION, contentWidth),
      "",
      sectionHeader("Status"),
      ...wrapWords(summary.message, contentWidth),
    ];
  }

  const mainWidth = contentWidth >= WIDE_LAYOUT_WIDTH
    ? Math.max(20, contentWidth - RAIL_WIDTH - COLUMN_GAP)
    : contentWidth;
  const rail = renderHealthRail(summary);
  const main = renderMainDetails(summary, mainWidth);

  if (contentWidth >= WIDE_LAYOUT_WIDTH) {
    return renderColumns(rail, main, mainWidth);
  }

  return [
    ...rail,
    "",
    ...main,
  ];
}

function renderHealthRail(summary: ActiveRoadmapDetailSummary): string[] {
  return [
    sectionHeader("Health"),
    ...keyValueLines("Roadmap", summary.roadmap.label, RAIL_WIDTH),
    ...keyValueLines("Phase", summary.roadmap.phase, RAIL_WIDTH),
    ...keyValueLines("Quality gate", summary.qualityGate.status, RAIL_WIDTH),
    ...keyValueLines("Validation", summary.validation.status, RAIL_WIDTH),
    ...keyValueLines("Gate", summary.gate.status, RAIL_WIDTH),
    ...keyValueLines("Open blockers", String(summary.roadmapHealth.openBlockerCount), RAIL_WIDTH),
    ...keyValueLines("Issues", issueCountLabel(summary), RAIL_WIDTH),
    "",
    sectionHeader("Context"),
    ...keyValueLines("Milestone", summary.active.milestone?.label ?? "none", RAIL_WIDTH),
    ...keyValueLines("Change", summary.active.changeRequest?.label ?? "none", RAIL_WIDTH),
    ...keyValueLines("Bypass", summary.bypass.label, RAIL_WIDTH),
  ];
}

function renderMainDetails(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  return [
    sectionHeader("Next Action"),
    ...renderNextAction(summary, contentWidth),
    "",
    sectionHeader("Active Work"),
    ...renderActiveWork(summary, contentWidth),
    "",
    sectionHeader("Controls"),
    ...renderControls(summary.availableControls, contentWidth),
    "",
    sectionHeader("Quality Gate"),
    ...renderQualityGate(summary, contentWidth),
    "",
    sectionHeader("Blockers"),
    ...renderCanonicalBlockers(summary, contentWidth),
    "",
    sectionHeader("Recent Events"),
    ...renderEvents(summary.recentEvents, contentWidth),
    "",
    sectionHeader("Issues"),
    ...renderIssues(summary, contentWidth),
    "",
    sectionHeader("Usage"),
    ...renderUsage(summary, contentWidth),
    "",
    sectionHeader("Metadata"),
    ...keyValueLines("Roadmap", summary.roadmap.label, contentWidth),
    ...keyValueLines("Active milestone", summary.active.milestone?.label ?? "none", contentWidth),
    ...keyValueLines("Active change", summary.active.changeRequest?.label ?? "none", contentWidth),
    ...keyValueLines("Bypass", summary.bypass.label, contentWidth),
  ];
}

function renderNextAction(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  const next = summary.nextAction;
  const lines = [
    ...arrowLines(`${next.label}: ${next.description}`, contentWidth),
    ...keyValueLines("Status", next.status, contentWidth),
    ...keyValueLines("Safe", next.safe_to_apply ? "yes" : "no", contentWidth),
  ];
  if (next.blockers.length > 0) lines.push(...keyValueLines("Blockers", next.blockers.join("; "), contentWidth));
  if (next.missing_inputs.length > 0) lines.push(...keyValueLines("Missing", next.missing_inputs.join("; "), contentWidth));
  if (next.tool) lines.push(...keyValueLines("Tool", `${next.tool.name} ${JSON.stringify(next.tool.input)}`, contentWidth));
  return lines;
}

function renderActiveWork(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  const lines = [
    ...keyValueLines("Active wave", summary.waves.active?.label ?? "none", contentWidth),
    ...keyValueLines("Progress", summary.activeExecution?.progressStep ?? "none", contentWidth),
    ...keyValueLines("Wave counts", waveCountsLabel(summary), contentWidth),
    ...keyValueLines("Task counts", taskCountsLabel(summary), contentWidth),
    ...keyValueLines("Blockers", summary.blockers.length > 0 ? String(summary.blockers.length) : "none", contentWidth),
  ];

  if (summary.activeTasks.length === 0) {
    lines.push(`${s.dim}No active tasks.${s.reset}`);
  } else {
    lines.push(`${s.dim}Active tasks${s.reset}`);
    lines.push(...summary.activeTasks.flatMap((task) => taskLines(task, contentWidth)));
  }

  if (summary.blockers.length > 0) {
    lines.push(`${s.dim}Blockers${s.reset}`);
    lines.push(...summary.blockers.flatMap((blocker) => blockerLines(blocker, contentWidth)));
  }

  return lines;
}

function renderQualityGate(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  const gate = summary.qualityGate;
  const lines = [
    ...keyValueLines("Status", gate.status, contentWidth),
    ...keyValueLines("Revision", `${gate.checkedRevision}/${gate.roadmapRevision}`, contentWidth),
    ...keyValueLines("Event", gate.eventId ?? "none", contentWidth),
  ];

  if (gate.latestFinding) {
    lines.push(...keyValueLines("Finding", gate.latestFinding, contentWidth));
  }
  if (gate.history.length > 0) {
    lines.push(`${s.dim}History${s.reset}`);
    lines.push(...gate.history.flatMap((event) => eventLines(event, contentWidth)));
  }

  return lines;
}

function renderControls(controls: RoadmapDetailControl[], contentWidth: number): string[] {
  if (controls.length === 0) return [`${s.dim}No controls available.${s.reset}`];
  return controls.flatMap((control) => {
    const status = control.enabled ? "enabled" : `disabled: ${control.reason ?? "unavailable"}`;
    const text = `[${control.key}] ${control.label} (${status})`;
    const lines = bulletLines(text, contentWidth, control.enabled ? s.cyan : s.dim);
    if (control.tool) {
      lines.push(...keyValueLines("Tool", `${control.tool.name} ${JSON.stringify(control.tool.input)}`, contentWidth));
    }
    if (control.prompt) {
      const firstLine = control.prompt.split("\n")[0] ?? control.prompt;
      lines.push(...keyValueLines("Insert", firstLine, contentWidth));
    }
    return lines;
  });
}

function renderCanonicalBlockers(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  const counts = summary.canonicalBlockers.counts;
  const lines = [
    ...keyValueLines("Counts", `open ${counts.open}, resolved ${counts.resolved}, deferred ${counts.deferred}`, contentWidth),
  ];
  if (summary.canonicalBlockers.open.length === 0) {
    lines.push(`${s.green}✓${s.reset} No open canonical blockers.`);
    return lines;
  }
  lines.push(...summary.canonicalBlockers.open.flatMap((blocker) =>
    bulletLines(`${blocker.label}; scope ${JSON.stringify(blocker.scope)}`, contentWidth, s.red)
  ));
  return lines;
}

function renderEvents(events: RoadmapDetailEvent[], contentWidth: number): string[] {
  if (events.length === 0) return [`${s.dim}No recent events.${s.reset}`];
  return events.flatMap((event) => eventLines(event, contentWidth));
}

function eventLines(event: RoadmapDetailEvent, contentWidth: number): string[] {
  return bulletLines(`${event.at} ${event.type} ${event.id}: ${event.summary}`, contentWidth, s.dim);
}

function renderIssues(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  const issues: RoadmapDetailIssue[] = [
    ...summary.validation.issues,
    ...summary.gate.issues,
  ];

  if (issues.length === 0) return [`${s.green}✓${s.reset} No validation or gate issues.`];

  return issues.flatMap((issue) => {
    const tone = issue.severity === "warning" ? s.yellow : s.red;
    const icon = issue.severity === "warning" ? "▲" : "✖";
    return wrapWords(`${issue.code}: ${issue.message}`, Math.max(1, contentWidth - 2)).map((line, index) =>
      `${index === 0 ? `${tone}${icon}${s.reset} ` : "  "}${tone}${line}${s.reset}`,
    );
  });
}

function renderUsage(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  if (!summary.usage) return [`${s.dim}No usage recorded.${s.reset}`];

  const rows = [
    usageRow("Roadmap", summary.usage.roadmap, summary.usage.topAgentsLabel),
  ];

  if (summary.usage.milestone) {
    rows.push(usageRow(`Milestone ${summary.usage.milestone.id}`, summary.usage.milestone.totals, summary.usage.milestone.topAgentsLabel));
  }

  if (summary.usage.changeRequest) {
    rows.push(usageRow(`Change ${summary.usage.changeRequest.id}`, summary.usage.changeRequest.totals, summary.usage.changeRequest.topAgentsLabel));
  }

  return contentWidth < 84
    ? renderCompactUsageTable(rows, contentWidth)
    : renderUsageTable(rows, contentWidth);
}

type UsageTableRow = {
  scope: string;
  cost: string;
  requests: string;
  tokens: string;
  agents: string;
  details: string;
};

function usageRow(
  scope: string,
  totals: RoadmapDetailUsageTotals,
  agents: string,
): UsageTableRow {
  return {
    scope,
    cost: totals.costLabel,
    requests: String(totals.raw.requests),
    tokens: String(totals.totalTokens),
    agents,
    details: totals.label,
  };
}

function renderUsageTable(rows: UsageTableRow[], contentWidth: number): string[] {
  const scopeWidth = Math.min(18, Math.max(10, Math.floor(contentWidth * 0.22)));
  const costWidth = 12;
  const requestsWidth = 5;
  const tokensWidth = 8;
  const separatorWidth = 12;
  const agentsWidth = Math.max(10, contentWidth - scopeWidth - costWidth - requestsWidth - tokensWidth - separatorWidth);
  const lines = [
    tableRow(["Scope", "Cost", "Req", "Tokens", "Top agents"], [scopeWidth, costWidth, requestsWidth, tokensWidth, agentsWidth], true),
    tableDivider([scopeWidth, costWidth, requestsWidth, tokensWidth, agentsWidth]),
  ];

  for (const row of rows) {
    lines.push(...wrappedTableRow(
      [row.scope, row.cost, row.requests, row.tokens, row.agents],
      [scopeWidth, costWidth, requestsWidth, tokensWidth, agentsWidth],
    ));
  }

  return lines;
}

function renderCompactUsageTable(rows: UsageTableRow[], contentWidth: number): string[] {
  const scopeWidth = Math.min(18, Math.max(10, Math.floor(contentWidth * 0.34)));
  const detailsWidth = Math.max(10, contentWidth - scopeWidth - 3);
  const lines = [
    tableRow(["Scope", "Usage"], [scopeWidth, detailsWidth], true),
    tableDivider([scopeWidth, detailsWidth]),
  ];

  for (const row of rows) {
    lines.push(...wrappedTableRow(
      [row.scope, `${row.details}; agents ${row.agents}`],
      [scopeWidth, detailsWidth],
    ));
  }

  return lines;
}

function wrappedTableRow(values: string[], widths: number[]): string[] {
  const wrappedCells = values.map((value, index) => wrapWords(value, widths[index] ?? 1));
  const rowCount = Math.max(...wrappedCells.map((cell) => cell.length));
  const rows: string[] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    rows.push(tableRow(
      wrappedCells.map((cell) => cell[rowIndex] ?? ""),
      widths,
      false,
    ));
  }

  return rows;
}

function tableRow(values: string[], widths: number[], header: boolean): string {
  const cells = values.map((value, index) => padAnsiToWidth(truncateAnsi(value, widths[index] ?? 1), widths[index] ?? 1));
  const line = cells.join(`${s.dim} │ ${s.reset}`);
  return header ? `${s.dim}${line}${s.reset}` : line;
}

function tableDivider(widths: number[]): string {
  return `${s.dim}${widths.map((width) => "─".repeat(width)).join("─┼─")}${s.reset}`;
}

function taskLines(task: RoadmapDetailTask, contentWidth: number): string[] {
  return bulletLines(`${task.id} [${task.worker}, ${task.status}] ${task.title}`, contentWidth, s.cyan);
}

function blockerLines(blocker: RoadmapDetailBlocker, contentWidth: number): string[] {
  return bulletLines(`${blocker.label}: ${blocker.message}`, contentWidth, s.red);
}

function renderColumns(left: string[], right: string[], rightWidth: number): string[] {
  const leftWrapped = left.flatMap((line) => wrapWords(line, RAIL_WIDTH));
  const rightWrapped = right.flatMap((line) => wrapWords(line, rightWidth));
  const lineCount = Math.max(leftWrapped.length, rightWrapped.length);
  const lines: string[] = [];

  for (let index = 0; index < lineCount; index++) {
    const leftLine = padAnsiToWidth(truncateAnsi(leftWrapped[index] ?? "", RAIL_WIDTH), RAIL_WIDTH);
    const rightLine = truncateAnsi(rightWrapped[index] ?? "", rightWidth);
    lines.push(`${leftLine}${" ".repeat(COLUMN_GAP)}${rightLine}`);
  }

  return lines;
}

function keyValueLines(key: string, value: string, contentWidth: number): string[] {
  const labelWidth = Math.min(18, Math.max(10, key.length + 1));
  const valueWidth = Math.max(1, contentWidth - labelWidth);
  const wrapped = wrapWords(styleValue(value), valueWidth);

  return wrapped.map((line, index) => {
    const label = index === 0 ? `${s.dim}${key.padEnd(labelWidth)}${s.reset}` : " ".repeat(labelWidth);
    return `${label}${line}`;
  });
}

function arrowLines(text: string, contentWidth: number): string[] {
  return bulletLines(text, contentWidth, s.green, "→");
}

function bulletLines(text: string, contentWidth: number, color: string, marker = "•"): string[] {
  return wrapWords(text, Math.max(1, contentWidth - 2)).map((line, index) =>
    `${index === 0 ? `${color}${marker}${s.reset} ` : "  "}${line}`,
  );
}

function sectionHeader(title: string): string {
  return ` ${s.bold}${s.magenta}${title}${s.reset}`;
}

function issueCountLabel(summary: ActiveRoadmapDetailSummary): string {
  const errors = summary.validation.errors.length + summary.gate.errors.length;
  const warnings = summary.validation.warnings.length + summary.gate.warnings.length;
  return `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
}

function waveCountsLabel(summary: ActiveRoadmapDetailSummary): string {
  const { counts, total } = summary.waves;
  if (total === 0) return "none";
  return [
    `pending ${counts.pending}`,
    `running ${counts.running}`,
    `reviewing ${counts.reviewing}`,
    `blocked ${counts.blocked}`,
    `complete ${counts.complete}`,
  ].join(", ");
}

function taskCountsLabel(summary: ActiveRoadmapDetailSummary): string {
  const counts = summary.activeExecution?.taskCounts;
  if (!counts) return "none";
  return [
    `assigned ${counts.assigned}`,
    `started ${counts.started}`,
    `done ${counts.done}`,
    `blocked ${counts.blocked}`,
  ].join(", ");
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

  if (lower === "stale") {
    return `${s.yellow}${value}${s.reset}`;
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

  if (current.trim()) lines.push(current.trimEnd());
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

  if (remaining) lines.push(remaining);
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

  if (output.includes("\u001b[")) output += s.reset;
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
    if (consumed >= count) return input.slice(index + 1);
  }

  return "";
}

function visibleWidth(input: string): number {
  return stripAnsi(input).length;
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, "");
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
