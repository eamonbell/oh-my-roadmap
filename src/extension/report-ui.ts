import { Component, matchesKey, ScrollView, TUI } from "@oh-my-pi/pi-tui";
import type {
  ActiveRoadmapDetailSummary,
  RoadmapDetailBlocker,
  RoadmapDetailControl,
  RoadmapDetailEvent,
  RoadmapDetailIssue,
  RoadmapDetailMilestone,
  RoadmapDetailPlanWave,
  RoadmapDetailSummary,
  RoadmapDetailTask,
  RoadmapDetailUsageAgent,
  RoadmapDetailUsageTotals,
} from "../core/roadmap-detail-summary";

export type { RoadmapDetailSummary } from "../core/roadmap-detail-summary";

const DETAILS_VIEW_HEIGHT = 24;
const MIN_VIEW_WIDTH = 30;
const MIN_VIEW_HEIGHT = 8;
const MIN_RAIL_WIDTH = 24;
const MIN_MAIN_WIDTH = 44;
const COLUMN_GAP = 2;
const EMPTY_NEXT_ACTION = "Create a roadmap with /roadmap:new.";
const TAB_NAMES = ["Overview", "Plan", "Gates", "Usage", "Activity"] as const;

type FocusArea = "rail" | "main";
type TabName = (typeof TAB_NAMES)[number];

export class RoadmapDetailsView implements Component {
  #summary: RoadmapDetailSummary;
  readonly #done: () => void;
  readonly #onControl: ((key: string, view: RoadmapDetailsView) => void) | undefined;
  readonly #tui: TUI;
  #focus: FocusArea = "rail";
  #activeTabIndex = 0;
  #message = "";

  readonly #mainScrollView = new ScrollView([], {
    height: 1,
    scrollbar: "auto",
  });

  constructor(
    summary: RoadmapDetailSummary,
    tui: TUI,
    done: () => void,
    onControl?: (key: string, view: RoadmapDetailsView) => void,
  ) {
    this.#summary = summary;
    this.#tui = tui;
    this.#done = done;
    this.#onControl = onControl;
  }

  setSummary(summary: RoadmapDetailSummary): void {
    this.#summary = summary;
    this.#mainScrollView.scrollToTop();
    this.#tui.requestRender();
  }

  showMessage(message: string): void {
    this.#message = message;
    this.#tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.#done();
      return;
    }

    if (this.#summary.kind === "active") {
      const key = data.toLowerCase();
      const control = this.#summary.availableControls.find((candidate) => candidate.key === key);
      if (control) {
        this.#message = "";
        if (!control.enabled) {
          this.showMessage(`[${control.key}] ${control.label} disabled: ${control.reason ?? "unavailable"}`);
          return;
        }
        this.#onControl?.(control.key, this);
        return;
      }
    }

    if (this.#focus === "rail") {
      if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
        this.#done();
        return;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
        this.#focus = "main";
        this.#message = "";
        this.#tui.requestRender();
        return;
      }
      if (matchesKey(data, "up")) {
        this.#moveTab(-1);
        return;
      }
      if (matchesKey(data, "down")) {
        this.#moveTab(1);
        return;
      }
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
      this.#focus = "rail";
      this.#tui.requestRender();
      return;
    }

    if (this.#mainScrollView.handleScrollKey(data)) {
      this.#tui.requestRender();
    }
  }

  render(width: number): readonly string[] {
    const dims = getTuiRowsAndCols(this.#tui, width);

    const frame = renderRoadmapDetailsFrame({
      summary: this.#summary,
      width: dims.cols,
      height: dims.rows,
      scrollView: this.#mainScrollView,
      activeTabIndex: this.#activeTabIndex,
      focus: this.#focus,
      message: this.#message,
    });

    return fitFrameToTerminal(frame, dims.cols, dims.rows);
  }

  #moveTab(delta: number): void {
    this.#activeTabIndex = (this.#activeTabIndex + delta + TAB_NAMES.length) % TAB_NAMES.length;
    this.#message = "";
    this.#mainScrollView.scrollToTop();
    this.#tui.requestRender();
  }
}

type RenderRoadmapDetailsFrameOptions = {
  summary: RoadmapDetailSummary;
  width: number;
  height: number;
  scrollView: ScrollView;
  activeTabIndex?: number;
  focus?: FocusArea;
  message?: string;
};

export function renderRoadmapDetailsFrame(options: RenderRoadmapDetailsFrameOptions): string[] {
  const { summary, width, height, scrollView } = options;
  const safeWidth = Math.max(MIN_VIEW_WIDTH, Math.trunc(width || MIN_VIEW_WIDTH));
  const safeHeight = Math.max(MIN_VIEW_HEIGHT, Math.trunc(height || DETAILS_VIEW_HEIGHT));
  const contentWidth = Math.max(1, safeWidth - 4);
  const activeTabIndex = clampTabIndex(options.activeTabIndex ?? 0);
  const focus = options.focus ?? "rail";
  const message = options.message ?? "";
  const headerLines = renderFixedHeader(summary, safeWidth);
  const footerLines = renderFixedFooter(focus, safeWidth);
  const bodyHeight = Math.max(1, safeHeight - headerLines.length - footerLines.length);
  const body = renderBody({
    summary,
    contentWidth,
    bodyHeight,
    scrollView,
    activeTabIndex,
    focus,
    message,
  });

  return [
    ...headerLines,
    ...body.map((line) => row(line, safeWidth)),
    ...footerLines,
  ];
}

function clampTabIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(TAB_NAMES.length - 1, Math.trunc(index)));
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

function renderFixedFooter(focus: FocusArea, width: number): string[] {
  const railKeys = "Rail: ↑/↓ tabs  Enter main  Esc close";
  const mainKeys = "Main: ↑/↓ scroll  PgUp/PgDn jump  Esc rail  Ctrl+C close";
  return [
    divider(width),
    row(`${s.dim}${focus === "rail" ? railKeys : mainKeys}${s.reset}`, width, "center"),
    bottomBorder(width),
  ];
}

type RenderBodyOptions = {
  summary: RoadmapDetailSummary;
  contentWidth: number;
  bodyHeight: number;
  scrollView: ScrollView;
  activeTabIndex: number;
  focus: FocusArea;
  message: string;
};

function renderBody(options: RenderBodyOptions): string[] {
  const { summary, contentWidth, bodyHeight, scrollView, activeTabIndex, focus, message } = options;
  if (summary.kind === "empty") {
    scrollView.setHeight(bodyHeight);
    scrollView.setLines([
      sectionHeader("Next Action"),
      ...arrowLines(EMPTY_NEXT_ACTION, contentWidth),
      "",
      sectionHeader("Status"),
      ...wrapWords(summary.message, contentWidth),
    ]);
    return scrollView.render(contentWidth) as string[];
  }

  const layout = computeColumnLayout(contentWidth);
  const mainLines = renderTabContent(summary, TAB_NAMES[activeTabIndex] ?? "Overview", layout.mode === "columns" ? layout.mainWidth : layout.contentWidth);
  const statusLines = message ? [`${s.yellow}${message}${s.reset}`, ""] : [];
  const visibleMainHeight = Math.max(1, layout.mode === "columns" ? bodyHeight : bodyHeight - renderRail(summary, activeTabIndex, focus, layout.contentWidth).length - 1);
  scrollView.setHeight(visibleMainHeight);
  scrollView.setLines([...statusLines, ...mainLines]);

  if (layout.mode === "columns") {
    const rail = renderRail(summary, activeTabIndex, focus, layout.railWidth);
    const main = scrollView.render(layout.mainWidth) as string[];
    return renderColumns(rail, main, layout.railWidth, layout.mainWidth, bodyHeight);
  }

  const rail = renderRail(summary, activeTabIndex, focus, layout.contentWidth);
  const main = scrollView.render(layout.contentWidth) as string[];
  return fitLinesToHeight([...rail, "", ...main], bodyHeight);
}

type ColumnLayout =
  | { mode: "stacked"; contentWidth: number }
  | { mode: "columns"; contentWidth: number; railWidth: number; mainWidth: number };

function computeColumnLayout(contentWidth: number): ColumnLayout {
  if (contentWidth < MIN_RAIL_WIDTH + COLUMN_GAP + MIN_MAIN_WIDTH) {
    return { mode: "stacked", contentWidth };
  }

  const railWidth = Math.max(MIN_RAIL_WIDTH, Math.floor(contentWidth * 0.27));
  const mainWidth = contentWidth - railWidth - COLUMN_GAP;

  if (mainWidth < MIN_MAIN_WIDTH) {
    return { mode: "stacked", contentWidth };
  }

  return { mode: "columns", contentWidth, railWidth, mainWidth };
}

function renderRail(summary: ActiveRoadmapDetailSummary, activeTabIndex: number, focus: FocusArea, width: number): string[] {
  const lines = [
    sectionHeader(focus === "rail" ? "Tabs *" : "Tabs"),
    ...TAB_NAMES.flatMap((tab, index) => tabLine(tab, index === activeTabIndex, focus === "rail", width)),
    "",
    sectionHeader("Health"),
    ...keyValueLines("Phase", summary.roadmap.phase, width),
    ...keyValueLines("Status", summary.roadmapHealth.status, width),
    ...keyValueLines("Blockers", String(summary.roadmapHealth.openBlockerCount), width),
    ...keyValueLines("Issues", issueCountLabel(summary), width),
    "",
    sectionHeader("Shortcuts"),
    ...summary.availableControls.map((control) => shortcutLine(control, width)),
  ];
  return lines;
}

function tabLine(tab: string, selected: boolean, focused: boolean, width: number): string[] {
  const marker = selected ? (focused ? ">" : "*") : " ";
  const text = `${marker} ${tab}`;
  return wrapWords(selected ? `${s.cyan}${s.bold}${text}${s.reset}` : `${s.dim}${text}${s.reset}`, width);
}

function shortcutLine(control: RoadmapDetailControl, width: number): string {
  const label = `[${control.key}] ${control.label}`;
  const suffix = control.enabled ? "" : " disabled";
  return truncateAnsi(control.enabled ? `${s.cyan}${label}${s.reset}` : `${s.dim}${label}${suffix}${s.reset}`, width);
}

function renderTabContent(summary: ActiveRoadmapDetailSummary, tab: TabName, contentWidth: number): string[] {
  switch (tab) {
    case "Overview":
      return renderOverviewTab(summary, contentWidth);
    case "Plan":
      return renderPlanTab(summary, contentWidth);
    case "Gates":
      return renderGatesTab(summary, contentWidth);
    case "Usage":
      return renderUsageTab(summary, contentWidth);
    case "Activity":
      return renderActivityTab(summary, contentWidth);
  }
}

function renderOverviewTab(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  return [
    sectionHeader("Next Command"),
    ...arrowLines(summary.nextCommand.label, contentWidth),
    ...wrapWords(summary.nextCommand.description, contentWidth),
    "",
    sectionHeader("Next Action"),
    ...keyValueLines("Status", summary.nextAction.status, contentWidth),
    ...keyValueLines("Safe", summary.nextAction.safe_to_apply ? "yes" : "no", contentWidth),
    ...(summary.nextAction.blockers.length > 0 ? keyValueLines("Blockers", summary.nextAction.blockers.join("; "), contentWidth) : []),
    ...(summary.nextAction.missing_inputs.length > 0 ? keyValueLines("Missing", summary.nextAction.missing_inputs.join("; "), contentWidth) : []),
    "",
    sectionHeader("Context"),
    ...keyValueLines("Roadmap", summary.roadmap.label, contentWidth),
    ...keyValueLines("Milestone", summary.active.milestone?.label ?? "none", contentWidth),
    ...keyValueLines("Change", summary.active.changeRequest?.label ?? "none", contentWidth),
    ...keyValueLines("Bypass", summary.bypass.label, contentWidth),
    "",
    sectionHeader("Active Work"),
    ...renderActiveWork(summary, contentWidth),
    "",
    sectionHeader("Actions"),
    ...renderControls(summary.availableControls, contentWidth),
  ];
}

function renderPlanTab(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  if (summary.milestones.length === 0) return [`${s.dim}No roadmap milestones recorded.${s.reset}`];
  return summary.milestones.flatMap((milestone, index) => [
    ...(index === 0 ? [] : [""]),
    ...milestoneLines(milestone, contentWidth),
  ]);
}

function milestoneLines(milestone: RoadmapDetailMilestone, contentWidth: number): string[] {
  const lines = [
    `${s.bold}${milestone.id}${s.reset} ${styleValue(milestone.status)} ${milestone.title}`,
  ];

  if (milestone.detail === "outline") {
    lines.push(`${s.dim}outline only; run /milestone:plan when this milestone is active${s.reset}`);
    return lines;
  }

  if (milestone.waves.length === 0) {
    lines.push(`${s.dim}No waves recorded.${s.reset}`);
    return lines;
  }

  for (const wave of milestone.waves) {
    lines.push(...waveLines(wave, contentWidth));
  }

  return lines;
}

function waveLines(wave: RoadmapDetailPlanWave, contentWidth: number): string[] {
  const lines = bulletLines(`${wave.id} [${wave.status}] ${wave.goal}`, contentWidth, s.cyan);
  if (wave.tasks.length === 0) {
    lines.push(`  ${s.dim}No tasks recorded.${s.reset}`);
    return lines;
  }
  lines.push(...wave.tasks.flatMap((task) => taskLines(task, Math.max(1, contentWidth - 2)).map((line) => `  ${line}`)));
  return lines;
}

function renderGatesTab(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  return [
    sectionHeader("Quality Gate"),
    ...renderQualityGate(summary, contentWidth),
    "",
    sectionHeader("Validation"),
    ...keyValueLines("Status", summary.validation.status, contentWidth),
    "",
    sectionHeader("Implementation Gate"),
    ...keyValueLines("Status", summary.gate.status, contentWidth),
    "",
    sectionHeader("Blockers"),
    ...renderCanonicalBlockers(summary, contentWidth),
    "",
    sectionHeader("Issues"),
    ...renderIssues(summary, contentWidth),
  ];
}

function renderUsageTab(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  if (!summary.usage) return [`${s.dim}No usage recorded.${s.reset}`];
  const scopes = [
    { label: "Roadmap", totals: summary.usage.roadmap, agents: summary.usage.topAgents },
    ...(summary.usage.milestone ? [{ label: `Milestone ${summary.usage.milestone.id}`, totals: summary.usage.milestone.totals, agents: summary.usage.milestone.topAgents }] : []),
    ...(summary.usage.changeRequest ? [{ label: `Change ${summary.usage.changeRequest.id}`, totals: summary.usage.changeRequest.totals, agents: summary.usage.changeRequest.topAgents }] : []),
  ];

  return scopes.flatMap((scope, index) => [
    ...(index === 0 ? [] : [""]),
    `${s.bold}${scope.label}${s.reset}`,
    ...usageTotalsLines(scope.totals, contentWidth),
    ...usageAgentLines(scope.agents, contentWidth),
  ]);
}

function renderActivityTab(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  return [
    sectionHeader("Recent Events"),
    ...renderEvents(summary.recentEvents, contentWidth),
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

  if (gate.latestFinding) lines.push(...keyValueLines("Finding", gate.latestFinding, contentWidth));
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
    return bulletLines(`[${control.key}] ${control.label} (${status})`, contentWidth, control.enabled ? s.cyan : s.dim);
  });
}

function renderCanonicalBlockers(summary: ActiveRoadmapDetailSummary, contentWidth: number): string[] {
  const counts = summary.canonicalBlockers.counts;
  const lines = [
    ...keyValueLines("Counts", `open ${counts.open}, resolved ${counts.resolved}, deferred ${counts.deferred}`, contentWidth),
  ];
  if (summary.canonicalBlockers.open.length === 0) {
    lines.push(`${s.green}ok${s.reset} No open canonical blockers.`);
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

  if (issues.length === 0) return [`${s.green}ok${s.reset} No validation or gate issues.`];

  return issues.flatMap((issue) => {
    const tone = issue.severity === "warning" ? s.yellow : s.red;
    const icon = issue.severity === "warning" ? "!" : "x";
    return wrapWords(`${issue.code}: ${issue.message}`, Math.max(1, contentWidth - 2)).map((line, index) =>
      `${index === 0 ? `${tone}${icon}${s.reset} ` : "  "}${tone}${line}${s.reset}`,
    );
  });
}

function usageTotalsLines(totals: RoadmapDetailUsageTotals, contentWidth: number): string[] {
  return [
    ...keyValueLines("Cost", totals.costLabel, contentWidth),
    ...keyValueLines("Requests", String(totals.raw.requests), contentWidth),
    ...keyValueLines("Tokens", String(totals.totalTokens), contentWidth),
    ...keyValueLines("Input", String(totals.raw.input_tokens), contentWidth),
    ...keyValueLines("Output", String(totals.raw.output_tokens), contentWidth),
    ...keyValueLines("Cache", `${totals.raw.cache_read_tokens} read / ${totals.raw.cache_write_tokens} write`, contentWidth),
    ...keyValueLines("Reasoning", String(totals.raw.reasoning_tokens), contentWidth),
  ];
}

function usageAgentLines(agents: RoadmapDetailUsageAgent[], contentWidth: number): string[] {
  if (agents.length === 0) return [`${s.dim}Top agents: none${s.reset}`];
  return [
    `${s.dim}Top agents${s.reset}`,
    ...agents.flatMap((agent) => bulletLines(agent.label, contentWidth, s.dim)),
  ];
}

function taskLines(task: RoadmapDetailTask, contentWidth: number): string[] {
  return bulletLines(`${task.id} [${task.status}, ${task.worker}] ${task.title}`, contentWidth, s.cyan);
}

function blockerLines(blocker: RoadmapDetailBlocker, contentWidth: number): string[] {
  return bulletLines(`${blocker.label}: ${blocker.message}`, contentWidth, s.red);
}

function renderColumns(left: string[], right: string[], leftWidth: number, rightWidth: number, height: number): string[] {
  const leftWrapped = left.flatMap((line) => wrapWords(line, leftWidth));
  const rightWrapped = right.flatMap((line) => wrapWords(line, rightWidth));
  const lines: string[] = [];

  for (let index = 0; index < height; index++) {
    const leftLine = padAnsiToWidth(truncateAnsi(leftWrapped[index] ?? "", leftWidth), leftWidth);
    const rightLine = truncateAnsi(rightWrapped[index] ?? "", rightWidth);
    lines.push(`${leftLine}${" ".repeat(COLUMN_GAP)}${rightLine}`);
  }

  return lines;
}

function fitLinesToHeight(lines: string[], height: number): string[] {
  const result: string[] = [];
  for (let index = 0; index < height; index++) result.push(lines[index] ?? "");
  return result;
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
  return bulletLines(text, contentWidth, s.green, ">");
}

function bulletLines(text: string, contentWidth: number, color: string, marker = "-"): string[] {
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

  if (["valid", "open", "complete", "completed", "done", "active", "healthy", "passed"].includes(lower)) {
    return `${s.green}${value}${s.reset}`;
  }

  if (["invalid", "closed", "blocked", "failed", "error"].includes(lower)) {
    return `${s.red}${value}${s.reset}`;
  }

  if (["inactive", "none", "not recorded", "pending", "todo", "outline"].includes(lower)) {
    return `${s.dim}${value}${s.reset}`;
  }

  if (lower === "stale" || lower === "attention") {
    return `${s.yellow}${value}${s.reset}`;
  }

  return value
    .replace(/\bvalid\b/gi, `${s.green}$&${s.reset}`)
    .replace(/\binvalid\b/gi, `${s.red}$&${s.reset}`)
    .replace(/\bopen\b/gi, `${s.green}$&${s.reset}`)
    .replace(/\bclosed\b/gi, `${s.red}$&${s.reset}`)
    .replace(/\bblocked\b/gi, `${s.red}$&${s.reset}`)
    .replace(/\bcomplete(?:d)?\b/gi, `${s.green}$&${s.reset}`)
    .replace(/\bpassed\b/gi, `${s.green}$&${s.reset}`)
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

function getTuiRowsAndCols(tui: TUI, fallbackWidth: number): { rows: number; cols: number } {
  const terminal = (tui as unknown as { terminal?: { rows?: number; columns?: number } }).terminal;
  return {
    rows: Math.max(MIN_VIEW_HEIGHT, Math.trunc(terminal?.rows ?? process.stdout.rows ?? DETAILS_VIEW_HEIGHT)),
    cols: Math.max(MIN_VIEW_WIDTH, Math.trunc(terminal?.columns ?? fallbackWidth ?? process.stdout.columns ?? MIN_VIEW_WIDTH)),
  };
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
