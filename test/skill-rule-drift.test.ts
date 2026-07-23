import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_TRANSPORT_RESUME_ATTEMPTS,
  REVIEWER_REWORK_RULE,
  SCOUT_RECORDING_RULE,
  workerReworkRule,
} from "../packages/extension/src/extension/commands/rule-text";

// Single-source drift guard for R18. The canonical rule prose lives in rule-text.ts and is
// interpolated into the runtime command prompts (prompts.ts). Each SKILL.md keeps a
// human-readable copy of the same rule. This test asserts every SKILL.md that carries a rule
// still contains its canonical const text after normalizing markdown formatting only — so
// backticks/bold/bullet styling may differ, but the substantive words may not. If a SKILL.md
// rule is edited so its wording diverges from the const (or vice versa), the contiguous
// normalized substring breaks and this test fails.

const repoRoot = path.resolve(import.meta.dir, "..");
const skillsDir = path.join(repoRoot, "packages", "extension", "skills");

function readSkill(name: string): string {
  return fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
}

// Strip inline-code backticks and bold markers, drop leading markdown bullet prefixes, then
// collapse all remaining whitespace (including newlines) to single spaces. This deliberately
// keeps every substantive word, punctuation mark, and tool/op name so the comparison is
// sensitive to real rule changes, not formatting.
function normalize(text: string): string {
  return text
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s+/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const WORKER_RULE = workerReworkRule(DEFAULT_TRANSPORT_RESUME_ATTEMPTS);

describe("skill/rule single-source drift", () => {
  test("implementation-orchestrator SKILL.md carries the canonical worker recovery/rework rule", () => {
    const skill = normalize(readSkill("implementation-orchestrator"));
    expect(skill).toContain(normalize(WORKER_RULE));
  });

  test("implementation-orchestrator SKILL.md carries the canonical reviewer rework rule", () => {
    const skill = normalize(readSkill("implementation-orchestrator"));
    expect(skill).toContain(normalize(REVIEWER_REWORK_RULE));
  });

  test("both planner skills carry the canonical scout-recording rule", () => {
    const scout = normalize(SCOUT_RECORDING_RULE);
    expect(normalize(readSkill("milestone-planner"))).toContain(scout);
    expect(normalize(readSkill("roadmap-planner"))).toContain(scout);
  });

  // Robustness: the check is substantive, not a trivial substring. A one-word divergence in the
  // canonical rule must no longer be found in the (unchanged) SKILL.md copy.
  test("a substantive divergence in a rule is detected", () => {
    const skill = normalize(readSkill("implementation-orchestrator"));
    // Flip the R2 escape-hatch instruction from "FRESH reviewer only" to "reviewer only".
    const drifted = normalize(REVIEWER_REWORK_RULE).replace(
      "Spawn a FRESH reviewer only",
      "Spawn a reviewer always",
    );
    expect(drifted).not.toBe(normalize(REVIEWER_REWORK_RULE));
    expect(skill).not.toContain(drifted);

    const scoutSkill = normalize(readSkill("roadmap-planner"));
    const driftedScout = normalize(SCOUT_RECORDING_RULE).replace(
      "regardless of whether a scout agent was ever dispatched",
      "only after a scout agent returns",
    );
    expect(driftedScout).not.toBe(normalize(SCOUT_RECORDING_RULE));
    expect(scoutSkill).not.toContain(driftedScout);
  });

  // The runtime prompt and the skill must agree on the R7 abandoned->redispatch sequence and the
  // history:// session-scoping note, which are the substantive parts of R7.
  test("worker rule states the R7 abandoned->redispatch sequence and history:// scoping", () => {
    const rule = normalize(WORKER_RULE);
    expect(rule).toContain(
      "omr_record_worker_abandoned followed by omr_prepare_worker_redispatch is a valid sequence",
    );
    expect(rule).toContain("accepts an abandoned or transport_failed run");
    expect(rule).toContain("history://<agentId> is session-scoped");
  });

  // The reviewer rule must reflect the shipped R2 machinery.
  test("reviewer rule references the shipped R2 re-review machinery", () => {
    const rule = normalize(REVIEWER_REWORK_RULE);
    expect(rule).toContain("omr_record_reviewer_dispatch");
    expect(rule).toContain("re_review: true");
    expect(rule).toContain("prior_reviewer_agent_id");
    expect(rule).toContain("prior_findings");
  });
});
