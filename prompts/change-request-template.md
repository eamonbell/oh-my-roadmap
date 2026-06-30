---
roadmap_id: example-roadmap
milestone_id: m01-example
change_request_id: c01-example
title: Example Change Request
status: draft
approvals: []
verification_commands: []
acceptance_criteria: []
user_interview: []
relevant_existing_code: []
relevant_documentation: []
decisions: []
dependency_analysis: []
tasks: []
waves: []
progress:
  step: not_started
  active_task_ids: []
  updated_at: example-timestamp
wave_flow_check:
  status: pending
  checked_by: ""
  checked_at: ""
  summary: ""
  findings: []
---

# Example Change Request

## Requested Delta

## Context From Original Plan

## Context From Actual Implementation

## User Interview

Record decisions gathered with the built-in `ask` tool and any questions still open.

## Context

### Relevant Existing Code

List repo paths, ownership notes, and changed interfaces that shape this request.

### Relevant Documentation

List project docs, external docs, standards, or API references used while planning.

## Decisions

## Required Work

Define concrete executable tasks before dependency analysis or wave creation. Each task must include objective, implementation notes, done criteria, task verification commands, dependencies, exclusive ownership, shared interfaces, and worker assignment. Worker assignment must be one of `worker-light`, `worker`, or `worker-heavy`.

## Dependency Analysis

Explain task dependencies, why each dependency exists, and which tasks can safely run in the same wave.

## Execution Waves

Group only already-defined tasks into waves. Each wave must include a goal, exit criteria, and review checkpoint.

## Wave Flow Check

Record the structured `wave_flow_check` status. It starts as `pending`, must be recorded by `wave-flow-checker`, and must be `passed` before approval.

## Progress

Use the persisted implementation progress cursor as the source of truth for pause/resume.

## Verification
