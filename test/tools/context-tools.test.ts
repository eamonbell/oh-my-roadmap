import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decisionsPath } from "@oh-my-roadmap/core/paths";
import { createAdhocPlan, createChangeRequest, initRoadmap, transition } from "@oh-my-roadmap/core/store/index";
import {
  approvedMilestone,
  closeoutPhase,
  createTempRoadmapCwd,
  milestoneInput,
  removeTempRoadmapCwd,
  testWave,
} from "../state/helpers";
import { registeredTool, registerTools, toolContext } from "./helpers";

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error(`Expected ${label} to be an array of objects`);
  }
  return value as Array<Record<string, unknown>>;
}

describe("roadmap context tools", () => {
  test("registers search and read context tools as read-only tools", () => {
    const tools = registerTools();

    const readStateTool = registeredTool(tools, "omr_read_state");
    const searchTool = registeredTool(tools, "omr_search_context");
    const readTool = registeredTool(tools, "omr_read_context");
    const readEventsTool = registeredTool(tools, "omr_read_events");
    const listQualityGatesTool = registeredTool(tools, "omr_list_quality_gates");
    const nextActionTool = registeredTool(tools, "omr_next_action");
    expect(readStateTool?.approval).toBe("read");
    expect(searchTool?.approval).toBe("read");
    expect(readTool?.approval).toBe("read");
    expect(readEventsTool?.approval).toBe("read");
    expect(listQualityGatesTool?.approval).toBe("read");
    expect(nextActionTool?.approval).toBe("read");
  });

  test("serializes agent-facing tool text compactly while details stay structured", async () => {
    const tools = registerTools();
    const readStateTool = registeredTool(tools, "omr_read_state");
    const searchTool = registeredTool(tools, "omr_search_context");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-compact-"));
    try {
      await initRoadmap(cwd, { roadmapId: "compact-roadmap", title: "Compact Roadmap" });

      const state = await readStateTool?.execute(
        "state",
        {},
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      const firstText = (result: unknown): string => {
        const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
        return content.find((entry) => entry.type === "text")?.text ?? "";
      };
      const stateText = firstText(state);
      // Compact: no pretty-print indentation/newlines in the agent-facing text.
      expect(stateText).not.toContain("\n");
      expect(stateText).not.toContain("  ");
      // The parsed text still matches the structured details rendered for the UI.
      expect(JSON.parse(stateText)).toEqual(state?.details);

      const search = await searchTool?.execute(
        "search",
        { artifacts: ["roadmap"] },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      const searchText = firstText(search);
      expect(searchText).not.toContain("\n");
      expect(JSON.parse(searchText)).toEqual(search?.details);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("reads and searches compact context without exposing full roadmap state", async () => {
    const tools = registerTools();

    const readStateTool = registeredTool(tools, "omr_read_state");
    const searchTool = registeredTool(tools, "omr_search_context");
    const readTool = registeredTool(tools, "omr_read_context");
    const readEventsTool = registeredTool(tools, "omr_read_events");
    const nextActionTool = registeredTool(tools, "omr_next_action");

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-tools-"));
    try {
      await initRoadmap(cwd, { roadmapId: "tool-roadmap", title: "Tool Roadmap" });
      await fs.writeFile(
        decisionsPath(cwd, "tool-roadmap"),
        "# Decision Register\n\n## Compact context\n\nUse snippets before full bodies.\n",
        "utf8",
      );

      const state = await readStateTool?.execute(
        "state",
        {},
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(state?.details).toMatchObject({
        active: { roadmap_id: "tool-roadmap" },
        roadmap: { roadmap_id: "tool-roadmap", title: "Tool Roadmap" },
      });
      expect(JSON.stringify(state?.details)).toContain("context_sections");
      expect(JSON.stringify(state?.details)).not.toContain("success_criteria");

      const nextAction = await nextActionTool?.execute(
        "next-action",
        {},
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      // A freshly initialized roadmap is in the discovery phase, whose only legal forward step is
      // record_discovery; next_action steers there rather than to premature approval-readiness
      // validation (which would recommend finalization before discovery is recorded).
      expect(nextAction?.details).toMatchObject({
        action: "Record repo discovery with omr_transition record_discovery.",
        plan: {
          label: "Record repo discovery",
          status: "needs_input",
          safe_to_apply: false,
        },
      });

      const search = await searchTool?.execute(
        "search",
        { artifacts: ["decisions"], query: "snippets" },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(search?.details).toMatchObject({
        total: 1,
        returned: 1,
      });
      expect(JSON.stringify(search?.details)).not.toContain('"body"');

      const read = await readTool?.execute(
        "read",
        { ids: ["decisions:1"], maxBodyChars: 8 },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(read?.details).toMatchObject({
        requested: 1,
        found: 1,
      });
      expect(JSON.stringify(read?.details)).toContain('"body":"## Compa"');

      const events = await readEventsTool?.execute(
        "events",
        { type: ["roadmap.initialized"] },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(events?.details).toMatchObject({
        total: 1,
        returned: 1,
        events: [{ type: "roadmap.initialized" }],
      });

      const roadmapSearch = await searchTool?.execute(
        "search-roadmap",
        { artifacts: ["roadmap"], query: "not finalized" },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      expect(roadmapSearch?.details).toMatchObject({
        total: 1,
        returned: 1,
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("narrow read-state scopes return only their own payloads", async () => {
    const readStateTool = registeredTool(registerTools(), "omr_read_state");
    const cwd = await createTempRoadmapCwd();
    try {
      await fs.writeFile(
        path.join(cwd, "package.json"),
        JSON.stringify({ packageManager: "bun@1.3.14", scripts: { test: "bun test" } }),
      );
      await approvedMilestone(cwd);
      await transition(cwd, { operation: "start_implementation" });

      const read = async (scope: string): Promise<Record<string, unknown>> => {
        const result = await readStateTool?.execute(
          "state",
          { scope },
          new AbortController().signal,
          undefined,
          toolContext(cwd),
        );
        return result?.details as Record<string, unknown>;
      };

      const phase = await read("phase");
      expect(phase.roadmap).toMatchObject({ roadmap_id: "complex-refactor", phase: "implementing" });
      expect(JSON.stringify(phase)).not.toContain('"discovery"');
      expect(JSON.stringify(phase)).not.toContain('"milestones"');
      expect(phase).not.toHaveProperty("repo_primer");
      expect(phase).not.toHaveProperty("repo_primer_warnings");

      const progress = await read("progress");
      expect(progress).toHaveProperty("progress");
      expect(progress).toHaveProperty("task_counts");
      expect(progress).toHaveProperty("wave_counts");
      expect(JSON.stringify(progress)).not.toContain("implementation_notes");
      expect(progress).not.toHaveProperty("repo_primer");

      const gates = await read("quality_gates");
      expect(gates).toHaveProperty("roadmap_milestone_check");
      expect(gates).toHaveProperty("wave_flow_check");
      expect(gates).not.toHaveProperty("repo_primer");

      const outlines = await read("milestone_outlines");
      const outlineMilestones = outlines.milestones as Array<Record<string, unknown>>;
      expect(outlineMilestones[0]).toHaveProperty("scope_items");
      expect(JSON.stringify(outlines)).not.toContain("implementation_notes");

      const closeout = await read("closeout_requirements");
      const acceptance = closeout.acceptance as Array<{ id: string; item: string }>;
      const verification = closeout.verification as Array<{ id: string; item: string }>;
      expect(acceptance[0]).toMatchObject({ id: "acceptance:1", item: "State validates" });
      expect(verification[0]).toMatchObject({ id: "verification:1", item: "bun test" });

      const roadmap = await read("roadmap");
      const milestone = await read("active_milestone");
      const change = await read("active_change");
      const primer = expectRecord(milestone.repo_primer, "milestone repo primer");
      expect(primer).toMatchObject({
        bytes: expect.any(Number),
        truncated: false,
        generated_at: expect.any(String),
        source_fingerprint: expect.any(String),
      });
      if (typeof primer.text !== "string") throw new Error("Expected rendered primer text");
      expect(JSON.parse(primer.text)).toMatchObject({
        package_managers: ["bun"],
        commands: [{ category: "test", command: "bun run test", source_path: "package.json" }],
      });
      expect(roadmap.repo_primer).toEqual(primer);
      expect(change.repo_primer).toEqual(primer);
      for (const selected of [roadmap, milestone, change]) {
        expect(JSON.stringify(selected).match(/"repo_primer":/g)).toHaveLength(1);
        expect(selected.repo_primer_warnings).toEqual([]);
      }

      const milestoneSummary = expectRecord(milestone.milestone, "milestone summary");
      const milestoneTasks = expectRecordArray(milestoneSummary.tasks, "milestone tasks");
      expect(milestoneTasks[0]).toHaveProperty("relevant_existing_code");
      expect(milestoneTasks[0]).toHaveProperty("shared_interface_contracts");

      const activeWave = await read("active_wave");
      const activeWaveSummary = expectRecord(activeWave.active_wave, "active wave summary");
      const activeWaveTasks = expectRecordArray(activeWaveSummary.tasks, "active wave tasks");
      expect(activeWaveTasks[0]).toHaveProperty("relevant_existing_code");
      expect(activeWaveTasks[0]).toHaveProperty("shared_interface_contracts");
      expect(activeWave).not.toHaveProperty("repo_primer");
      expect(activeWave).not.toHaveProperty("repo_primer_warnings");

      const roadmapPkg = await read("roadmap_checker_package");
      const roadmapPkgRoadmap = roadmapPkg.roadmap as Record<string, unknown>;
      expect(roadmapPkgRoadmap).toHaveProperty("roadmap_milestone_check_status");
      expect(roadmapPkgRoadmap).not.toHaveProperty("discovery");
      expect(roadmapPkgRoadmap).not.toHaveProperty("success_criteria");
      expect(roadmapPkgRoadmap).not.toHaveProperty("open_questions");
      const pkgMilestones = roadmapPkg.milestones as Array<Record<string, unknown>>;
      expect(pkgMilestones[0]).toHaveProperty("goal");
      expect(pkgMilestones[0]).toHaveProperty("scope");
      expect(roadmapPkg.repo_primer).toEqual(primer);
      expect(JSON.stringify(roadmapPkg).match(/"repo_primer":/g)).toHaveLength(1);

      const wavePkg = await read("wave_flow_checker_package");
      const wavePlan = wavePkg.plan as Record<string, unknown>;
      expect(wavePlan).toHaveProperty("acceptance_criteria");
      expect(wavePlan).toHaveProperty("verification_commands");
      const wavePkgTasks = wavePkg.tasks as Array<Record<string, unknown>>;
      expect(wavePkgTasks[0]).toHaveProperty("done_criteria");
      expect(wavePkgTasks[0]).toHaveProperty("relevant_existing_code");
      expect(wavePkgTasks[0]).toHaveProperty("shared_interface_contracts");
      expect(wavePkg.repo_primer).toEqual(primer);
      expect(JSON.stringify(wavePkg).match(/"repo_primer":/g)).toHaveLength(1);
      expect(JSON.stringify(wavePkg)).not.toContain("implementation_notes");
      expect(JSON.stringify(wavePkg)).not.toContain("user_interview");
    } finally {
      await removeTempRoadmapCwd(cwd);
    }
  });
  test("ad-hoc wave and checker summaries preserve exact structured task context", async () => {
    const readStateTool = registeredTool(registerTools(), "omr_read_state");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-adhoc-context-"));
    try {
      await fs.mkdir(path.join(cwd, "src"), { recursive: true });
      await fs.writeFile(path.join(cwd, "src/context.ts"), "export interface ExistingContext { value: string }\n");
      const task = {
        id: "t01-context",
        title: "Context task",
        objective: "Use the existing context.",
        implementation_notes: ["Keep the interface stable."],
        done_criteria: ["Context remains stable."],
        verification_commands: ["bun test"],
        worker: "worker" as const,
        status: "assigned" as const,
        depends_on: [],
        owned_files: ["src/context.ts"],
        owned_modules: [],
        shared_interfaces: ["ExistingContext"],
        relevant_existing_code: [{
          path: "src/context.ts",
          line: 1,
          symbol: "ExistingContext",
          note: "The live ad-hoc integration boundary.",
        }],
        shared_interface_contracts: [{
          name: "ExistingContext",
          signature: "export interface ExistingContext { value: string }",
          source_path: "src/context.ts",
          line: 1,
          planned: false as const,
        }],
      };
      await createAdhocPlan(cwd, {
        adhocId: "a01-context",
        title: "Context ad-hoc",
        request: "Exercise checker context.",
        verificationCommands: ["bun test"],
        acceptanceCriteria: ["Context remains exact"],
        tasks: [task],
        waves: [{
          id: "w01",
          goal: "Use the context.",
          exit_criteria: ["Task is complete."],
          review_checkpoint: "Review context use.",
          status: "pending",
          tasks: [task.id],
        }],
      });
      const read = async (scope: string): Promise<Record<string, unknown>> => {
        const result = await readStateTool?.execute(
          "state",
          { scope },
          new AbortController().signal,
          undefined,
          toolContext(cwd),
        );
        return expectRecord(result?.details, `${scope} details`);
      };

      const activeWave = await read("active_wave");
      const activeWaveSummary = expectRecord(activeWave.active_wave, "ad-hoc active wave");
      const activeWaveTasks = expectRecordArray(activeWaveSummary.tasks, "ad-hoc active wave tasks");
      expect(activeWaveTasks[0]?.relevant_existing_code).toEqual([
        expect.objectContaining({ path: "src/context.ts", symbol: "ExistingContext" }),
      ]);
      expect(activeWaveTasks[0]?.shared_interface_contracts).toEqual([
        expect.objectContaining({ name: "ExistingContext", planned: false }),
      ]);

      const checker = await read("wave_flow_checker_package");
      const checkerPlan = expectRecord(checker.plan, "ad-hoc checker plan");
      expect(checkerPlan).toMatchObject({ adhoc_id: "a01-context", title: "Context ad-hoc" });
      const checkerTasks = expectRecordArray(checker.tasks, "ad-hoc checker tasks");
      expect(checkerTasks[0]?.relevant_existing_code).toEqual(activeWaveTasks[0]?.relevant_existing_code);
      expect(checkerTasks[0]?.shared_interface_contracts).toEqual(activeWaveTasks[0]?.shared_interface_contracts);
      expect(checker).toHaveProperty("repo_primer");
      expect(JSON.stringify(checker).match(/"repo_primer":/g)).toHaveLength(1);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("active change summaries preserve exact structured task context", async () => {
    const readStateTool = registeredTool(registerTools(), "omr_read_state");
    const cwd = await createTempRoadmapCwd();
    try {
      await closeoutPhase(cwd);
      await fs.mkdir(path.join(cwd, "src/core"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, "src/core/store.ts"),
        "export interface RoadmapState { id: string }\n",
      );
      const task = {
        ...milestoneInput().tasks[0]!,
        id: "t01-change",
        depends_on: [],
        relevant_existing_code: [{
          path: "src/core/store.ts",
          line: 1,
          symbol: "RoadmapState",
          note: "The live state contract used by this change.",
        }],
        shared_interface_contracts: [{
          name: "RoadmapState",
          signature: "export interface RoadmapState { id: string }",
          source_path: "src/core/store.ts",
          line: 1,
          planned: false,
        }],
      };
      await createChangeRequest(cwd, {
        changeRequestId: "c01-context",
        title: "Context change",
        request: "Adjust the live state contract.",
        verificationCommands: ["bun test"],
        acceptanceCriteria: ["Context remains exact"],
        tasks: [task],
        waves: [testWave("w01", [task.id])],
      });

      const result = await readStateTool?.execute(
        "state",
        { scope: "active_change" },
        new AbortController().signal,
        undefined,
        toolContext(cwd),
      );
      const details = expectRecord(result?.details, "active change details");
      const change = expectRecord(details.change_request, "active change summary");
      const tasks = expectRecordArray(change.tasks, "active change tasks");
      expect(tasks[0]?.relevant_existing_code).toEqual([
        expect.objectContaining({
          path: "src/core/store.ts",
          line: 1,
          symbol: "RoadmapState",
          note: "The live state contract used by this change.",
        }),
      ]);
      expect(tasks[0]?.shared_interface_contracts).toEqual([
        expect.objectContaining({
          name: "RoadmapState",
          signature: "export interface RoadmapState { id: string }",
          source_path: "src/core/store.ts",
          line: 1,
          planned: false,
        }),
      ]);
      expect(details).toHaveProperty("repo_primer");
      expect(JSON.stringify(details).match(/"repo_primer":/g)).toHaveLength(1);
    } finally {
      await removeTempRoadmapCwd(cwd);
    }
  });

  test("primer refresh failures warn without failing planner state reads", async () => {
    const readStateTool = registeredTool(registerTools(), "omr_read_state");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-primer-warning-"));
    try {
      await initRoadmap(cwd, { roadmapId: "primer-warning", title: "Primer Warning" });
      const readRoadmap = async (): Promise<Record<string, unknown>> => {
        const result = await readStateTool?.execute(
          "state",
          { scope: "roadmap" },
          new AbortController().signal,
          undefined,
          toolContext(cwd),
        );
        return expectRecord(result?.details, "roadmap details");
      };

      await fs.writeFile(path.join(cwd, "package.json"), "{ malformed");
      const unavailable = await readRoadmap();
      expect(unavailable).not.toHaveProperty("repo_primer");
      expect(unavailable.repo_primer_warnings).toEqual([
        expect.stringContaining("Repository primer refresh failed:"),
      ]);

      await fs.writeFile(
        path.join(cwd, "package.json"),
        JSON.stringify({ packageManager: "bun@1.3.14", scripts: { test: "bun test" } }),
      );
      const available = await readRoadmap();
      const lastGoodPrimer = available.repo_primer;
      expect(lastGoodPrimer).toBeDefined();

      await fs.writeFile(path.join(cwd, "package.json"), "{ malformed again");
      const staleFallback = await readRoadmap();
      expect(staleFallback.repo_primer).toEqual(lastGoodPrimer);
      expect(staleFallback.repo_primer_warnings).toEqual([
        expect.stringContaining("Repository primer refresh failed:"),
      ]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });


  test("search modes control result density: count, ids, and bodies", async () => {
    const searchTool = registeredTool(registerTools(), "omr_search_context");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-search-modes-"));
    try {
      await initRoadmap(cwd, { roadmapId: "search-modes", title: "Search Modes" });
      await fs.writeFile(
        decisionsPath(cwd, "search-modes"),
        "# Decision Register\n\n## Staged search\n\nPrefer count and ids before snippets and full bodies.\n",
        "utf8",
      );

      const search = (params: Record<string, unknown>) =>
        searchTool?.execute("search", params, new AbortController().signal, undefined, toolContext(cwd));

      const count = await search({ artifacts: ["decisions"], mode: "count" });
      expect(count?.details).toMatchObject({ total: 1, returned: 0 });
      expect((count?.details as { results: unknown[] }).results).toEqual([]);

      const ids = await search({ artifacts: ["decisions"], mode: "ids" });
      expect(ids?.details).toMatchObject({ total: 1, returned: 1 });
      const idResults = (ids?.details as { results: Array<Record<string, unknown>> }).results;
      expect(idResults[0]?.id).toBe("decisions:1");
      expect(idResults[0]?.snippet).toBe("");
      expect(idResults[0]).not.toHaveProperty("body");
      expect(JSON.stringify(ids?.details)).not.toContain('"body"');

      const bodies = await search({ artifacts: ["decisions"], mode: "bodies", maxBodyChars: 8 });
      const bodyResults = (bodies?.details as { results: Array<Record<string, unknown>> }).results;
      expect((bodyResults[0]?.body as string).length).toBeLessThanOrEqual(8);
      expect(bodyResults[0]?.bodyTruncated).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
