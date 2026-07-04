---
roadmap_id: example-roadmap
milestone_id: m01-example
title: Example Milestone
status: milestone_planning
approvals: [ ]
open_questions: [ ]
verification_commands: [ ]
acceptance_criteria: [ ]
cleanup_policy: approval-gated
user_interview: [ ]
relevant_existing_code: [ ]
relevant_documentation: [ ]
decisions: [ ]
dependency_analysis: [ ]
tasks: [ ]
waves: [ ]
progress:
  step: not_started
  active_task_ids: [ ]
  updated_at: example-timestamp
wave_flow_check:
  status: pending
  checked_by: ""
  checked_at: ""
  summary: ""
  findings: [ ]
---

# Example Milestone

## User Interview

Record decisions gathered with the built-in `ask` tool and any questions still open.

## Context

### Relevant Existing Code

List repo paths, ownership notes, and interfaces that shape this milestone.

### Relevant Documentation

List project docs, external docs, standards, or API references used while planning.

### Assumptions & External Dependencies

Record assumptions made and every SDK, dependency, API, or CLI this milestone relies on. For each, note the documentation consulted (link or file
path) or that a link is still needed. Do not guess the shape or behavior of an external resource — ask the user for docs and ground the plan in them.

## Decisions

## Required Work

Define concrete executable tasks before dependency analysis or wave creation. Each task must include objective, implementation notes, done criteria,
task verification commands, dependencies, exclusive ownership, shared interfaces, and worker assignment. Worker assignment must be one of
`worker-light`, `worker`, or `worker-heavy`. Do not add filler tasks to justify the milestone; every task must directly implement the approved roadmap
milestone scope.

Write implementation notes at the approach and intent level — describe what each task must achieve and its constraints, not a rigid line-by-line
script. Keep exclusive file/module ownership exact (it is required for safe parallel waves), but leave the worker room to make the concrete edits;
expect new areas of impact or revelations to surface during implementation and be handled in-flight unless they require a roadmap amendment.

## Dependency Analysis

Explain task dependencies, why each dependency exists, and which tasks can safely run in the same wave.

## Execution Waves

Group only already-defined tasks into waves. Each wave must include a goal, exit criteria, and review checkpoint.

## Wave Flow Check

Record the structured `wave_flow_check` status. It starts as `pending`, must be recorded by `wave-flow-checker`, and must be `passed` before approval.

## Progress

Use the persisted implementation progress cursor as the source of truth for pause/resume.

## Verification

Record the user's test coverage decisions in detail. Identify which implementation areas or tasks must create tests, which tasks only need to run
existing tests, what behaviors or edge cases each test should cover, and any coverage intentionally deferred or not required.
