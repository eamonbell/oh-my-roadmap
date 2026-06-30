import { Component, matchesKey, ScrollView, TUI } from "@oh-my-pi/pi-tui";
import type {
  ActiveRoadmapDetailSummary,
  RoadmapDetailBlocker,
  RoadmapDetailIssue,
  RoadmapDetailSummary,
  RoadmapDetailTask,
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
  readonly #tui: TUI;

  readonly #scrollView = new ScrollView([], {
    height: 1,
    scrollbar: "auto",
  });

  constructor(summary: RoadmapDetailSummary, tui: TUI, done: () => void) {
    this.#summary = summary;
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
    ...keyValueLines("Validation", summary.validation.status, RAIL_WIDTH),
    ...keyValueLines("Gate", summary.gate.status, RAIL_WIDTH),
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
    ...arrowLines(summary.nextAction, contentWidth),
    "",
    sectionHeader("Active Work"),
    ...renderActiveWork(summary, contentWidth),
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

function renderActiveWork(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  const lines = [
    ...keyValueLines("Active wave", summary.waves.active?.label ?? "none", contentWidth),
    ...keyValueLines("Wave counts", waveCountsLabel(summary), contentWidth),
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

  const lines = [
    ...keyValueLines("Roadmap", summary.usage.roadmap.label, contentWidth),
    ...keyValueLines("Top agents", summary.usage.topAgentsLabel, contentWidth),
  ];

  if (summary.usage.milestone) {
    lines.push(...keyValueLines(`Milestone ${summary.usage.milestone.id}`, summary.usage.milestone.totals.label, contentWidth));
    lines.push(...keyValueLines("Milestone agents", summary.usage.milestone.topAgentsLabel, contentWidth));
  }

  if (summary.usage.changeRequest) {
    lines.push(...keyValueLines(`Change ${summary.usage.changeRequest.id}`, summary.usage.changeRequest.totals.label, contentWidth));
    lines.push(...keyValueLines("Change agents", summary.usage.changeRequest.topAgentsLabel, contentWidth));
  }

  return lines;
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
